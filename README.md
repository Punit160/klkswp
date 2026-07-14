# KLK Ventures Pvt Ltd — Solar Pump Monitoring Portal

Login-gated web app for monitoring KLK Ventures' fleet of solar pumps. The
frontend never talks to the monitoring service directly — it calls this
Node/Express backend over POST, and the backend holds the license key
server-side.

```
Browser (login + dashboard)
   │  POST /api/auth/login, /api/pumps/list, /api/pumps/detail, /api/pumps/history
   ▼
Express backend (this repo)
   │  POST  monitoring service /last-update
   │  POST  monitoring service /history-data
   ▼
KLK Ventures monitoring service
```

## Pages

The dashboard is a single-page app with client-side routing (`#/…`), five views:

- **Dashboard** (`#/dashboard`) — fleet-wide KPIs (total/running/stopped/faulted
  pumps, states covered, today's energy & water, lifetime energy), a running vs
  stopped vs fault donut, pumps-per-state bar chart, energy/water-by-state bar
  charts, fleet analytics, and the session fault log.
- **All Pumps** (`#/pumps`) — a sortable, searchable, filterable table of every
  pump (state, status, motor power, flow, today/lifetime energy & water,
  temperature, signal, last log time), with CSV export.
- **Map View** (`#/map`) — every geo-located pump on one clustered Leaflet map,
  colour-coded by status, with popups linking to device detail.
- **State-wise** (`#/states`) — one card per Indian state, with running/
  stopped/fault counts and today's energy & water totals; click a card to jump
  to the filtered table view for that state.
- **Device Detail** (`#/device/<DID>`) — live KPIs, geo pin, daily
  generation/output chart (dual-axis), and fault log for that device.

### How state-wise grouping works

Each pump reports only latitude/longitude, not a state name. `lib/geoStates.js`
classifies each coordinate into an Indian state/UT using bounding boxes (with
a nearest-centroid tiebreak where boxes overlap) — deliberately **not** a
third-party reverse-geocoding API, so pump GPS data never leaves your server
and there's no per-request network call or rate limit. This is accurate for
fleet-level reporting (tested against 25+ state capitals/major cities) but is
box-based, not polygon-based, so a pump very close to a tri-state corner can
occasionally be tagged with the neighbouring state. If you need survey-grade
accuracy, swap `stateFromLatLon()` for a real reverse-geocoding call (e.g.
Nominatim, Google Maps, or Mapbox) and cache the result per device, since
pump installations don't move.

## 1. Install

```bash
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
- `TELEMETRY_WSC_KEY` — your monitoring service license key (rotate it if it's ever been exposed publicly).
- `SESSION_SECRET` — replace with a random string (32+ characters):
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `COOKIE_SECURE` — set to `true` once you're serving over HTTPS.
- `NODE_ENV` — set to `production` when deploying (enforces strong secrets).

## 3. Create a login user

No sign-up page on purpose — accounts are provisioned by you. Passwords must
be at least 8 characters.

```bash
npm run seed -- admin "ChangeMe123!" "Punit Sukhija"
```

Run it again with different arguments to add more users (e.g. one per client, or one per field technician).

## 4. Run

```bash
npm start
```

Visit `http://localhost:3000`, log in, and the dashboard loads.

## What's under the hood

- **`server.js`** — Express app: session-cookie auth (httpOnly, so JS on the page can't read it) and three data routes, all POST:
  - `POST /api/pumps/list` → wraps `/last-update` (all devices), cached 5 minutes server-side so every logged-in user shares one vendor call instead of each hitting the 5-minute rate limit individually.
  - `POST /api/pumps/detail` → wraps `/last-update` for one device.
  - `POST /api/pumps/history` → wraps `/history-data`, enforced 1-minute-per-device-date cooldown server-side.
- **`lib/telemetryClient.js`** — the only place that holds the license key and talks to the monitoring service API.
- **`lib/geoStates.js`** — offline lat/lon → Indian state/UT classifier used to tag every device with `STATE` before it reaches the frontend.
- **`lib/userStore.js`** / **`data/users.json`** — bcrypt-hashed local user accounts. Swap this file for a real database (Postgres, MySQL) later without touching `server.js` — it only calls `findByUsername`, `createUser`, `verifyPassword`.
- **`public/`** — the multi-page dashboard UI: sidebar navigation, fleet overview with charts, sortable pump table, clustered map, state-wise cards, and per-device detail view (Leaflet + Chart.js).

## Production security checklist

- Set `NODE_ENV=production`, `COOKIE_SECURE=true`, and a strong `SESSION_SECRET`.
- Serve only over HTTPS (Nginx, Caddy, or a platform with TLS).
- Set `trust proxy` only when behind a reverse proxy.
- Rotate `TELEMETRY_WSC_KEY` if it was ever committed or shared publicly.

## Notes on scaling this up

- Right now users live in a JSON file and the last-update cache lives in server memory — fine for one server process. If you deploy multiple instances behind a load balancer, move the cache to Redis and the user store to a real DB.
- If you want per-client access (so a contractor only sees their own pumps, not everyone's), add a `devices: [DID, ...]` field to each user record in `userStore.js` and filter `lastUpdateList` by it in `/api/pumps/list` before sending the response.
- For production, put this behind HTTPS (e.g. Nginx or a platform like Render/Railway with TLS) and flip `COOKIE_SECURE=true`.
