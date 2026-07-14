const fetch = require("node-fetch");

const API_BASE = process.env.TELEMETRY_API_BASE || process.env.SSP_API_BASE || "https://ssp.ektvam.net/api/ws";
const WSC_KEY = process.env.TELEMETRY_WSC_KEY || process.env.SSP_WSC_KEY;

const ERROR_CODES = {
  450: "Service configuration error. Contact KLK Ventures support.",
  451: "Service configuration error. Contact KLK Ventures support.",
  452: "Monitoring service is temporarily unavailable.",
  453: "Please wait a moment before refreshing this data.",
  454: "Fleet data was recently updated. Please wait before refreshing.",
  455: "This device is not in your fleet.",
  456: "Please select a valid date for history data.",
};

const lastUpdateCache = { data: null, fetchedAt: 0 };
const historyCooldown = new Map();
const historyCache = new Map();

const LAST_UPDATE_TTL_MS = 5 * 60 * 1000;
const HISTORY_COOLDOWN_MS = 60 * 1000;
const HISTORY_CACHE_TTL_MS = 30 * 60 * 1000;

async function callTelemetry(path, headers) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", headers });
  } catch (networkErr) {
    console.error(`[telemetry] network error calling ${path}:`, networkErr.message);
    const err = new Error("Could not reach monitoring service. Please try again shortly.");
    err.errCode = "NETWORK";
    throw err;
  }

  const rawText = await res.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    console.error(`[telemetry] non-JSON response from ${path} (HTTP ${res.status}):`, rawText.slice(0, 500));
    throw new Error("Monitoring service returned an unexpected response.");
  }

  if (json.status !== 1) {
    console.error(`[telemetry] error response from ${path} (HTTP ${res.status}):`, JSON.stringify(json));
    const desc = ERROR_CODES[json.errCode] || json.errDesc;
    const err = new Error(desc || "Monitoring request failed.");
    err.errCode = json.errCode;
    err.raw = json;
    throw err;
  }
  return json.data;
}

async function getLastUpdate({ deviceNo, force = false } = {}) {
  const now = Date.now();
  if (!force && !deviceNo && lastUpdateCache.data && now - lastUpdateCache.fetchedAt < LAST_UPDATE_TTL_MS) {
    return { data: lastUpdateCache.data, cached: true, ageMs: now - lastUpdateCache.fetchedAt };
  }
  const headers = { wscKey: WSC_KEY };
  if (deviceNo) headers.wscDev = deviceNo;
  const data = await callTelemetry("/last-update", headers);
  if (!deviceNo) {
    lastUpdateCache.data = data;
    lastUpdateCache.fetchedAt = now;
  }
  return { data, cached: false, ageMs: 0 };
}

async function getHistory({ deviceNo, date, force = false }) {
  if (!deviceNo || !date) throw new Error("deviceNo and date are required");

  const cacheKey = `${deviceNo}|${date}`;
  const cooldownKey = cacheKey;
  const now = Date.now();
  const cached = historyCache.get(cacheKey);

  if (!force && cached && now - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return { data: cached.data, cached: true, ageMs: now - cached.fetchedAt };
  }

  const last = historyCooldown.get(cooldownKey) || 0;
  if (!force && now - last < HISTORY_COOLDOWN_MS) {
    if (cached) {
      return { data: cached.data, cached: true, ageMs: now - cached.fetchedAt, stale: true };
    }
    const waitMs = HISTORY_COOLDOWN_MS - (now - last);
    const err = new Error(`Data will refresh in ${Math.ceil(waitMs / 1000)} seconds.`);
    err.errCode = 453;
    err.retryAfterMs = waitMs;
    throw err;
  }

  const data = await callTelemetry("/history-data", { wscKey: WSC_KEY, wscDev: deviceNo, wscDevDate: date });
  historyCooldown.set(cooldownKey, now);
  historyCache.set(cacheKey, { data, fetchedAt: now });
  return { data, cached: false, ageMs: 0 };
}

module.exports = { getLastUpdate, getHistory };
