const COMPANY = "KLK Ventures Pvt Ltd";
const HISTORY_STORAGE_KEY = "klk_history_cache";

const FIELD_META = {
  PV:{label:"PV Voltage", unit:"V", group:"solar"}, PI:{label:"PV Current", unit:"A", group:"solar"},
  MV:{label:"Motor Voltage", unit:"V", group:"motor"}, MI:{label:"Motor Current", unit:"A", group:"motor"},
  MP:{label:"Motor Power", unit:"kW", group:"motor"}, MF:{label:"Motor Frequency", unit:"Hz", group:"motor"},
  MR:{label:"Motor RPM", unit:"rpm", group:"motor"}, MRH:{label:"Motor Run Hrs", unit:"h", group:"motor"},
  TMRH:{label:"Today Run Hrs", unit:"h", group:"motor"},
  LPM:{label:"Flow Rate", unit:"L/min", group:"water"},
  TKWH:{label:"Today Energy", unit:"kWh", group:"solar"}, TLKWH:{label:"Total Energy", unit:"kWh", group:"solar"},
  TKL:{label:"Today Water", unit:"L", group:"water"}, TKLH:{label:"Total Water", unit:"kL", group:"water"},
  TMP:{label:"Temperature", unit:"°C", group:"env"}, SIG:{label:"Signal", unit:"%", group:"env"},
  INT:{label:"Interval", unit:"min", group:"env"}
};

const COLORS = {
  run:"#0B6B63", stop:"#B5BDB9", fault:"#B83A28", solar:"#D4922A", water:"#0B6B63", motor:"#5A6FCC", env:"#B5BDB9",
  palette:["#0B6B63","#D4922A","#5A6FCC","#B83A28","#3A8A7E","#B07A24","#7A88D4","#5A6B65","#095550","#D4A85A"]
};

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 }, padding: 14 } } }
};

let state = {
  devices: [],
  selected: null,
  faults: [],
  route: { name: "dashboard", params: {} },
  charts: {},
  maps: {},
  sortKey: "DID", sortDir: 1,
  historyCache: {},
  historyCooldowns: {}
};

let historyCooldownTimer = null;

const $ = (id) => document.getElementById(id);

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

function chartReady() {
  return typeof Chart !== "undefined";
}

function makeChart(canvas, config) {
  if (!chartReady()) {
    banner("Chart library failed to load. Please refresh the page.", "err");
    return null;
  }
  if (!canvas) return null;
  return new Chart(canvas, config);
}

function loadHistoryCacheFromStorage() {
  try {
    const raw = sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    Object.keys(parsed).forEach((key) => {
      if (parsed[key] && Array.isArray(parsed[key].list)) {
        state.historyCache[key] = parsed[key];
      }
    });
  } catch (e) { /* ignore corrupt cache */ }
}

function saveHistoryCacheToStorage() {
  try {
    sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.historyCache));
  } catch (e) { /* storage full or unavailable */ }
}

loadHistoryCacheFromStorage();

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    credentials: "include",
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (json.status !== 1) {
    const err = new Error(json.errDesc || "Request failed");
    err.status = res.status;
    err.errCode = json.errCode;
    if (json.retryAfterMs) err.retryAfterMs = json.retryAfterMs;
    throw err;
  }
  return json;
}

function statusOf(d) {
  const hasFault = d.FAULT && d.FAULT.toLowerCase() !== "no fault";
  const running = Number(d.RUN) === 1;
  if (hasFault) return "fault";
  return running ? "run" : "stop";
}
function statusLabel(s) { return s === "fault" ? "Fault" : s === "run" ? "Running" : "Stopped"; }

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginErr").textContent = "";
  try {
    const json = await api("/api/auth/login", { username: $("username").value.trim(), password: $("password").value });
    enterApp(json.user);
  } catch (err) {
    $("loginErr").textContent = err.errCode === 401 ? "Invalid username or password." : err.message;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout");
  location.reload();
});

const year = new Date().getFullYear();
$("loginYear").textContent = year;
$("sideYear").textContent = year;
const footEl = $("footYear");
if (footEl) footEl.textContent = year;

