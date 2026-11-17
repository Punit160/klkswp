require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { verifyPassword } = require("./lib/userStore");
const telemetry = require("./lib/telemetryClient");
const { stateFromLatLon } = require("./lib/geoStates");

function withState(device) {
  return { ...device, STATE: stateFromLatLon(device.LAT, device.LON) };
}

const app = express();
app.set("trust proxy", 1);

app.use(helmet({
  // Map tile servers need a referrer; helmet's default "no-referrer" can get tiles blocked.
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://cdnjs.cloudflare.com",
        "https://*.basemaps.cartocdn.com", // CARTO street map tiles
        "https://server.arcgisonline.com", // Esri satellite tiles
        "https://services.arcgisonline.com",
        "https://*.tile.openstreetmap.org",
      ],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: "32kb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const WEAK_SECRETS = new Set(["change-this-to-a-long-random-string", "dev-secret-change-me"]);

if (IS_PRODUCTION) {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || WEAK_SECRETS.has(SESSION_SECRET)) {
    console.error("FATAL: Set a strong SESSION_SECRET (32+ chars) in .env before production.");
    process.exit(1);
  }
  const telemetryKey = process.env.TELEMETRY_WSC_KEY || process.env.SSP_WSC_KEY;
  if (!telemetryKey) {
    console.error("FATAL: TELEMETRY_WSC_KEY is required in production.");
    process.exit(1);
  }
} else if (!SESSION_SECRET || WEAK_SECRETS.has(SESSION_SECRET)) {
  console.warn("WARNING: Set a strong SESSION_SECRET in .env before production.");
}

app.use(
  session({
    name: "klk.sid",
    secret: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

const loginAttempts = new Map();
const apiAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const API_WINDOW_MS = 60 * 1000;
const API_MAX_REQUESTS = 60;

function checkRateLimit(map, key, windowMs, maxAttempts) {
  const now = Date.now();
  const entry = map.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  map.set(key, entry);
  return entry.count <= maxAttempts;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ status: 0, errCode: 401, errDesc: "Not logged in" });
}

function requireAjax(req, res, next) {
  if (req.get("X-Requested-With") === "XMLHttpRequest") return next();
  return res.status(403).json({ status: 0, errCode: 403, errDesc: "Forbidden" });
}

function apiRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  if (!checkRateLimit(apiAttempts, ip, API_WINDOW_MS, API_MAX_REQUESTS)) {
    return res.status(429).json({ status: 0, errCode: 429, errDesc: "Too many requests. Please slow down." });
  }
  next();
}

function sanitizeDeviceNo(value) {
  const str = String(value || "").trim();
  if (!str || str.length > 64 || !/^[A-Za-z0-9._-]+$/.test(str)) return null;
  return str;
}

function sanitizeDate(value) {
  const str = String(value || "").trim();
  if (!/^\d{2}-\d{2}-\d{4}$/.test(str)) return null;
  const [dd, mm, yyyy] = str.split("-").map(Number);
  const d = new Date(yyyy, mm - 1, dd);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return str;
}

function apiError(res, err, fallbackStatus = 502) {
  const status = err.errCode === 453 ? 429 : err.errCode === 429 ? 429 : err.errCode ? 409 : fallbackStatus;
  const body = { status: 0, errCode: err.errCode || fallbackStatus, errDesc: err.message };
  if (err.retryAfterMs) body.retryAfterMs = err.retryAfterMs;
  else if (err.errCode === 453) body.retryAfterMs = 60000;
  res.status(status).json(body);
}

app.post("/api/auth/login", async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  if (!checkRateLimit(loginAttempts, ip, LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS)) {
    return res.status(429).json({ status: 0, errCode: 429, errDesc: "Too many login attempts. Try again in 15 minutes." });
  }

  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ status: 0, errCode: 400, errDesc: "username and password are required" });
  }
  if (username.length > 64 || password.length > 128) {
    return res.status(400).json({ status: 0, errCode: 400, errDesc: "Invalid credentials" });
  }
  try {
    const user = await verifyPassword(username, password);
    if (!user) {
      return res.status(401).json({ status: 0, errCode: 401, errDesc: "Invalid username or password" });
    }
    loginAttempts.delete(ip);
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        return res.status(500).json({ status: 0, errCode: 500, errDesc: "Login failed. Please try again." });
      }
      req.session.user = { id: user.id, username: user.username, displayName: user.displayName };
      req.session.save((saveErr) => {
        if (saveErr) {
          return res.status(500).json({ status: 0, errCode: 500, errDesc: "Login failed. Please try again." });
        }
        res.json({ status: 1, user: req.session.user });
      });
    });
  } catch (err) {
    res.status(500).json({ status: 0, errCode: 500, errDesc: "Login failed. Please try again." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("klk.sid");
    res.json({ status: 1 });
  });
});

app.post("/api/auth/me", (req, res) => {
  if (req.session && req.session.user) return res.json({ status: 1, user: req.session.user });
  res.status(401).json({ status: 0, errCode: 401, errDesc: "Not logged in" });
});

app.post("/api/pumps/list", requireAuth, requireAjax, apiRateLimit, async (req, res) => {
  try {
    const force = !!(req.body && req.body.force);
    const result = await telemetry.getLastUpdate({ force });
    const data = { ...result.data, lastUpdateList: (result.data.lastUpdateList || []).map(withState) };
    res.json({ status: 1, cached: result.cached, ageMs: result.ageMs, data });
  } catch (err) {
    apiError(res, err);
  }
});

app.post("/api/pumps/detail", requireAuth, requireAjax, apiRateLimit, async (req, res) => {
  const deviceNo = sanitizeDeviceNo(req.body && req.body.deviceNo);
  if (!deviceNo) return res.status(400).json({ status: 0, errCode: 400, errDesc: "deviceNo is required" });
  try {
    const result = await telemetry.getLastUpdate({ deviceNo });
    const data = { ...result.data, lastUpdateList: (result.data.lastUpdateList || []).map(withState) };
    res.json({ status: 1, data });
  } catch (err) {
    apiError(res, err);
  }
});

app.post("/api/pumps/history", requireAuth, requireAjax, apiRateLimit, async (req, res) => {
  const deviceNo = sanitizeDeviceNo(req.body && req.body.deviceNo);
  const date = sanitizeDate(req.body && req.body.date);
  if (!deviceNo || !date) {
    return res.status(400).json({ status: 0, errCode: 456, errDesc: "deviceNo and date (dd-MM-yyyy) are required" });
  }
  try {
    const result = await telemetry.getHistory({ deviceNo, date, force: !!(req.body && req.body.force) });
    res.json({ status: 1, cached: result.cached, stale: !!result.stale, ageMs: result.ageMs || 0, data: result.data });
  } catch (err) {
    apiError(res, err);
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KLK Ventures Pvt Ltd — Solar Pump Monitoring Portal listening on http://localhost:${PORT}`);
  const key = process.env.TELEMETRY_WSC_KEY || process.env.SSP_WSC_KEY;
  if (!key) {
    console.warn("WARNING: TELEMETRY_WSC_KEY is not set. Copy .env.example to .env and fill it in.");
  }
});