function enterApp(user) {
  $("loginShell").style.display = "none";
  $("app").style.display = "flex";
  $("whoName").textContent = user.displayName || user.username;
  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("resize", onResize);
  if (!location.hash) location.hash = "#/dashboard";
  fetchDeviceList().then(renderRoute);
  setInterval(() => fetchDeviceList(false, true), 5 * 60 * 1000);
}

function toggleSidebar(open) {
  $("sidebar").classList.toggle("open", open);
  $("sidebarOverlay").classList.toggle("visible", open);
}

$("hamburgerBtn").addEventListener("click", () => toggleSidebar(!$("sidebar").classList.contains("open")));
$("sidebarOverlay").addEventListener("click", () => toggleSidebar(false));

function onResize() {
  Object.values(state.maps).forEach(m => { try { m.invalidateSize(); } catch (e) {} });
}

(async function init() {
  try {
    const json = await api("/api/auth/me");
    enterApp(json.user);
  } catch (e) { /* not logged in */ }
})();

function banner(msg, type = "info") {
  $("bannerHost").innerHTML = `<div class="banner ${type}">${type === "err" ? "&#9888;" : "&#8505;"} ${esc(msg)}</div>`;
}
function clearBanner() { $("bannerHost").innerHTML = ""; }

async function fetchDeviceList(force = false, updateView = false) {
  clearBanner();
  try {
    const json = await api("/api/pumps/list", { force });
    state.devices = json.data.lastUpdateList || [];
    $("syncTag").textContent = (json.cached ? "cached " : "synced ") + new Date().toLocaleTimeString();
    state.devices.forEach(d => { if (statusOf(d) === "fault") logFault(d); });
    renderSidebarDeviceList();
    if (updateView) refreshCurrentView();
  } catch (err) {
    if (err.status === 401) { location.reload(); return; }
    banner(err.message, "err");
    $("deviceList").innerHTML = `<div class="empty-rail">Could not load devices.<br>${esc(err.message)}</div>`;
  }
}
$("refreshBtn").addEventListener("click", () => fetchDeviceList(true, true));

function logFault(d) {
  const key = `${d.DID}-${d.LGT}-${d.FAULT}`;
  if (state.faults.find(f => f.key === key)) return;
  state.faults.unshift({ key, time: d.LGT, did: d.DID, state: d.STATE, fault: d.FAULT });
  state.faults = state.faults.slice(0, 50);
}

function renderSidebarDeviceList() {
  if (!state.devices.length) {
    $("deviceList").innerHTML = `<div class="empty-rail">No devices returned for this account.</div>`;
    return;
  }
  const sorted = [...state.devices].sort((a, b) => String(a.DID).localeCompare(String(b.DID)));
  $("deviceList").innerHTML = sorted.map(d => {
    const s = statusOf(d);
    const active = state.selected === d.DID ? "active" : "";
    return `<a href="#/device/${encodeURIComponent(d.DID)}" class="device-row ${active}" data-did="${esc(d.DID)}">
      <div class="did">${esc(d.DID)}</div>
      <div class="meta"><span class="dot ${s}"></span>${statusLabel(s)} &middot; ${esc(d.STATE || "Unknown")}</div>
    </a>`;
  }).join("");
}

function parseHash() {
  const raw = (location.hash || "#/dashboard").slice(1);
  const [pathPart, queryPart] = raw.split("?");
  const segs = pathPart.split("/").filter(Boolean);
  const params = {};
  if (queryPart) new URLSearchParams(queryPart).forEach((v, k) => { params[k] = v; });
  if (segs[0] === "device" && segs[1]) return { name: "device", params: { did: decodeURIComponent(segs[1]) } };
  if (["dashboard", "pumps", "map", "states"].includes(segs[0])) return { name: segs[0], params };
  return { name: "dashboard", params: {} };
}

const TITLES = { dashboard: "Dashboard", pumps: "All Pumps", map: "Map View", states: "State-wise", device: "Device Detail" };

function renderRoute() {
  const route = parseHash();
  state.route = route;
  $("topTitle").textContent = route.name === "device" ? `Device ${route.params.did}` : TITLES[route.name];
  document.querySelectorAll(".nav-link").forEach(a => a.classList.toggle("active", a.dataset.route === route.name));
  toggleSidebar(false);

  const pageRoot = $("pageRoot");
  if (!state.devices.length) {
    pageRoot.innerHTML = `<div class="panel"><div class="empty-rail">Loading fleet data&hellip;</div></div>`;
    return;
  }

  refreshCurrentView();
}

function refreshCurrentView() {
  if (!$("app") || $("app").style.display === "none") return;
  if (!state.devices.length) return;

  const route = state.route;
  destroyMaps();
  destroyCharts();

  if (route.name === "dashboard") return renderDashboardPage();
  if (route.name === "pumps") return renderPumpsPage(route.params);
  if (route.name === "map") return renderMapPage();
  if (route.name === "states") return renderStatesPage();
  if (route.name === "device") return renderDevicePage(route.params.did);
}

function destroyCharts() {
  Object.values(state.charts).forEach(c => { try { c.destroy(); } catch (e) {} });
  state.charts = {};
}

function destroyMaps() {
  Object.values(state.maps).forEach(m => { try { m.remove(); } catch (e) {} });
  state.maps = {};
}

function mountTemplate(id) {
  const tpl = $(id);
  const node = tpl.content.cloneNode(true);
  $("pageRoot").innerHTML = "";
  $("pageRoot").appendChild(node);
}

function sum(devices, key) {
  return devices.reduce((a, d) => a + (Number(d[key]) || 0), 0);
}

function renderDashboardPage() {
  mountTemplate("tpl-dashboard");
  const devices = state.devices;
  const running = devices.filter(d => statusOf(d) === "run").length;
  const stopped = devices.filter(d => statusOf(d) === "stop").length;
  const fault = devices.filter(d => statusOf(d) === "fault").length;
  const totalTKWH = sum(devices, "TKWH");
  const totalTKL = sum(devices, "TKL");
  const totalTLKWH = sum(devices, "TLKWH");
  const totalTMRH = sum(devices, "TMRH");
  const statesCovered = new Set(devices.map(d => d.STATE || "Unknown")).size;
  const avgPower = running ? (sum(devices.filter(d => statusOf(d) === "run"), "MP") / running).toFixed(2) : "0";
  const uptimePct = devices.length ? ((running / devices.length) * 100).toFixed(1) : "0";
  const waterPerKwh = totalTKWH > 0 ? (totalTKL / totalTKWH).toFixed(1) : "—";

  $("dashKpis").innerHTML = [
    { label: "Total Pumps", value: devices.length, group: "motor" },
    { label: "Running", value: running, group: "water" },
    { label: "Stopped", value: stopped, group: "env" },
    { label: "Faulted", value: fault, group: "alert" },
    { label: "States Covered", value: statesCovered, group: "solar" },
    { label: "Today's Energy", value: totalTKWH.toFixed(1), unit: "kWh", group: "solar" },
    { label: "Today's Water", value: totalTKL.toFixed(0), unit: "L", group: "water" },
    { label: "Lifetime Energy", value: totalTLKWH.toFixed(0), unit: "kWh", group: "motor" },
  ].map(k => `<div class="kpi ${k.group}"><div class="label">${k.label}</div><div class="value">${k.value}${k.unit ? `<span class="unit">${k.unit}</span>` : ""}</div></div>`).join("");

  $("analyticsRow").innerHTML = [
    { label: "Fleet Uptime", value: `${uptimePct}%`, sub: `${running} of ${devices.length} pumps running` },
    { label: "Avg Motor Power", value: `${avgPower} kW`, sub: "across running pumps" },
    { label: "Water per kWh", value: waterPerKwh === "—" ? "—" : `${waterPerKwh} L`, sub: "today's efficiency ratio" },
    { label: "Total Run Hours", value: `${totalTMRH.toFixed(1)} h`, sub: "today across fleet" },
  ].map(a => `<div class="analytics-card"><div class="ac-label">${a.label}</div><div class="ac-value">${a.value}</div><div class="ac-sub">${a.sub}</div></div>`).join("");

  const chartOpts = { ...CHART_DEFAULTS };

  state.charts.statusDonut = makeChart($("statusDonut"), {
    type: "doughnut",
    data: { labels: ["Running", "Stopped", "Fault"], datasets: [{ data: [running, stopped, fault], backgroundColor: [COLORS.run, COLORS.stop, COLORS.fault], borderWidth: 0 }] },
    options: { ...chartOpts, plugins: { ...chartOpts.plugins, legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } }, cutout: "62%" }
  });

  const byState = groupByState(devices);
  const stateNames = Object.keys(byState).sort((a, b) => byState[b].length - byState[a].length);
  const barOpts = { ...chartOpts, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: "#F0F3F1" } }, x: { grid: { display: false } } } };

  state.charts.stateBar = makeChart($("stateBar"), {
    type: "bar",
    data: { labels: stateNames, datasets: [{ label: "Pumps", data: stateNames.map(s => byState[s].length), backgroundColor: COLORS.water, borderRadius: 6 }] },
    options: barOpts
  });

  state.charts.energyByState = makeChart($("energyByState"), {
    type: "bar",
    data: { labels: stateNames, datasets: [{ label: "kWh today", data: stateNames.map(s => byState[s].reduce((a, d) => a + (Number(d.TKWH) || 0), 0)), backgroundColor: COLORS.solar, borderRadius: 6 }] },
    options: barOpts
  });

  state.charts.waterByState = makeChart($("waterByState"), {
    type: "bar",
    data: { labels: stateNames, datasets: [{ label: "Litres today", data: stateNames.map(s => byState[s].reduce((a, d) => a + (Number(d.TKL) || 0), 0)), backgroundColor: COLORS.motor, borderRadius: 6 }] },
    options: barOpts
  });

  renderFaultTable("faultBodyDash", "faultTagDash", state.faults);
}

function groupByState(devices) {
  const map = {};
  devices.forEach(d => {
    const s = d.STATE || "Unknown";
    (map[s] = map[s] || []).push(d);
  });
  return map;
}

function renderFaultTable(bodyId, tagId, faults, compact = false) {
  const cols = compact ? 3 : 4;
  $(tagId).textContent = `${faults.length} entr${faults.length === 1 ? "y" : "ies"}`;
  $(bodyId).innerHTML = faults.length
    ? faults.map(f => compact
      ? `<tr><td>${esc(f.time || "—")}</td><td>${esc(f.did)}</td><td>${esc(f.fault)}</td></tr>`
      : `<tr><td>${esc(f.time || "—")}</td><td>${esc(f.did)}</td><td>${esc(f.state || "—")}</td><td>${esc(f.fault)}</td></tr>`
    ).join("")
    : `<tr><td colspan="${cols}" style="color:var(--ink-soft);">No faults recorded this session.</td></tr>`;
}

function renderPumpsPage(params) {
  mountTemplate("tpl-pumps");
  const stateSel = $("stateFilter");
  const allStates = [...new Set(state.devices.map(d => d.STATE || "Unknown"))].sort();
  stateSel.innerHTML = `<option value="">All states</option>` + allStates.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (params.state && allStates.includes(params.state)) stateSel.value = params.state;

  const renderTable = () => {
    const q = $("pumpSearch").value.trim().toLowerCase();
    const st = $("stateFilter").value;
    const sf = $("statusFilter").value;
    let rows = state.devices.filter(d => {
      if (st && (d.STATE || "Unknown") !== st) return false;
      if (sf && statusOf(d) !== sf) return false;
      if (q && !(String(d.DID).toLowerCase().includes(q) || String(d.IMEI || "").toLowerCase().includes(q))) return false;
      return true;
    });
    rows.sort((a, b) => {
      const k = state.sortKey;
      let av = k === "STATUS" ? statusOf(a) : a[k], bv = k === "STATUS" ? statusOf(b) : b[k];
      const an = Number(av), bn = Number(bv);
      const cmp = (!isNaN(an) && !isNaN(bn) && av !== "" && bv !== "") ? an - bn : String(av || "").localeCompare(String(bv || ""));
      return cmp * state.sortDir;
    });
    $("pumpCountTag").textContent = `${rows.length} of ${state.devices.length} pumps`;
    $("pumpsTableBody").innerHTML = rows.map(d => {
      const s = statusOf(d);
      return `<tr class="clickable-row" data-did="${esc(d.DID)}">
        <td class="mono">${esc(d.DID)}</td>
        <td>${esc(d.STATE || "Unknown")}</td>
        <td><span class="status-chip ${s}">${statusLabel(s)}</span></td>
        <td>${esc(d.MP ?? "—")}</td>
        <td>${esc(d.LPM ?? "—")}</td>
        <td>${esc(d.TKWH ?? "—")}</td>
        <td>${esc(d.TKL ?? "—")}</td>
        <td>${esc(d.TLKWH ?? "—")}</td>
        <td>${esc(d.TMP ?? "—")}</td>
        <td>${esc(d.SIG ?? "—")}</td>
        <td class="mono">${esc(d.LGT || "—")}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="11" style="color:var(--ink-soft);">No pumps match these filters.</td></tr>`;
    document.querySelectorAll(".clickable-row").forEach(row => {
      row.addEventListener("click", () => { location.hash = `#/device/${encodeURIComponent(row.dataset.did)}`; });
    });
  };

  $("pumpSearch").addEventListener("input", renderTable);
  $("stateFilter").addEventListener("change", renderTable);
  $("statusFilter").addEventListener("change", renderTable);
  document.querySelectorAll("#pumpsTable th[data-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      state.sortDir = (state.sortKey === key) ? -state.sortDir : 1;
      state.sortKey = key;
      renderTable();
    });
  });
  $("exportCsvBtn").addEventListener("click", () => exportCsv());
  renderTable();
}

function exportCsv() {
  const cols = ["DID", "STATE", "IMEI", "RUN", "FAULT", "MP", "LPM", "TKWH", "TLKWH", "TKL", "TKLH", "TMP", "SIG", "LAT", "LON", "LGT"];
  const lines = [cols.join(",")];
  state.devices.forEach(d => lines.push(cols.map(c => `"${(d[c] ?? "").toString().replace(/"/g, '""')}"`).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `klk-ventures-pumps-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderMapPage() {
  mountTemplate("tpl-map");
  const withFix = state.devices.filter(d => Number(d.LAT) && Number(d.LON));
  $("mapCountTag").textContent = `${withFix.length} of ${state.devices.length} with GPS fix`;

  const map = L.map("fleetMap");
  const cluster = L.markerClusterGroup();
  const bounds = [];
  withFix.forEach(d => {
    const lat = Number(d.LAT), lon = Number(d.LON);
    const s = statusOf(d);
    const marker = L.circleMarker([lat, lon], { radius: 8, color: "#fff", weight: 2, fillColor: COLORS[s], fillOpacity: 1 });
    marker.bindPopup(`<b>${esc(d.DID)}</b><br>${esc(d.STATE || "Unknown")}<br>${statusLabel(s)}${s === "fault" ? ` — ${esc(d.FAULT)}` : ""}<br>
      <a href="#/device/${encodeURIComponent(d.DID)}">View details &rarr;</a>`);
    cluster.addLayer(marker);
    bounds.push([lat, lon]);
  });
  map.addLayer(cluster);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
  else map.setView([22.9734, 78.6569], 5);
  state.maps.fleetMap = map;
  setTimeout(() => map.invalidateSize(), 100);
}

function renderStatesPage() {
  mountTemplate("tpl-states");
  const byState = groupByState(state.devices);
  const names = Object.keys(byState).sort((a, b) => byState[b].length - byState[a].length);
  $("stateCards").innerHTML = names.map((s, i) => {
    const list = byState[s];
    const running = list.filter(d => statusOf(d) === "run").length;
    const stopped = list.filter(d => statusOf(d) === "stop").length;
    const fault = list.filter(d => statusOf(d) === "fault").length;
    const energy = list.reduce((a, d) => a + (Number(d.TKWH) || 0), 0).toFixed(1);
    const water = list.reduce((a, d) => a + (Number(d.TKL) || 0), 0).toFixed(0);
    const color = COLORS.palette[i % COLORS.palette.length];
    return `<a class="state-card" href="#/pumps?state=${encodeURIComponent(s)}" style="--accent:${color}">
      <div class="state-card-head">
        <h4>${esc(s)}</h4>
        <span class="state-count">${list.length} pump${list.length === 1 ? "" : "s"}</span>
      </div>
      <div class="state-card-row"><span class="dot run"></span>Running <b>${running}</b></div>
      <div class="state-card-row"><span class="dot stop"></span>Stopped <b>${stopped}</b></div>
      <div class="state-card-row"><span class="dot fault"></span>Fault <b>${fault}</b></div>
      <div class="state-card-foot"><span>${energy} kWh today</span><span>${water} L today</span></div>
    </a>`;
  }).join("") || `<div class="panel"><div class="empty-rail">No geo-located pumps yet.</div></div>`;
}

function displayedDeviceId() {
  const title = $("devTitle")?.textContent || "";
  const m = title.match(/^Device\s+(.+)$/);
  return m ? m[1].trim() : "";
}

function renderDevicePage(did) {
  const d = state.devices.find(x => String(x.DID) === String(did));
  const sameDeviceAlreadyShown = $("historyChart") && displayedDeviceId() === String(did);

  if (sameDeviceAlreadyShown && d) {
    $("devTitle").textContent = `Device ${d.DID}`;
    $("devSub").textContent = `${d.STATE || "Unknown state"} · IMEI ${d.IMEI || "—"} · Last log ${d.LGT || "—"}`;
    const s = statusOf(d);
    const pill = $("statusPill");
    pill.className = "status-pill " + s;
    pill.textContent = s === "fault" ? `FAULT: ${d.FAULT}` : statusLabel(s).toUpperCase();
    renderKPIs(d);
    state.selected = did;
    renderSidebarDeviceList();
    return;
  }

  mountTemplate("tpl-device");
  state.selected = did;
  renderSidebarDeviceList();

  if (!d) {
    $("pageRoot").innerHTML = `<div class="panel"><div class="empty-rail">Device "${esc(did)}" was not found in this account's fleet.</div></div>`;
    return;
  }

  $("devTitle").textContent = `Device ${d.DID}`;
  $("devSub").textContent = `${d.STATE || "Unknown state"} · IMEI ${d.IMEI || "—"} · Last log ${d.LGT || "—"}`;

  const s = statusOf(d);
  const pill = $("statusPill");
  pill.className = "status-pill " + s;
  pill.textContent = s === "fault" ? `FAULT: ${d.FAULT}` : statusLabel(s).toUpperCase();

  renderKPIs(d);
  renderSingleMap(d.LAT, d.LON);
  renderFaultTable("faultBody", "faultTag", state.faults.filter(f => String(f.did) === String(did)), true);

  const defaultDate = isoDateFromLgt(d.LGT) || localTodayIso();
  $("historyDate").value = defaultDate;
  $("loadHistoryBtn").addEventListener("click", () => loadHistory(did, false));
  $("historyDate").addEventListener("change", () => loadHistory(did, false));

  loadHistory(did, false);
}

function renderKPIs(d) {
  const order = ["PV", "PI", "MV", "MI", "MP", "MF", "MR", "MRH", "TMRH", "LPM", "TKWH", "TLKWH", "TKL", "TKLH", "TMP", "SIG"];
  $("kpiGrid").innerHTML = order.filter(k => d[k] !== undefined).map(k => {
    const meta = FIELD_META[k];
    return `<div class="kpi ${meta.group}">
      <div class="label">${meta.label}</div>
      <div class="value">${esc(d[k])}<span class="unit">${meta.unit}</span></div>
    </div>`;
  }).join("");
}

function renderSingleMap(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  $("geoTag").textContent = (lat && lon) ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : "no fix";
  const map = L.map("map");
  state.maps.deviceMap = map;
  if (lat && lon) {
    map.setView([lat, lon], 14);
    L.marker([lat, lon]).addTo(map);
  } else {
    map.setView([22.9734, 78.6569], 5);
  }
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
  setTimeout(() => map.invalidateSize(), 100);
}

function toApiDate(isoDate) {
  const [y, m, dd] = isoDate.split("-");
  return `${dd}-${m}-${y}`;
}

function localTodayIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function isoDateFromLgt(lgt) {
  if (!lgt) return null;
  const part = String(lgt).split(" ")[0];
  const m = part.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function historyEls() {
  return {
    empty: $("historyEmpty"),
    status: $("historyStatus"),
    btn: $("loadHistoryBtn"),
    date: $("historyDate"),
    tag: $("chartTag"),
    summary: $("historySummary")
  };
}

function setHistoryLoading(on) {
  const { empty, status, btn } = historyEls();
  if (!empty || !status) return;
  if (on) {
    empty.classList.remove("hidden");
    empty.textContent = "Loading generation data\u2026";
    status.innerHTML = `<span class="loader"></span> loading&hellip;`;
    if (btn) btn.disabled = true;
  } else if (btn) {
    btn.disabled = false;
  }
}

function setHistoryMessage(msg) {
  const { empty, status, btn } = historyEls();
  if (empty) {
    empty.classList.remove("hidden");
    empty.textContent = msg;
  }
  if (status) status.textContent = msg;
  if (btn) btn.disabled = false;
}

function getCachedHistory(cacheKey) {
  const entry = state.historyCache[cacheKey];
  if (!entry || !Array.isArray(entry.list)) return null;
  return entry;
}

function getHistoryCooldownRemaining(cacheKey) {
  const end = state.historyCooldowns[cacheKey];
  if (!end) return 0;
  const remaining = end - Date.now();
  if (remaining <= 0) {
    delete state.historyCooldowns[cacheKey];
    return 0;
  }
  return remaining;
}

function setHistoryCooldown(cacheKey, retryAfterMs) {
  if (!retryAfterMs) return;
  state.historyCooldowns[cacheKey] = Date.now() + retryAfterMs;
  startHistoryCooldownTimer();
}

function startHistoryCooldownTimer() {
  if (historyCooldownTimer) return;
  historyCooldownTimer = setInterval(() => {
    updateHistoryCooldownUI();
    const hasActive = Object.keys(state.historyCooldowns).some(k => getHistoryCooldownRemaining(k) > 0);
    if (!hasActive) {
      clearInterval(historyCooldownTimer);
      historyCooldownTimer = null;
    }
  }, 1000);
}

function updateHistoryCooldownUI() {
  const btn = $("loadHistoryBtn");
  const status = $("historyStatus");
  if (!btn || !status) return;

  const did = state.route.params && state.route.params.did;
  const iso = $("historyDate") && $("historyDate").value;
  if (!did || !iso) return;

  const cacheKey = `${did}|${toApiDate(iso)}`;
  const remaining = getHistoryCooldownRemaining(cacheKey);
  if (remaining > 0) {
    const secs = Math.ceil(remaining / 1000);
    btn.disabled = true;
    status.textContent = `Refresh available in ${secs}s`;
  } else {
    btn.disabled = false;
    if (status.textContent.match(/Refresh available in/)) {
      status.textContent = "";
    }
  }
}

function isCurrentDevicePage(did) {
  return displayedDeviceId() === String(did);
}

async function loadHistory(did, force = false) {
  const { date: dateEl } = historyEls();
  const iso = dateEl && dateEl.value;
  if (!iso) { banner("Choose a date to load history for.", "err"); return; }

  const cacheKey = `${did}|${toApiDate(iso)}`;
  const cooldownRemaining = getHistoryCooldownRemaining(cacheKey);
  if (!force && cooldownRemaining > 0) {
    if (!isCurrentDevicePage(did)) return;
    const cached = getCachedHistory(cacheKey);
    if (cached) {
      showHistoryData(cached.list, iso, true);
      banner(`Showing cached data. Refresh available in ${Math.ceil(cooldownRemaining / 1000)}s.`, "info");
    } else {
      setHistoryMessage(`Data will refresh in ${Math.ceil(cooldownRemaining / 1000)} seconds.`);
      banner(`History data will refresh in ${Math.ceil(cooldownRemaining / 1000)} seconds.`, "info");
    }
    updateHistoryCooldownUI();
    return;
  }

  const cached = getCachedHistory(cacheKey);
  if (!force && cached) {
    if (!isCurrentDevicePage(did)) return;
    showHistoryData(cached.list, iso, true);
    return;
  }

  setHistoryLoading(true);

  try {
    const json = await api("/api/pumps/history", { deviceNo: did, date: toApiDate(iso), force });
    if (!isCurrentDevicePage(did)) return;
    const list = (json.data.historyList || []).slice().sort((a, b) => (a.LGT || "").localeCompare(b.LGT || ""));
    state.historyCache[cacheKey] = { list, cached: json.cached, fetchedAt: Date.now() };
    saveHistoryCacheToStorage();
    showHistoryData(list, iso, json.cached, json.stale);
  } catch (err) {
    if (!isCurrentDevicePage(did)) return;
    if (err.retryAfterMs) {
      setHistoryCooldown(cacheKey, err.retryAfterMs);
    } else if (err.errCode === 453) {
      setHistoryCooldown(cacheKey, 60000);
    }
    const cachedEntry = getCachedHistory(cacheKey);
    if (cachedEntry) {
      showHistoryData(cachedEntry.list, iso, true);
      banner("Showing cached data. " + err.message, "info");
    } else {
      setHistoryMessage(err.message || "Could not load history data.");
      if (err.errCode === 453 || err.retryAfterMs) {
        banner(err.message, "info");
      } else {
        banner(err.message, "err");
      }
    }
  } finally {
    if (isCurrentDevicePage(did)) updateHistoryCooldownUI();
  }
}

function showHistoryData(list, iso, cached, stale) {
  list = Array.isArray(list) ? list : [];
  const { empty, status, tag, summary, btn } = historyEls();
  if (!empty || !status || !tag) return;

  if (btn) btn.disabled = false;
  const tagText = stale ? "cached (refresh pending)" : cached ? "cached" : iso;
  tag.textContent = tagText;
  const statusNote = stale ? " (cached)" : cached ? " (cached)" : "";
  status.textContent = `${list.length} record(s) for ${iso}${statusNote}`;
  updateHistoryCooldownUI();

  if (!list.length) {
    empty.classList.remove("hidden");
    empty.textContent = "No history records for this date.";
    if (state.charts.historyChart) { state.charts.historyChart.destroy(); delete state.charts.historyChart; }
    if (summary) summary.innerHTML = "";
    return;
  }

  empty.classList.add("hidden");
  renderHistoryChart(list);
  renderHistorySummary(list);
}

function renderHistoryChart(list) {
  const labels = list.map(r => (r.LGT || "").split(" ")[1] || r.LGT);
  const ds = (key, color, yAxisID) => ({
    label: FIELD_META[key].label + ` (${FIELD_META[key].unit})`,
    data: list.map(r => Number(r[key]) || 0),
    borderColor: color, backgroundColor: color + "22",
    tension: 0.3, pointRadius: 2, borderWidth: 2, fill: false,
    yAxisID
  });

  if (state.charts.historyChart) state.charts.historyChart.destroy();
  state.charts.historyChart = makeChart($("historyChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        ds("TKWH", "#D4922A", "y"),
        ds("TKL", "#0B6B63", "y1"),
        ds("LPM", "#5A6FCC", "y1")
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: {
        y: {
          type: "linear", position: "left", beginAtZero: true,
          title: { display: true, text: "kWh" },
          grid: { color: "#F0F3F1" }
        },
        y1: {
          type: "linear", position: "right", beginAtZero: true,
          title: { display: true, text: "L / L/min" },
          grid: { drawOnChartArea: false }
        },
        x: { grid: { display: false } }
      }
    }
  });
}

function renderHistorySummary(list) {
  const peak = (key) => {
    const vals = list.map(r => Number(r[key]) || 0);
    return vals.length ? Math.max(...vals).toFixed(key === "TKWH" ? 2 : 0) : "—";
  };
  const last = list[list.length - 1];
  const avgLpm = list.length ? (list.reduce((a, r) => a + (Number(r.LPM) || 0), 0) / list.length).toFixed(1) : "—";

  $("historySummary").innerHTML = [
    { label: "Peak Energy", value: `${peak("TKWH")} kWh` },
    { label: "Peak Water", value: `${peak("TKL")} L` },
    { label: "Peak Flow", value: `${peak("LPM")} L/min` },
    { label: "Avg Flow", value: `${avgLpm} L/min` },
    { label: "Last Reading", value: last ? (last.LGT || "").split(" ")[1] || "—" : "—" },
    { label: "Data Points", value: String(list.length) },
  ].map(h => `<div class="hs-item"><div class="hs-label">${h.label}</div><div class="hs-value">${h.value}</div></div>`).join("");
}
