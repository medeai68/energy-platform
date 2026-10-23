/* ============================================================
   Energy AI Platform — dashboard logic
   Polls /api/state once per second and renders everything floating
   above the perspective solar scene (scene.js):
     - live title, HUD, KPIs, donut, production chart, sparkline
     - energy mix, repair-matching card, alerts feed
     - equipment list and device/panel drawer with fault injection
       and AI diagnosis
   ============================================================ */

"use strict";

const $ = (sel) => document.querySelector(sel);
// cssVar() is defined in scene.js (loaded first) and shared here.

const STATUS = {
  ok:       { color: "--good",     label: "OK",       glyph: "✓" },
  warning:  { color: "--warning",  label: "WARNING",  glyph: "▲" },
  serious:  { color: "--serious",  label: "SERIOUS",  glyph: "●" },
  critical: { color: "--critical", label: "CRITICAL", glyph: "✕" },
};

const S = {
  snap: null,
  deviceId: null,
  device: null,
  aiResult: null,
  intel: null,           // /api/intelligence payload for the floating cards
  range: 0,              // sim-minutes window for the main chart (0 = all)
  tables: new Set(),     // chart keys currently in table mode
  hover: null,           // twin hover device id
  view: { mode: null, buildingId: null, floorId: null, roomId: null },
  levelCard: null,       // { kind: "building"|"floor"|"room", id } open in the drawer
  levelEls: null,        // patched-in-place elements of the level card
  selection: null,       // { id, kind } currently selected in the 3D scene
};

const fmtTime = (t) => {
  const day = Math.floor(t / 1440) + 1;
  const m = t % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `D${day} ${hh}:${mm}`;
};
const fmtTicks = (t) => {
  const m = t % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/* ---------------- polling ---------------- */

/* One scheduler owns every periodic request.  Polling pauses in a hidden
   tab, backs off while the server is down, and keeps the last good
   snapshot on screen (the status banner explains why it is not updating). */
const POLL = {
  started: false,
  timer: 0,
  deviceTimer: 0,
  intelTimer: 0,
  inFlight: false,
  failDelay: 0,
  connDismissed: false,   // the user closed the connection notice this outage
};

function pollDelay() {
  return Math.min(16000, 1000 + POLL.failDelay);
}

function renderConnection() {
  const el = document.getElementById("conn-banner");
  if (!el) return;
  const offline = typeof NET !== "undefined" && NET.online === false;
  const text = document.getElementById("conn-banner-text");
  if (!offline) {
    POLL.connDismissed = false;   // reconnects re-arm the notice
    el.classList.add("hidden");
    return;
  }
  el.classList.toggle("hidden", !!POLL.connDismissed);
  if (text) {
    const seen = NET.lastOk ? Math.max(0, Math.round((Date.now() - NET.lastOk) / 1000)) : null;
    text.textContent = `⚠ Connection lost — showing the last good snapshot`
      + (seen != null ? ` from ${seen}s ago` : "")
      + ` · ${NET.lastError || "server unreachable"}. Retrying automatically…`;
  }
}

function dismissConnectionNotice(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  POLL.connDismissed = true;
  const el = document.getElementById("conn-banner");
  if (el) el.classList.add("hidden");
}

window.addEventListener("net-state", renderConnection);

async function poll() {
  if (POLL.inFlight) return;
  POLL.inFlight = true;
  let snap;
  try {
    snap = await netJSON("/api/state", { timeout: 8000 });
    POLL.failDelay = 0;
  } catch (e) {
    // keep the previous snapshot; back off so an outage is not hammered
    POLL.failDelay = POLL.failDelay ? Math.min(16000, POLL.failDelay * 2) : 2000;
    renderConnection();
    return;
  } finally {
    POLL.inFlight = false;
  }
  S.snap = snap;
  renderConnection();
  renderClock();
  renderOverlay();
  renderSceneTitle();
  renderKpis();
  renderDonut();
  renderTrend();
  renderMix();
  renderAlerts();
  if (typeof updateNavigator === "function") updateNavigator();
  renderMainChart();
  if (!S.view.mode) {
    const shellSet = (typeof shellResolveInitialRoute === "function")
      ? shellResolveInitialRoute() : false;
    const hashSet = shellSet
      || (location.hash && location.hash.length > 1 && applyHashView());
    // Non-twin shell routes still need a valid scene state behind them.
    if (!hashSet || !S.view.mode) setView("campus");
  }
  // the data-availability legend needs one snapshot to describe the sources
  if (!S._vizLegendReady) {
    S._vizLegendReady = true;
    if (typeof renderVizLegend === "function") renderVizLegend();
  }
  if (S.deviceId) refreshDevice();
  else if (S.levelCard) updateLevelCard();
  if (typeof playbackOnPoll === "function") playbackOnPoll();
  if (typeof FALLBACK !== "undefined" && FALLBACK.active) FALLBACK.update();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

async function refreshDevice() {
  const id = S.deviceId;
  if (!id) return;
  let detail;
  try {
    detail = await netJSON("/api/device/" + encodeURIComponent(id), { timeout: 8000 });
  } catch (e) {
    return; // keep the last-drawn drawer rather than blanking it
  }
  if (S.deviceId !== id) return;   // selection changed while this was loading
  if (detail.error) { closeDrawer(); return; }
  S.device = detail;
  // full build only when first opened or when switching devices; otherwise
  // patch in place so the drawer's scroll position is preserved
  if (!S.devEls || S.devEls.deviceId !== detail.id) renderDrawer();
  else updateDrawer();
}

function startPolling() {
  if (POLL.started) return;
  POLL.started = true;
  const loop = async () => {
    if (document.hidden) { POLL.timer = setTimeout(loop, 1500); return; }
    await poll();
    POLL.timer = setTimeout(loop, pollDelay());
  };
  loop();
  POLL.deviceTimer = setInterval(() => {
    if (!document.hidden && S.deviceId) refreshDevice();
  }, 5000);
  POLL.intelTimer = setInterval(() => {
    if (!document.hidden) pollIntelligence();
  }, 5000);
  // coming back to the tab should not wait for the next timer tick
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !POLL.started) return;
    poll();
    pollIntelligence();
  });
}

/* ---------------- header clock ---------------- */

function renderClock() {
  const sim = S.snap.sim;
  $("#clock-day").textContent = sim.day;
  $("#clock-time").textContent = sim.time;
  $("#speed-chip").textContent = sim.paused ? "paused" : sim.speed + "×";
  const pause = $("#pause-btn");
  if (pause) {
    pause.textContent = sim.paused ? "▶" : "❚❚";
    pause.title = sim.paused ? "Resume simulation" : "Pause simulation";
    pause.setAttribute("aria-label", pause.title);
  }
  if (typeof shellSyncStatus === "function") shellSyncStatus();
}

function renderOverlay() {
  const sim = S.snap.sim;
  $("#overlay-legend").innerHTML =
    `<span><span class="sw" style="background:${cssVar("--series-1")}"></span>Solar</span>` +
    `<span><span class="sw" style="background:${cssVar("--series-2")}"></span>Load</span>` +
    `<span><span class="sw" style="background:${cssVar("--series-3")}"></span>Grid</span>`;
  $("#overlay-weather").innerHTML =
    `<b>${Math.round(sim.temp_out)}°C</b> · ${escapeHTML(sim.weather)} · ` +
    (sim.sun > 0.03 ? "☀ daylight" : "☾ night") +
    `<span class="hud-cloud"> · cloud ${Math.round(sim.cloud * 100)}%</span>`;
}

/* ---------------- KPI tiles ---------------- */

function renderKpis() {
  const k = S.snap.kpis;

  const delta = (today, yest) => {
    if (yest < 0.5) return "";
    const pct = ((today - yest) / yest) * 100;
    const cls = pct >= 0 ? "up" : "down";
    return ` <span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs yesterday</span>`;
  };

  // banner KPI: today's solar energy (reference: "428.74 kWh / Solar Production")
  const bannerKpi = $("#banner-kpi-val");
  if (bannerKpi) bannerKpi.textContent = k.today.solar_kwh.toFixed(1) + " kWh";
  const bannerLabel = $("#banner-kpi-label");
  if (bannerLabel) {
    const d = delta(k.today.solar_kwh, k.yesterday.solar_kwh);
    bannerLabel.textContent = "Solar production" + (d ? d.replace(/<[^>]+>/g, "") : "");
  }
  // photo panel KPI: current solar power
  const photoKpi = $("#photo-kpi-val");
  if (photoKpi) photoKpi.textContent = k.solar_kw.toFixed(1) + " kW";
  // power-flow header chip: today's solar energy
  const chartKpi = $("#chart-kpi-val");
  if (chartKpi) chartKpi.textContent = k.today.solar_kwh.toFixed(1) + " kWh";

  $("#kpi-load-val").textContent = k.load_kw.toFixed(1) + " kW";
  const net = k.net_kw;
  $("#kpi-grid-val").textContent = (net >= 0 ? "+" : "−") + Math.abs(net).toFixed(1) + " kW";
  $("#kpi-suff-val").textContent = Math.round(k.sufficiency * 100) + "%";
  const anom = $("#kpi-anom-val");
  if (anom) anom.textContent = k.anomalies;
  const anomSub = $("#kpi-anom-sub");
  if (anomSub) anomSub.textContent = k.anomalies ? "detected by AI" : "all systems nominal";

  $("#kpi-load-sub").innerHTML = `${k.today.load_kwh.toFixed(0)} kWh today${delta(k.today.load_kwh, k.yesterday.load_kwh)}`;
  $("#kpi-grid-sub").textContent = `${net >= 0 ? "importing" : "exporting"} · ${k.today.import_kwh.toFixed(0)} in / ${k.today.export_kwh.toFixed(0)} out kWh`;
  $("#kpi-suff-sub").textContent = `${k.today.solar_kwh.toFixed(0)} kWh solar today`;

  // production footer meta: today's peak + live inverter conversion efficiency
  const dayStart = (S.snap.sim.day - 1) * 1440;
  let peak = 0;
  for (const p of S.snap.history) if (p.t >= dayStart) peak = Math.max(peak, p.solar);
  const peakEl = $("#peak-val");
  if (peakEl) peakEl.textContent = peak.toFixed(1) + " kW";
  const inv = (S.snap.devices || []).find(d => d.id === "inverter");
  const effEl = $("#eff-val");
  if (effEl) {
    const eff = inv && inv.extra ? inv.extra.efficiency : null;
    effEl.textContent = eff == null ? "—" : (eff > 1 ? eff.toFixed(1) : (eff * 100).toFixed(1)) + "%";
  }
}

/* ---------------- solar performance donut ---------------- */

function arcPath(frac) {
  if (frac <= 0.002) return "";
  const f = Math.min(1, frac);
  const a = Math.PI - Math.PI * f;
  const x = 120 + 90 * Math.cos(a);
  const y = 118 - 90 * Math.sin(a);
  // sweep=1 always: clockwise from the left end sweeps over the top. The old
  // conditional sweep drew short arcs under the baseline, into the legend.
  return `M 30 118 A 90 90 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

function renderDonut() {
  const actualArc = $("#donut-actual-arc");
  const expectedArc = $("#donut-expected-arc");
  if (!actualArc || !expectedArc) return;

  // the expected ring sits underneath the live ring so the shortfall shows teal
  expectedArc.parentNode.insertBefore(expectedArc, actualArc);

  const panels = S.snap.panels || [];
  const expected = panels.reduce((s, p) => s + (p.expected || 0), 0);
  const actual = S.snap.kpis.solar_kw;
  const ratio = expected > 0.02 ? actual / expected : 0;

  expectedArc.setAttribute("d", arcPath(1));
  actualArc.setAttribute("d", arcPath(ratio));
  const center = $("#donut-center");
  if (center) center.textContent = expected > 0.02 ? Math.round(ratio * 100) + "%" : "—";
  const a = $("#donut-actual");
  if (a) a.textContent = actual.toFixed(1);
  const e = $("#donut-expected");
  if (e) e.textContent = expected.toFixed(1);
}

/* ---------------- trend sparkline ---------------- */

function renderTrend() {
  const el = $("#trend-chart");
  if (!el) return;
  const dayStart = (S.snap.sim.day - 1) * 1440;
  let rows = S.snap.history.filter(p => p.t >= dayStart);
  if (rows.length < 3) rows = S.snap.history.slice(-48);
  if (rows.length < 2) return;
  const vals = rows.map(p => p.solar);
  const max = Math.max(0.2, ...vals);
  const w = 236, h = 84, pad = 5;
  const pts = vals.map((v, i) => [
    pad + (i / (vals.length - 1)) * (w - pad * 2),
    h - pad - (v / max) * (h - pad * 2),
  ]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  const area = line + `L${w - pad} ${h - pad}L${pad} ${h - pad}Z`;
  const gradId = "trend-fill-" + (document.documentElement.dataset.theme || "dark");
  el.innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Solar output today">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(240,178,94,0.34)"/>
        <stop offset="1" stop-color="rgba(240,178,94,0)"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gradId})"/>
      <path d="${line}" fill="none" stroke="#f0b25e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="2.6" fill="#ffd79b"/>
    </svg>`;
  const anomalies = S.snap.kpis.anomalies;
  const chip = $("#trend-chip");
  if (chip) {
    chip.textContent = anomalies ? `${anomalies} issue${anomalies > 1 ? "s" : ""}` : "Normal";
    chip.className = "sev-chip" + (anomalies ? " warning" : "");
  }
  const sub = $("#trend-sub");
  if (sub) sub.textContent = `PV array output · day ${S.snap.sim.day}, ${S.snap.sim.time}`;
}

/* ---------------- intelligence cards ---------------- */

async function pollIntelligence() {
  try {
    S.intel = await netJSON("/api/intelligence", { timeout: 8000 });
  } catch (e) {
    return; // keep the last intelligence payload
  }
  renderRepair();
  renderValue();
  // the below-fold panel renders from the same payload; it used to run a
  // second fetch loop of its own, doubling every request
  if (typeof renderIntelligence === "function") renderIntelligence(S.intel);
}

function renderRepair() {
  const body = $("#repair-body");
  if (!body) return;
  const intel = S.intel;
  const chip = $("#repair-chip");
  const ev = intel && intel.prioritized_events && intel.prioritized_events[0];
  if (!ev) {
    const rec = intel && intel.recommendations && intel.recommendations[0];
    body.innerHTML =
      `<div class="repair-issue-head"><span style="color:var(--good)">✓</span> No open issues</div>
       <p class="repair-msg">${escapeHTML(rec || "All monitored equipment is operating inside its expected band.")}</p>
       <div class="repair-person">
         <span class="repair-avatar">AI</span>
         <div class="repair-person-text"><b>Continuous monitoring</b>48 modules · health ${intel ? intel.health_score.toFixed(1) : "—"}</div>
       </div>`;
    if (chip) { chip.textContent = "Healthy"; chip.className = "trend-chip"; }
    return;
  }
  const sev = STATUS[ev.severity] || STATUS.warning;
  const message = String(ev.message || "").replace(/^[^:]+:\s*/, "");
  body.innerHTML =
    `<div class="repair-issue-head">
       <span style="color:${cssVar(sev.color)}">${sev.glyph}</span> ${escapeHTML(ev.device_name || "Equipment")}
       <span class="repair-sev" style="color:${cssVar(sev.color)};background:color-mix(in srgb, ${cssVar(sev.color)} 14%, transparent)">Action required</span>
     </div>
     <p class="repair-msg">${escapeHTML(message)}</p>
     <div class="repair-person">
       <span class="repair-avatar">AI</span>
       <div class="repair-person-text"><b>${ev.impact_kw != null ? ev.impact_kw.toFixed(2) + " kW expected-vs-actual gap" : "Monitoring impact"}</b>
       ${intel.projected_daily_waste_cost != null ? "$" + intel.projected_daily_waste_cost.toFixed(2) + "/day projected waste" : ""} · priority ${ev.priority_score != null ? ev.priority_score.toFixed(0) : "—"}</div>
     </div>
     <button type="button" class="repair-btn" data-device="${escapeHTML(ev.device_id || "")}">Review issue →</button>`;
  const btn = body.querySelector(".repair-btn");
  if (btn) btn.addEventListener("click", () => openDrawer(btn.dataset.device));
  if (chip) {
    chip.textContent = ev.severity === "critical" ? "Critical" : "Live";
    chip.className = "trend-chip";
    chip.style.color = cssVar(sev.color);
  }
}

function renderValue() {
  const intel = S.intel;
  if (!intel) return;
  const cost = $("#value-cost");
  if (cost) cost.textContent = "$" + (intel.projected_daily_waste_cost || 0).toFixed(2);
  const kwh = $("#value-kwh");
  if (kwh) kwh.textContent = (intel.projected_daily_waste_kwh || 0).toFixed(1) + " kWh";
  const co2 = $("#value-co2");
  if (co2) co2.textContent = (intel.projected_daily_waste_co2_kg || 0).toFixed(1) + " kg";
  const health = $("#value-health");
  if (health) health.textContent = intel.health_score != null ? intel.health_score.toFixed(1) : "—";
}

/* ============================================================
   Building navigation: view modes, breadcrumbs, level cards
   ============================================================ */

const VIEW_TITLES = {
  campus: "Campus",
  building: "Building",
  floor: "Floor",
  room: "Room",
  roof: "Rooftop Solar Plant",
};

function setView(mode, ids = {}, opts = {}) {
  S.view = { mode, buildingId: ids.buildingId || null, floorId: ids.floorId || null, roomId: ids.roomId || null };
  if (typeof flyToView === "function") flyToView(S.view, opts);
  renderCrumbs();
  renderViewNav();
  renderSceneTitle();
  // the navigator panel mirrors the current hierarchy scope
  if (typeof syncNavigator === "function") syncNavigator("view");
  if (typeof camSyncView === "function") camSyncView(S.view);
  if (typeof shellOnViewChange === "function") shellOnViewChange(S.view);
}

function viewName(kind, id) {
  const thing = findTwinThing(id);
  if (!thing) return id || "";
  if (thing.kind === "roof") return thing.building.name + " Rooftop";
  return thing.data.name;
}

function renderSceneTitle() {
  const el = $("#scene-title");
  if (!el) return;
  if (S.device || S.deviceId) {
    const d = S.device || (S.deviceId ? findTwinDevice(S.deviceId) : null);
    el.textContent = d ? d.name : "Solar Plant 01";
    return;
  }
  if (S.levelCard) { el.textContent = viewName(S.levelCard.kind, S.levelCard.id); return; }
  const v = S.view || {};
  if (v.mode === "building" || v.mode === "floor" || v.mode === "room") {
    el.textContent = v.mode === "building" ? viewName("building", v.buildingId)
      : v.mode === "floor" ? viewName("floor", v.floorId)
      : viewName("room", v.roomId);
  } else {
    el.textContent = VIEW_TITLES[v.mode] || "Solar Plant 01";
  }
}

/* --- breadcrumbs --- */

function renderCrumbs() {
  const el = $("#crumbs");
  if (!el) return;
  const v = S.view || {};
  const segs = [["campus", "Campus"]];
  if (v.mode === "roof" && v.buildingId) segs.push(["building:" + v.buildingId, viewName("building", v.buildingId)]);
  if (v.buildingId && (v.mode === "building" || v.mode === "floor" || v.mode === "room")) {
    segs.push(["building:" + v.buildingId, viewName("building", v.buildingId)]);
  }
  if (v.floorId && (v.mode === "floor" || v.mode === "room")) {
    segs.push(["floor:" + v.floorId, viewName("floor", v.floorId)]);
  }
  if (v.roomId && v.mode === "room") {
    segs.push(["room:" + v.roomId, viewName("room", v.roomId)]);
  }
  if (v.mode === "roof") segs.push(["roof", "Rooftop"]);
  el.textContent = "";
  segs.forEach(([target, label], i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      el.append(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "crumb" + (i === segs.length - 1 ? " current" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => crumbGo(target));
    el.append(btn);
  });
}

function crumbGo(target) {
  if (target === "campus") { closeDrawer(); setView("campus"); return; }
  if (target === "roof") { closeDrawer(); setView("roof", { buildingId: S.view.buildingId }); return; }
  const [kind, id] = target.split(":");
  const thing = findTwinThing(id);
  if (!thing) return;
  if (kind === "building") { closeDrawer(); setView("building", { buildingId: id }); }
  else if (kind === "floor") {
    closeDrawer();
    setView("floor", { buildingId: thing.building.id, floorId: id });
  } else if (kind === "room") {
    closeDrawer();
    setView("room", { buildingId: thing.building.id, floorId: thing.floor.id, roomId: id });
  }
}

/* --- floating scene navigation (floor pills / back) --- */

function renderViewNav() {
  const nav = $("#view-nav");
  if (!nav) return;
  const v = S.view || {};
  nav.textContent = "";
  if (v.mode === "building" && v.buildingId) {
    const b = (S.snap.buildings || []).find(x => x.id === v.buildingId);
    if (!b) { nav.classList.add("hidden"); return; }
    nav.classList.remove("hidden");
    (b.floors || []).forEach(f => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "vnav-pill";
      pill.textContent = "F" + f.level;
      pill.addEventListener("click", () => {
        closeDrawer();
        setView("floor", { buildingId: b.id, floorId: f.id });
      });
      nav.append(pill);
    });
    if (b.solar) {
      const roof = document.createElement("button");
      roof.type = "button";
      roof.className = "vnav-pill roof";
      roof.textContent = "☀ Rooftop PV";
      roof.addEventListener("click", () => { closeDrawer(); setView("roof", { buildingId: b.id }); });
      nav.append(roof);
    }
    if (typeof setExplodedView === "function") {
      const ex = document.createElement("button");
      ex.type = "button";
      ex.className = "vnav-pill explode" + (typeof EXPLODE !== "undefined" && EXPLODE.on ? " selected" : "");
      ex.textContent = "⧉ Exploded";
      ex.title = "Separate the floors vertically to inspect each level";
      ex.setAttribute("aria-pressed",
        typeof EXPLODE !== "undefined" && EXPLODE.on ? "true" : "false");
      ex.addEventListener("click", () => setExplodedView(!(typeof EXPLODE !== "undefined" && EXPLODE.on)));
      nav.append(ex);
    }
  } else if (v.mode === "floor" && v.buildingId && v.floorId) {
    const b = (S.snap.buildings || []).find(x => x.id === v.buildingId);
    const f = b && (b.floors || []).find(x => x.id === v.floorId);
    if (!b || !f) { nav.classList.add("hidden"); return; }
    nav.classList.remove("hidden");
    const back = document.createElement("button");
    back.type = "button";
    back.className = "vnav-pill back";
    back.textContent = "↑ " + b.name;
    back.addEventListener("click", () => {
      closeDrawer();
      setView("building", { buildingId: b.id });
    });
    nav.append(back);
    (f.rooms || []).forEach(r => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "vnav-pill" + (v.roomId === r.id ? " selected" : "");
      pill.textContent = r.name;
      pill.addEventListener("click", () => {
        closeDrawer();
        setView("room", { buildingId: b.id, floorId: f.id, roomId: r.id });
      });
      nav.append(pill);
    });
  } else if (v.mode === "room" && v.floorId) {
    const thing = findTwinThing(v.floorId);
    if (!thing) { nav.classList.add("hidden"); return; }
    nav.classList.remove("hidden");
    const back = document.createElement("button");
    back.type = "button";
    back.className = "vnav-pill back";
    back.textContent = "← " + thing.data.name;
    back.addEventListener("click", () => {
      closeDrawer();
      setView("floor", { buildingId: thing.building.id, floorId: thing.data.id });
    });
    nav.append(back);
  } else {
    nav.classList.add("hidden");
  }
}

/* --- selection hierarchy: where a device / room / floor lives --- */

function deviceContext(id) {
  for (const b of S.snap.buildings || []) {
    for (const f of b.floors || []) {
      for (const r of f.rooms || []) {
        if ((r.devices || []).some(d => d.id === id)) return { building: b, floor: f, room: r };
      }
      if (f.fcu && f.fcu.id === id) return { building: b, floor: f, room: null };
    }
    if ((b.equipment || []).some(d => d.id === id)) return { building: b, floor: null, room: null };
    if ((b.roof_device_ids || []).includes(id)) return { building: b, floor: null, room: null, roof: true };
  }
  return null;
}

/* Returns a nav element: clickable hierarchy chain + "back to parent" button. */
function buildHierarchyNav(selKind, id) {
  const nav = document.createElement("div");
  nav.className = "sel-nav";
  const chain = document.createElement("div");
  chain.className = "sel-chain";
  const addCrumb = (label, target, current) => {
    if (chain.childElementCount) {
      const sep = document.createElement("span");
      sep.className = "sel-sep";
      sep.textContent = "›";
      chain.append(sep);
    }
    const el = document.createElement(current ? "span" : "button");
    el.className = "sel-crumb" + (current ? " current" : "");
    el.textContent = label;
    if (!current) {
      el.type = "button";
      el.addEventListener("click", () => { if (target) target(); });
    }
    chain.append(el);
  };

  let backTo = null, backLabel = "";
  if (selKind === "device") {
    const ctx = deviceContext(id);
    if (!ctx) {
      addCrumb("Solar Plant 01", () => { closeDrawer(); setView("roof"); }, false);
      addCrumb((findTwinDevice(id) || {}).name || "Device", null, true);
    } else {
      const b = ctx.building;
      addCrumb("Campus", () => { closeDrawer(); setView("campus"); });
      addCrumb(b.name, () => { closeDrawer(); setView("building", { buildingId: b.id }); });
      if (ctx.floor) {
        addCrumb(ctx.floor.name, () => { closeDrawer(); setView("floor", { buildingId: b.id, floorId: ctx.floor.id }); });
        if (ctx.room) {
          addCrumb(ctx.room.name, () => { closeDrawer(); setView("room", { buildingId: b.id, floorId: ctx.floor.id, roomId: ctx.room.id }); });
          backTo = () => { closeDrawer(); setView("room", { buildingId: b.id, floorId: ctx.floor.id, roomId: ctx.room.id }); };
          backLabel = "↑ Back to " + ctx.room.name;
        } else {
          backTo = () => { closeDrawer(); setView("floor", { buildingId: b.id, floorId: ctx.floor.id }); };
          backLabel = "↑ Back to " + ctx.floor.name;
        }
      } else if (ctx.roof) {
        addCrumb("Rooftop", () => { closeDrawer(); setView("roof", { buildingId: b.id }); });
        backTo = () => { closeDrawer(); setView("roof", { buildingId: b.id }); };
        backLabel = "↑ Back to rooftop";
      } else {
        backTo = () => { closeDrawer(); setView("building", { buildingId: b.id }); };
        backLabel = "↑ Back to " + b.name;
      }
      const nameEl = document.querySelector("#dev-name");
      const label = nameEl ? nameEl.textContent : id;
      addCrumb(label, null, true);
    }
  } else {
    const thing = findTwinThing(id);
    addCrumb("Campus", () => { closeDrawer(); setView("campus"); });
    if (selKind === "building") {
      addCrumb(thing ? thing.data.name : id, null, true);
      backTo = () => { closeDrawer(); setView("campus"); };
      backLabel = "↑ Back to Campus";
    } else if (selKind === "floor") {
      const b = thing.building;
      addCrumb(b.name, () => { closeDrawer(); setView("building", { buildingId: b.id }); });
      addCrumb(thing.data.name, null, true);
      backTo = () => { closeDrawer(); setView("building", { buildingId: b.id }); };
      backLabel = "↑ Back to " + b.name;
    } else {
      const b = thing.building, f = thing.floor;
      addCrumb(b.name, () => { closeDrawer(); setView("building", { buildingId: b.id }); });
      addCrumb(f.name, () => { closeDrawer(); setView("floor", { buildingId: b.id, floorId: f.id }); });
      addCrumb(thing.data.name, null, true);
      backTo = () => { closeDrawer(); setView("floor", { buildingId: b.id, floorId: f.id }); };
      backLabel = "↑ Back to " + f.name;
    }
  }

  nav.append(chain);
  if (backTo) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sel-back";
    btn.textContent = backLabel;
    btn.addEventListener("click", backTo);
    nav.append(btn);
  }
  return nav;
}

/* --- level cards (building / floor / room) in the device drawer shell --- */

function openLevel(id) {
  const thing = findTwinThing(id);
  if (!thing || thing.kind === "device") { openDrawer(id); return; }
  if (thing.kind === "roof") {
    if (!thing.building.solar) { openLevel(thing.building.id); return; }
    closeDrawer();
    setView("roof", { buildingId: thing.building.id });
    return;
  }
  if (thing.kind === "building") setView("building", { buildingId: id });
  else if (thing.kind === "floor") setView("floor", { buildingId: thing.building.id, floorId: id });
  else setView("room", { buildingId: thing.building.id, floorId: thing.floor.id, roomId: id });
  S.deviceId = null;
  S.device = null;
  S.devEls = null;
  S.levelCard = { kind: thing.kind, id };
  S.selection = { id, kind: thing.kind };
  const drawer = $("#device-drawer");
  if (drawer && drawer.classList.contains("hidden")) {
    const active = document.activeElement;
    drawerReturnFocus = active && active !== document.body ? active : null;
  }
  if (drawer) drawer.classList.remove("hidden");
  focusDrawerClose();
  renderLevelCard();
  renderSceneTitle();
  if (typeof syncNavigator === "function") syncNavigator("selection");
  if (typeof cameraSelectionChanged === "function") cameraSelectionChanged();
  if (typeof camUpdateUI === "function") camUpdateUI();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

const LVL_ROW_ICON = { building: "▦", floor: "▤", room: "▢" };

function renderLevelCard() {
  const thing = findTwinThing(S.levelCard.id);
  if (!thing) { closeDrawer(); return; }
  const d = thing.data;
  const body = $("#dev-body");
  $("#dev-name").textContent = d.name;
  body.textContent = "";
  body.append(buildHierarchyNav(S.levelCard.kind, S.levelCard.id));

  const row = document.createElement("div");
  row.className = "dev-status-row";
  const badge = document.createElement("span");
  badge.className = "status-badge";
  const dot = document.createElement("span");
  dot.className = "dot";
  const badgeLabel = document.createElement("span");
  badge.append(dot, badgeLabel);
  const big = document.createElement("span");
  big.className = "dev-big";
  const bigText = document.createElement("span");
  bigText.className = "lvl-kw-main";
  const small = document.createElement("small");
  big.append(bigText, small);
  row.append(badge, big);
  body.append(row);

  const info = document.createElement("div");
  info.className = "lvl-info";
  body.append(info);

  // level actions: exploded-floor toggle and room camera entry/replay
  const actions = document.createElement("div");
  actions.className = "lvl-actions";
  const actEls = {};
  if (S.levelCard.kind === "building" || S.levelCard.kind === "floor") {
    const ex = document.createElement("button");
    ex.type = "button";
    ex.className = "lvl-action explode";
    ex.textContent = (typeof EXPLODE !== "undefined" && EXPLODE.on)
      ? "⧉ Collapse floors" : "⧉ Exploded floors";
    ex.addEventListener("click", () => {
      if (typeof setExplodedView !== "function") return;
      const targetId = thing.kind === "building" ? thing.data.id : thing.building.id;
      if (VIEW.mode !== "building") {
        setExplodedView(true);
        setView("building", { buildingId: targetId });
      } else {
        setExplodedView(!EXPLODE.on);
      }
    });
    actions.append(ex);
    actEls.explode = ex;
  }
  if (S.levelCard.kind === "room") {
    const enter = document.createElement("button");
    enter.type = "button";
    enter.className = "lvl-action enter-room";
    enter.textContent = "⌖ Enter room";
    enter.title = "Fly the camera into the room through the doorway";
    enter.addEventListener("click", () => {
      setView("room", {
        buildingId: thing.building.id,
        floorId: thing.floor.id,
        roomId: thing.data.id,
      }, { entry: true });
    });
    actions.append(enter);
    actEls.enter = enter;
  }
  if (actions.childElementCount) body.append(actions);

  const list = document.createElement("div");
  list.className = "lvl-list";
  body.append(list);

  const note = document.createElement("p");
  note.className = "pop-note lvl-note";
  body.append(note);

  S.levelEls = { kind: S.levelCard.kind, id: S.levelCard.id, badge, dot, badgeLabel, bigText, small, info, list, note, actions: actEls };
  updateLevelCard();
}

function updateLevelCard() {
  if (!S.levelCard || !S.levelEls || S.levelEls.id !== S.levelCard.id) return;
  const thing = findTwinThing(S.levelCard.id);
  if (!thing) return;
  const d = thing.data;
  const els = S.levelEls;
  const anom = d.anomalies || 0;
  els.dot.style.background = cssVar(anom ? "--serious" : "--good");
  els.badge.style.color = cssVar(anom ? "--serious" : "--good");
  els.badge.style.borderColor = cssVar(anom ? "--serious" : "--good");
  els.badgeLabel.textContent = anom ? "⚠ " + anom + " anomaly" + (anom > 1 ? "ies" : "") : "✓ Nominal";
  els.bigText.textContent = d.actual.toFixed(1) + " kW ";
  els.small.textContent = "actual · " + d.expected.toFixed(1) + " kW expected";
  if (els.actions && els.actions.explode) {
    const on = typeof EXPLODE !== "undefined" && EXPLODE.on;
    els.actions.explode.textContent = on ? "⧉ Collapse floors" : "⧉ Exploded floors";
    els.actions.explode.classList.toggle("on", on);
  }

  // info line
  if (thing.kind === "building") {
    els.info.textContent = `${(d.floors || []).length} floors · ${(d.equipment || []).length} plant items` +
      (d.solar ? " · rooftop PV plant" : "");
  } else if (thing.kind === "floor") {
    els.info.textContent = `${(d.rooms || []).length} rooms · FCU ${d.fcu ? d.fcu.actual.toFixed(1) + " kW" : "—"}`;
  } else {
    els.info.textContent = `${d.usage || "room"} · ${d.area} m² · ${(d.devices || []).length} circuits`;
  }

  // children rows (rebuilt only when the tree shape changes; values patched)
  const sig = (thing.kind === "building")
    ? (d.floors || []).map(f => f.id + (d.solar ? "roof" : "")).join(",")
    : thing.kind === "floor"
      ? (d.rooms || []).map(r => r.id).join(",") + "|" + (d.fcu ? d.fcu.id : "")
      : (d.devices || []).map(x => x.id).join(",");
  if (S.levelEls.sig !== sig) {
    S.levelEls.sig = sig;
    els.list.textContent = "";
    const addRow = (lvlId, icon, title, sub) => {
      const li = document.createElement("div");
      li.className = "lvl-row";
      li.dataset.lvl = lvlId;
      li.tabIndex = 0;
      li.innerHTML = `<span class="lvl-ico">${icon}</span>
        <span class="lvl-main"><span class="lvl-name">${escapeHTML(title)}</span>
        <span class="lvl-sub">${escapeHTML(sub)}</span></span>
        <span class="lvl-kw">—</span>`;
      li.addEventListener("click", () => openLevel(lvlId));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLevel(lvlId); }
      });
      els.list.append(li);
    };
    if (thing.kind === "building") {
      (d.floors || []).forEach(f => addRow(f.id, LVL_ROW_ICON.floor, f.name, f.rooms.length + " rooms"));
      if (d.solar) addRow("roof-" + d.id, "☀", "Rooftop Solar Plant", "48 PV modules · inverter");
      (d.equipment || []).forEach(eq => addRow(eq.id, "⚡", eq.name, eq.kind.replace("_", " ")));
    } else if (thing.kind === "floor") {
      (d.rooms || []).forEach(r => addRow(r.id, LVL_ROW_ICON.room, r.name, r.usage + " · " + r.area + " m²"));
      if (d.fcu) addRow(d.fcu.id, "❄", d.fcu.name, "fan-coil unit");
    } else {
      (d.devices || []).forEach(dv => addRow(dv.id, dv.kind === "room_light" ? "◉" : "⚡", dv.name, dv.kind.replace("_", " ")));
    }
  }

  // patch row values in place
  const children = thing.kind === "building"
    ? [...(d.floors || []).map(f => ({ id: f.id, d: f })),
       ...(d.solar ? [{ id: "roof-" + d.id, d: { actual: S.snap.kpis.solar_kw, expected: 0, status: "ok", anomalies: 0 } }] : []),
       ...(d.equipment || []).map(eq => ({ id: eq.id, d: eq }))]
    : thing.kind === "floor"
      ? [...(d.rooms || []).map(r => ({ id: r.id, d: r })), ...(d.fcu ? [{ id: d.fcu.id, d: d.fcu }] : [])]
      : (d.devices || []).map(dv => ({ id: dv.id, d: dv }));
  for (const c of children) {
    const li = els.list.querySelector(`.lvl-row[data-lvl="${c.id}"]`);
    if (!li) continue;
    const st = STATUS[c.d.status] || STATUS.ok;
    const kw = li.querySelector(".lvl-kw");
    kw.textContent = c.d.actual != null ? c.d.actual.toFixed(c.d.actual < 10 ? 2 : 1) + " kW" : "—";
    kw.style.color = c.d.status && c.d.status !== "ok" ? cssVar(st.color) : "";
    const name = li.querySelector(".lvl-name");
    if (c.d.anomalies) name.innerHTML = escapeHTML(c.d.name) + ` <span style="color:${cssVar("--serious")}">⚠</span>`;
    else if (c.d.status && c.d.status !== "ok") name.innerHTML = escapeHTML(c.d.name) + ` <span style="color:${cssVar(st.color)}">${st.glyph}</span>`;
  }

  els.note.textContent = thing.kind === "building"
    ? "Click a floor to explore its rooms and equipment in the twin."
    : thing.kind === "floor"
      ? "Click a room to inspect it, or a circuit to open its device view."
      : "Click a circuit for live telemetry, fault injection and AI diagnosis.";
}

/* ---------------- energy mix ---------------- */

const mix = { mode: null, els: null };  // persistent mix card (patched in place)

function renderMix() {
  const el = $("#mix-chart");
  const t = S.snap.kpis.today;
  const mode = S.tables.has("mix") ? "table" : "bar";
  if (mix.mode !== mode) {
    el.textContent = "";
    mix.els = null;
    mix.mode = mode;
  }

  if (mode === "table") {
    if (!mix.els) {
      const table = document.createElement("table");
      table.className = "mix-table";
      table.innerHTML = `<thead><tr><th>Source</th><th>kWh today</th></tr></thead><tbody>
        <tr><td>Solar (self-consumed)</td><td id="mix-v-solar">—</td></tr>
        <tr><td>Grid import</td><td id="mix-v-import">—</td></tr>
        <tr><td>Grid export</td><td id="mix-v-export">—</td></tr>
        <tr><td>Total load</td><td id="mix-v-load">—</td></tr></tbody>`;
      el.append(table);
      mix.els = {
        solar: table.querySelector("#mix-v-solar"),
        imp: table.querySelector("#mix-v-import"),
        exp: table.querySelector("#mix-v-export"),
        load: table.querySelector("#mix-v-load"),
      };
    }
    mix.els.solar.textContent = (t.solar_kwh - t.export_kwh).toFixed(1);
    mix.els.imp.textContent = t.import_kwh.toFixed(1);
    mix.els.exp.textContent = t.export_kwh.toFixed(1);
    mix.els.load.textContent = t.load_kwh.toFixed(1);
    return;
  }

  if (!mix.els) {
    const bar = document.createElement("div");
    bar.className = "mix-bar";
    bar.setAttribute("role", "img");
    const segS = document.createElement("div"); segS.className = "mix-seg";
    const segG = document.createElement("div"); segG.className = "mix-seg";
    bar.append(segS, segG);
    const legend = document.createElement("div"); legend.className = "mix-legend";
    const lS = document.createElement("span");
    const swS = document.createElement("span"); swS.className = "swatch"; swS.style.background = cssVar("--series-1");
    const tS = document.createTextNode("");
    lS.append(swS, tS);
    const lG = document.createElement("span");
    const swG = document.createElement("span"); swG.className = "swatch"; swG.style.background = cssVar("--series-3");
    const tG = document.createTextNode("");
    lG.append(swG, tG);
    const lX = document.createElement("span");
    const tX = document.createTextNode("");
    lX.append(tX);
    legend.append(lS, lG, lX);
    const empty = document.createElement("p");
    empty.className = "alert-empty";
    el.append(bar, legend, empty);
    mix.els = { bar, segS, segG, legend, tS, tG, lX, tX, empty };
  }

  const solarUsed = Math.max(0, t.solar_kwh - t.export_kwh);
  const grid = t.import_kwh;
  const total = solarUsed + grid;
  if (total < 0.5) {
    mix.els.bar.style.display = "none";
    mix.els.legend.style.display = "none";
    mix.els.empty.textContent = "No consumption recorded yet.";
    mix.els.empty.style.display = "";
    return;
  }
  mix.els.empty.style.display = "none";
  mix.els.bar.style.display = "";
  mix.els.legend.style.display = "";
  const sPct = (solarUsed / total) * 100;
  const gPct = (grid / total) * 100;
  mix.els.bar.setAttribute("aria-label", `Energy mix: solar ${sPct.toFixed(0)} percent, grid ${gPct.toFixed(0)} percent`);
  mix.els.segS.style.flex = sPct;
  mix.els.segG.style.flex = gPct;
  mix.els.tS.textContent = `Solar ${sPct.toFixed(0)}% · ${solarUsed.toFixed(0)} kWh`;
  mix.els.tG.textContent = `Grid ${gPct.toFixed(0)}% · ${grid.toFixed(0)} kWh`;
  if (t.export_kwh > 0.5) {
    mix.els.tX.textContent = `Exported ${t.export_kwh.toFixed(0)} kWh`;
    mix.els.lX.style.display = "";
  } else {
    mix.els.lX.style.display = "none";
  }
}

/* ---------------- alerts ---------------- */

const alertRows = new Map();  // event id -> live row elements

function renderAlerts() {
  const ul = $("#alerts");
  const events = S.snap.events;
  $("#alert-count").textContent = S.snap.kpis.anomalies
    ? `${S.snap.kpis.anomalies} active anomaly${S.snap.kpis.anomalies > 1 ? "ies" : ""}` : "";
  if (typeof updateAlarmBadge === "function") updateAlarmBadge();

  // drop rows whose events aged out of the feed
  const seen = new Set(events.map(ev => ev.id));
  for (const [id, row] of alertRows) {
    if (!seen.has(id)) { row.li.remove(); alertRows.delete(id); }
  }

  let placeholder = ul.querySelector(".alert-empty");
  if (!events.length) {
    if (!placeholder) {
      placeholder = document.createElement("li");
      placeholder.className = "alert-empty";
      ul.append(placeholder);
    }
    placeholder.innerHTML =
      `<b>No active alerts</b><span>All 48 modules are reporting within expectations. Click any panel to inspect it.</span>`;
    return;
  }
  if (placeholder) placeholder.remove();

  // insert/update rows in feed order (newest first), without touching untouched DOM
  let prev = null;
  for (const ev of events) {
    let row = alertRows.get(ev.id);
    if (!row) {
      row = buildAlertRow(ev);
      alertRows.set(ev.id, row);
    } else {
      updateAlertRow(row, ev);
    }
    // expected slot: right after the previously processed row (new rows are
    // detached, so compare identity, not previousElementSibling)
    const slot = prev ? prev.nextSibling : ul.firstElementChild;
    if (row.li !== slot) {
      ul.insertBefore(row.li, slot);
    }
    prev = row.li;
  }
  while (ul.lastElementChild !== prev) {
    const last = ul.lastElementChild;
    alertRows.delete(Number(last.dataset.id));
    last.remove();
  }

  // the top priority row gets the reference's featured treatment
  for (const row of alertRows.values()) row.li.classList.remove("featured");
  const featured = ul.querySelector(".alert-row");
  if (featured) featured.classList.add("featured");
}

function buildAlertRow(ev) {
  const li = document.createElement("li");
  li.className = "alert-row";
  li.dataset.id = ev.id;
  const dot = document.createElement("span");
  dot.className = "alert-dot";
  const msg = document.createElement("span");
  msg.className = "alert-msg";
  const b = document.createElement("b");
  const meta = document.createElement("span");
  meta.className = "alert-meta";
  const sev = document.createElement("span");
  sev.className = "alert-sev-chip";
  li.append(dot, msg, meta, sev);
  li.addEventListener("click", () => openDrawer(ev.device_id));
  let btn = null;
  if (ev.severity !== "operator") {
    btn = document.createElement("button");
    btn.className = "alert-ai";
    btn.textContent = "Ask AI";
    btn.addEventListener("click", (e) => { e.stopPropagation(); openDrawer(ev.device_id); askAI(ev.device_id); });
    li.append(btn);
  }
  const row = { li, dot, msg, b, meta, btn, sev };
  updateAlertRow(row, ev);
  return row;
}

function updateAlertRow(row, ev) {
  row.li.className = "alert-row" + (ev.severity === "operator" ? " operator" : "");
  row.dot.style.background = ev.severity === "operator" ? cssVar("--text-muted") : cssVar(STATUS[ev.severity].color);
  row.b.textContent = ev.device_name;
  row.msg.replaceChildren(row.b, " — " + ev.message.replace(/^[^:]+:\s*/, ""));
  row.meta.textContent = `D${ev.day} ${ev.time}`;
  if (row.sev) {
    if (ev.severity === "operator") {
      row.sev.style.display = "none";
    } else {
      const st = STATUS[ev.severity] || STATUS.warning;
      row.sev.style.display = "";
      row.sev.textContent = st.label + " · action required";
      row.sev.style.background = cssVar(st.color);
    }
  }
}

/* ============================================================
   SVG line chart engine
   ============================================================ */

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

const chartCache = {};   // chart key -> persistent instance (built once, patched in place)
const tableCache = {};   // chart key -> persistent table instance

function chartInstance(container, data, width) {
  const key = data.key;
  const minimal = !!data.minimal;
  const height = data.height || (minimal ? 128 : 240);
  const m = minimal ? { l: 6, r: 8, t: 8, b: 16 } : { l: 46, r: 84, t: 12, b: 26 };
  const seriesSig = data.series.map(s => s.key + (s.dashed ? "~" : "") + (s.area ? "a" : "")).join(",");
  const shapeKey = `${width}|${height}|${seriesSig}|${minimal ? "m" : "f"}|${document.documentElement.dataset.theme}`;
  let c = chartCache[key];
  if (!c || c.shapeKey !== shapeKey) {
    // --- build the persistent skeleton (static parts only) ---
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.height = height + "px";

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.append(defs);

    const yGrid = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.append(yGrid);

    const xLabels = [];
    if (!minimal) {
      for (let k = 0; k < 5; k++) {
        const label = svgText("", 0, height - 8, "middle", "11px", cssVar("--text-muted"));
        svg.append(label);
        xLabels.push(label);
      }
    }

    const paths = [], areaPaths = [], endDots = [], endLabels = [], leads = [];
    for (const s of data.series) {
      let areaPath = null;
      if (s.area) {
        const gradId = `area-${key}-${s.key}`;
        const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
        grad.setAttribute("id", gradId);
        grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
        grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
        const st0 = document.createElementNS("http://www.w3.org/2000/svg", "stop");
        st0.setAttribute("offset", "0"); st0.setAttribute("stop-color", s.color); st0.setAttribute("stop-opacity", "0.34");
        const st1 = document.createElementNS("http://www.w3.org/2000/svg", "stop");
        st1.setAttribute("offset", "1"); st1.setAttribute("stop-color", s.color); st1.setAttribute("stop-opacity", "0");
        grad.append(st0, st1);
        defs.append(grad);
        areaPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        areaPath.setAttribute("fill", `url(#${gradId})`);
        svg.append(areaPath);
      }
      areaPaths.push(areaPath);

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", s.color);
      path.setAttribute("stroke-width", minimal ? "1.7" : "2");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      if (s.dashed) path.setAttribute("stroke-dasharray", minimal ? "4 4" : "6 4");
      svg.append(path);
      paths.push(path);

      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", minimal ? "3" : "4");
      dot.setAttribute("fill", s.color);
      dot.setAttribute("stroke", cssVar("--surface-1")); dot.setAttribute("stroke-width", "2");
      if (minimal) dot.style.display = "none";
      svg.append(dot);
      endDots.push(dot);

      const lead = document.createElementNS("http://www.w3.org/2000/svg", "line");
      lead.setAttribute("x1", width - m.r - 4); lead.setAttribute("x2", width - m.r + 2);
      lead.setAttribute("stroke", cssVar("--text-muted")); lead.setAttribute("stroke-width", "1");
      lead.style.display = "none";
      svg.append(lead);
      leads.push(lead);

      const txt = svgText("", width - m.r + 6, 0, "start", "11px", cssVar("--text-secondary"));
      txt.setAttribute("font-weight", "600");
      if (minimal) txt.style.display = "none";
      svg.append(txt);
      endLabels.push(txt);
    }

    const cross = document.createElementNS("http://www.w3.org/2000/svg", "line");
    cross.setAttribute("y1", m.t); cross.setAttribute("y2", m.t + height - m.t - m.b);
    cross.setAttribute("stroke", cssVar("--text-muted")); cross.setAttribute("stroke-width", "1");
    cross.style.display = "none";
    const crossDots = data.series.map(s => {
      const cd = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      cd.setAttribute("r", "4"); cd.setAttribute("fill", s.color);
      cd.setAttribute("stroke", cssVar("--surface-1")); cd.setAttribute("stroke-width", "2");
      cd.style.display = "none";
      svg.append(cd);
      return cd;
    });
    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    overlay.setAttribute("x", m.l); overlay.setAttribute("y", m.t);
    overlay.setAttribute("width", width - m.l - m.r); overlay.setAttribute("height", height - m.t - m.b);
    overlay.setAttribute("fill", "transparent");
    svg.append(cross, overlay);

    const tip = document.createElement("div");
    tip.className = "twin-tip";
    tip.style.display = "none";
    tip.style.position = "absolute";
    tip.style.pointerEvents = "none";
    container.style.position = "relative";

    c = {
      shapeKey, key, m, width, height, svg, yGrid, xLabels, minimal,
      paths, areaPaths, endDots, endLabels, leads, cross, crossDots, overlay, tip,
      yDomain: null, hoverI: null, data: null,
    };
    chartCache[key] = c;
    container.textContent = "";
    container.append(c.svg, c.tip);

    // Legend is laid out only after the SVG is attached: getComputedTextLength()
    // returns 0 for text in a detached tree, which collapsed the labels together.
    if (data.series.length >= 2 && !minimal) {
      const legend = document.createElementNS("http://www.w3.org/2000/svg", "g");
      legend.setAttribute("transform", `translate(${m.l + 4}, 14)`);
      c.svg.append(legend);
      let lx = 0;
      for (const s of data.series) {
        const keyLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        keyLine.setAttribute("x1", lx); keyLine.setAttribute("y1", 0);
        keyLine.setAttribute("x2", lx + 16); keyLine.setAttribute("y2", 0);
        keyLine.setAttribute("stroke", s.color); keyLine.setAttribute("stroke-width", "2");
        if (s.dashed) keyLine.setAttribute("stroke-dasharray", "6 4");
        legend.append(keyLine);
        const txt = svgText(s.label, lx + 21, 3.5, "start", "11px", cssVar("--text-secondary"));
        legend.append(txt);
        lx += 21 + txt.getComputedTextLength() + 16;
      }
    }

    // handlers bound once per instance; they read the latest c.data
    overlay.addEventListener("mousemove", (e) => {
      const n = c.data ? c.data.x.length : 0;
      if (!n) return;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left - m.l;
      const pw = width - m.l - m.r;
      const i = Math.max(0, Math.min(n - 1, Math.round((px / pw) * (n - 1))));
      c.hoverI = i;
      S._mainHover = { key, i };
      showCross(c, i);
    });
    overlay.addEventListener("mouseleave", () => { c.hoverI = null; hideCross(c); });
  }

  // Returning from table view clears the container; re-attach the cached SVG.
  if (!container.contains(c.svg)) {
    container.textContent = "";
    container.append(c.svg, c.tip);
  }

  c.data = data;
  const n = data.x.length;
  if (!n) { hideCross(c); return; }
  const pw = width - m.l - m.r, ph = height - m.t - m.b;

  // --- scales ---
  const allV = data.series.flatMap(s => s.v);
  let yMin = Math.min(0, ...allV), yMax = Math.max(1, ...allV);
  const step = niceStep((yMax - yMin) / 4);
  yMax = Math.ceil(yMax / step) * step;
  yMin = Math.floor(yMin / step) * step;
  const xAt = i => m.l + (n > 1 ? (i / (n - 1)) * pw : 0);
  const yAt = v => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

  // y gridlines + labels rebuilt only when the domain actually changes
  const domainSig = `${yMin}|${yMax}|${step}`;
  if (c.yDomain !== domainSig) {
    c.yDomain = domainSig;
    c.yGrid.textContent = "";
    if (c.minimal) {
      // a single hairline baseline is all the production card needs
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", m.l); line.setAttribute("x2", width - m.r);
      line.setAttribute("y1", height - m.b); line.setAttribute("y2", height - m.b);
      line.setAttribute("stroke", cssVar("--gridline"));
      line.setAttribute("stroke-width", "1");
      c.yGrid.append(line);
    } else {
      for (let v = yMin; v <= yMax + step * 0.01; v += step) {
        const vv = Math.round(v * 100) / 100;
        const y = yAt(vv);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", m.l); line.setAttribute("x2", width - m.r);
        line.setAttribute("y1", y); line.setAttribute("y2", y);
        line.setAttribute("stroke", vv === 0 ? cssVar("--baseline") : cssVar("--gridline"));
        line.setAttribute("stroke-width", "1");
        c.yGrid.append(line);
        c.yGrid.append(svgText(vv.toFixed(vv < 10 && vv !== 0 ? 1 : 0), m.l - 8, y + 3.5, "end", "11px", cssVar("--text-muted")));
      }
    }
  }

  // x tick labels: patched in place every render
  for (let k = 0; k < c.xLabels.length; k++) {
    const i = Math.round((k / 4) * (n - 1));
    c.xLabels[k].textContent = fmtTicks(data.x[i]);
    c.xLabels[k].setAttribute("x", xAt(i));
  }

  // series paths + end dots + end labels (stacked, with leader lines)
  const endInfos = data.series.map((s, si) => ({ si, y: yAt(s.v[n - 1]), value: s.v[n - 1] }));
  endInfos.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endInfos.length; i++) {
    if (endInfos[i].y < endInfos[i - 1].y + 14) endInfos[i].y = endInfos[i - 1].y + 14;
  }
  const baseY = yAt(yMin);
  data.series.forEach((s, si) => {
    let d = "";
    for (let i = 0; i < n; i++) d += (i ? "L" : "M") + xAt(i).toFixed(1) + " " + yAt(s.v[i]).toFixed(1);
    c.paths[si].setAttribute("d", d);
    if (c.areaPaths[si]) {
      c.areaPaths[si].setAttribute("d",
        d + `L${xAt(n - 1).toFixed(1)} ${baseY.toFixed(1)}L${xAt(0).toFixed(1)} ${baseY.toFixed(1)}Z`);
    }
    c.endDots[si].setAttribute("cx", xAt(n - 1));
    c.endDots[si].setAttribute("cy", yAt(s.v[n - 1]));
  });
  for (const L of endInfos) {
    const s = data.series[L.si];
    const endY = yAt(s.v[n - 1]);
    c.endLabels[L.si].setAttribute("y", L.y + 3.5);
    c.endLabels[L.si].textContent = `${s.label} ${L.value.toFixed(1)}`;
    c.leads[L.si].style.display = Math.abs(L.y - endY) > 7 ? "" : "none";
    c.leads[L.si].setAttribute("y1", endY);
    c.leads[L.si].setAttribute("y2", L.y);
  }

  // restore the hover readout at its previous x position
  if (c.hoverI != null && c.hoverI < n) showCross(c, c.hoverI);
  else hideCross(c);
}

function showCross(c, i) {
  const { data, m, width, height } = c;
  if (!data) return;
  const n = data.x.length;
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const allV = data.series.flatMap(s => s.v);
  let yMin = Math.min(0, ...allV), yMax = Math.max(1, ...allV);
  const step = niceStep((yMax - yMin) / 4);
  yMax = Math.ceil(yMax / step) * step;
  yMin = Math.floor(yMin / step) * step;
  const xAt = i => m.l + (n > 1 ? (i / (n - 1)) * pw : 0);
  const yAt = v => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;
  c.cross.style.display = "";
  c.cross.setAttribute("x1", xAt(i)); c.cross.setAttribute("x2", xAt(i));
  data.series.forEach((s, k) => {
    c.crossDots[k].style.display = "";
    c.crossDots[k].setAttribute("cx", xAt(i));
    c.crossDots[k].setAttribute("cy", yAt(s.v[i]));
  });
  c.tip.style.display = "";
  c.tip.innerHTML = `<div class="tip-name">${fmtTime(data.x[i])}</div>` +
    data.series.map(s =>
      `<div class="tip-row"><span style="display:inline-block;width:14px;height:3px;background:${s.color};margin-right:5px;vertical-align:middle"></span>` +
      `${escapeHTML(s.label)}: <b style="color:${cssVar("--text-primary")}">${s.v[i].toFixed(1)} kW</b></div>`).join("");
  c.tip.style.left = Math.min(xAt(i) + m.l + 12, width - 190) + "px";
  c.tip.style.top = Math.max(yAt(Math.max(...data.series.map(s => s.v[i]))) - 8, 4) + "px";
}

function hideCross(c) {
  c.cross.style.display = "none";
  c.crossDots.forEach(d => d.style.display = "none");
  c.tip.style.display = "none";
}

function renderLineChart(container, data) {
  // data: { key, x: [t], series: [{key, label, color, dashed, v: [...]}], height }
  if (S.tables.has(data.key)) { renderChartTable(container, data); return; }
  const width = Math.max(container.clientWidth || 600, 320);
  chartInstance(container, data, width);
}

function renderChartTable(container, data) {
  const key = data.key;
  const seriesSig = data.series.map(s => s.key).join(",");
  const shapeKey = `${seriesSig}|${document.documentElement.dataset.theme}`;
  let t = tableCache[key];
  if (!t || t.shapeKey !== shapeKey) {
    const table = document.createElement("table");
    table.className = "chart-table";
    const thead = document.createElement("thead");
    thead.innerHTML = `<tr><th>Time</th>${data.series.map(s => `<th>${escapeHTML(s.label)} (kW)</th>`).join("")}</tr>`;
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    t = { shapeKey, table, tbody, rows: [] };
    tableCache[key] = t;
    container.textContent = "";
    container.append(table);
  }
  // window of the latest ~24 rows; cells patched in place, rows added/removed as needed
  const n = data.x.length;
  const step = Math.max(1, Math.floor(n / 24));
  const indices = [];
  for (let i = n - 1; i >= 0; i -= step) indices.unshift(i);
  while (t.rows.length < indices.length) {
    const tr = document.createElement("tr");
    tr.append(document.createElement("td"));
    data.series.forEach(() => tr.append(document.createElement("td")));
    t.rows.push(tr);
    t.tbody.append(tr);
  }
  while (t.rows.length > indices.length) t.rows.pop().remove();
  t.rows.forEach((tr, r) => {
    const i = indices[r];
    tr.cells[0].textContent = fmtTime(data.x[i]);
    data.series.forEach((s, si) => { tr.cells[si + 1].textContent = s.v[i].toFixed(1); });
  });
}

function svgText(text, x, y, anchor, size, color) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.textContent = text;
  t.setAttribute("x", x); t.setAttribute("y", y);
  t.setAttribute("text-anchor", anchor);
  t.setAttribute("font-size", size);
  t.setAttribute("fill", color);
  t.setAttribute("font-family", "system-ui, -apple-system, 'Segoe UI', sans-serif");
  return t;
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- main chart ---------------- */

function renderMainChart() {
  if (!S.snap) return;  // resize can fire before the first poll
  const h = S.snap.history;
  if (!h || h.length < 2) return;
  let rows = h;
  if (S.range > 0) {
    const tNow = h[h.length - 1].t;
    rows = h.filter(p => p.t >= tNow - S.range);
    if (rows.length < 2) rows = h.slice(-2);
  }
  if (rows.length > 400) {
    const step = Math.ceil(rows.length / 400);
    rows = rows.filter((_, i) => i % step === 0);
  }
  renderLineChart($("#main-chart"), {
    key: "main",
    minimal: true,
    x: rows.map(p => p.t),
    series: [
      { key: "solar", label: "Solar generation", color: cssVar("--series-1"), area: true, v: rows.map(p => p.solar) },
      { key: "load", label: "Building load", color: cssVar("--series-2"), v: rows.map(p => p.load) },
      { key: "grid", label: "Grid exchange", color: cssVar("--series-3"), v: rows.map(p => p.grid) },
    ],
    height: 128,
  });
}

/* ============================================================
   Device drawer
   ============================================================ */

/* Where keyboard focus goes back to when the drawer closes.  Opening a
   panel from the canvas moves focus into the panel (so Tab and Escape work
   immediately); closing it returns focus to whatever opened it. */
let drawerReturnFocus = null;

function focusDrawerClose() {
  const drawer = $("#device-drawer");
  const close = $("#drawer-close");
  if (drawer && close && !drawer.classList.contains("hidden")
      && !drawer.contains(document.activeElement)) {
    close.focus({ preventScroll: true });
  }
}

function openDrawer(id) {
  const drawer = $("#device-drawer");
  if (drawer && drawer.classList.contains("hidden")) {
    const active = document.activeElement;
    drawerReturnFocus = active && active !== document.body ? active : null;
  }
  S.deviceId = id;
  S.device = null;
  S.devEls = null;
  S.levelCard = null;
  S.levelEls = null;
  S.selection = { id, kind: "device" };
  if (drawer) drawer.classList.remove("hidden");
  focusDrawerClose();
  renderSceneTitle();
  if (typeof syncNavigator === "function") syncNavigator("selection");
  if (typeof cameraSelectionChanged === "function") cameraSelectionChanged();
  if (typeof camUpdateUI === "function") camUpdateUI();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
  if (typeof shellOnDrawerChange === "function") shellOnDrawerChange(id, true);
  refreshDevice();
}

function closeDrawer() {
  const drawer = $("#device-drawer");
  const wasOpen = drawer && !drawer.classList.contains("hidden");
  S.deviceId = null;
  S.device = null;
  S.devEls = null;
  S.levelCard = null;
  S.levelEls = null;
  S.aiResult = null;
  S.selection = null;
  if (drawer) drawer.classList.add("hidden");
  if (wasOpen && drawerReturnFocus && document.contains(drawerReturnFocus)) {
    try { drawerReturnFocus.focus({ preventScroll: true }); } catch (_) { /* detached */ }
  }
  drawerReturnFocus = null;
  renderSceneTitle();
  if (typeof syncNavigator === "function") syncNavigator("selection");
  if (typeof cameraSelectionChanged === "function") cameraSelectionChanged();
  if (typeof camUpdateUI === "function") camUpdateUI();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
  if (typeof shellOnDrawerChange === "function") shellOnDrawerChange(null, false);
}

const EXTRA_LABELS = {
  ghi: ["Irradiance", ""], cell_temp: ["Cell temp", "°C"],
  dc_in: ["DC input", "kW"], efficiency: ["Efficiency", ""],
  duty: ["Cooling duty", ""], units_online: ["Units online", ""],
  dimming: ["Dimming level", ""], occupancy: ["Occupancy", ""],
  voltage: ["Voltage", "V"], current: ["Current", "A"],
  performance: ["Performance", "%"],
  room: ["Room", ""], temp: ["Outdoor temp", "°C"],
  cab_floor: ["Cab floor", ""], load_pct: ["Load", "%"],
  battery: ["Battery health", "%"], session: ["Session", ""],
  tank_temp: ["Tank temp", "°C"],
};

function formatExtra(k, v) {
  let text = v;
  if (k === "efficiency" && v != null) text = (v * 100).toFixed(0) + "%";
  if (k === "duty" && v != null) text = (v * 100).toFixed(0) + "%";
  if (k === "dimming" && v != null) text = (v * 100).toFixed(0) + "%";
  if (k === "occupancy" && v != null) text = (v * 100).toFixed(0) + "%";
  const [, unit] = EXTRA_LABELS[k] || [k, ""];
  return v == null ? "—" : String(text) + (unit ? " " + unit : "");
}

function devChartData(d) {
  return {
    key: "dev",
    x: d.history.map(p => p.t),
    series: [
      { key: "actual", label: "Actual", color: cssVar("--series-1"), v: d.history.map(p => p.actual) },
      { key: "expected", label: "Expected", color: cssVar("--series-2"), dashed: true, v: d.history.map(p => p.expected) },
    ],
    height: 190,
  };
}

/* ---------------- scenario comparison (Step 9F/H) ----------------
   Mirrors equipment.calculations.compare_baseline_scenario: the scenario's
   rated power x load factor is applied only to the part of its daily
   schedule that overlaps the baseline window, capped by the covered
   duration.  Both numbers are calculated estimates, never metered. */

function scenarioClock(hour) {
  const total = Math.round(Number(hour) * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function scenarioOverlapMinutes(startAbs, endAbs, schedStart, schedEnd) {
  if (!(endAbs > startAbs) || !(schedEnd > schedStart)) return 0;
  let total = 0;
  let cursor = startAbs;
  let guard = 0;
  while (cursor < endAbs - 1e-9 && guard++ < 400) {
    const dayStart = Math.floor(cursor / 1440) * 1440;
    const segmentEnd = Math.min(endAbs, dayStart + 1440);
    const overlapStart = Math.max(cursor, dayStart + schedStart * 60);
    const overlapEnd = Math.min(segmentEnd, dayStart + schedEnd * 60);
    if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    cursor = segmentEnd;
  }
  return total;
}

function scenarioComparison(en, cfg) {
  const baseline = en && en.baseline;
  if (!baseline || baseline.status !== "ok" || baseline.energy_kwh == null) {
    return { state: "empty", reason: "Baseline comparison unavailable — not enough usable power history yet." };
  }
  if (!baseline.window || !cfg) {
    return { state: "empty", reason: "Enter valid scenario values to compare with the baseline." };
  }
  const covered = Number(baseline.duration_hours || 0);
  if (covered < 1) {
    return { state: "empty", reason: "Baseline comparison needs at least 1 h of covered power history." };
  }
  const startMin = Number(baseline.window.start_minutes);
  const endMin = Number(baseline.window.end_minutes);
  const windowHours = (endMin - startMin) / 60;
  const scheduledMinutes = scenarioOverlapMinutes(
    startMin, endMin, cfg.schedule_start, cfg.schedule_start + cfg.operating_hours);
  const scheduledHours = Math.min(scheduledMinutes / 60, windowHours, covered);
  const baselineKwh = Number(baseline.energy_kwh);
  const scenarioKwh = cfg.rated_kw * cfg.load_factor * scheduledHours;
  const delta = scenarioKwh - baselineKwh;
  const direction = delta > 1e-9 ? "higher" : delta < -1e-9 ? "lower" : "equal";
  const percent = baselineKwh > 1e-9 ? delta / baselineKwh * 100 : null;
  return {
    state: "ok",
    baselineKwh,
    scenarioKwh,
    delta,
    direction,
    percent,
    scheduledHours,
    windowHours,
    coveredHours: covered,
  };
}

/* Draw the paired bars + delta line.  No status colours here: both bars are
   scenario math, and the palette is reserved for actual equipment states. */
function renderScenarioCompare(el, en, cfg) {
  if (!el) return;
  el.textContent = "";
  const head = document.createElement("div");
  head.className = "compare-head";
  const title = document.createElement("span");
  title.textContent = "Baseline vs scenario";
  const scope = document.createElement("span");
  scope.textContent = "same window";
  head.append(title, scope);
  el.append(head);

  const cmp = scenarioComparison(en, cfg);
  if (cmp.state !== "ok") {
    const empty = document.createElement("p");
    empty.className = "compare-empty";
    empty.textContent = cmp.reason;
    el.append(empty);
    return;
  }

  const max = Math.max(cmp.baselineKwh, cmp.scenarioKwh, 1e-9);
  const addRow = (cls, label, kwh) => {
    const row = document.createElement("div");
    row.className = "compare-row" + (cls ? " " + cls : "");
    const name = document.createElement("span");
    name.textContent = label;
    const bar = document.createElement("span");
    bar.className = "compare-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(kwh > 0 ? 2 : 0, (kwh / max) * 100)}%`;
    bar.append(fill);
    const value = document.createElement("b");
    value.textContent = `${kwh.toFixed(1)} kWh`;
    row.append(name, bar, value);
    el.append(row);
  };
  addRow("", "Baseline", cmp.baselineKwh);
  addRow("scenario", "Scenario", cmp.scenarioKwh);

  const delta = document.createElement("p");
  delta.className = "compare-delta " + cmp.direction;
  const strong = document.createElement("b");
  const pctText = cmp.percent == null ? "" : ` (${cmp.percent > 0 ? "+" : ""}${cmp.percent.toFixed(1)}%)`;
  if (cmp.direction === "lower") {
    strong.textContent = `${Math.abs(cmp.delta).toFixed(1)} kWh lower than baseline${pctText}`;
  } else if (cmp.direction === "higher") {
    strong.textContent = `${cmp.delta.toFixed(1)} kWh higher than baseline${pctText}`;
  } else {
    strong.textContent = "Matches the baseline estimate";
  }
  delta.append(strong);
  const tail = document.createElement("span");
  tail.textContent = ` · ${cmp.scheduledHours.toFixed(1)} scheduled h inside the ${cmp.windowHours.toFixed(1)} h window`;
  delta.append(tail);
  el.append(delta);

  const note = document.createElement("p");
  note.className = "compare-note";
  note.textContent = "Both figures are calculated estimates from simulated power history — not metered consumption.";
  el.append(note);
}

function renderDrawer() {
  const d = S.device;
  if (!d) return;
  // Full build: only on open or when switching devices. Later refreshes patch
  // values in place via updateDrawer() so the drawer scroll position survives.
  delete chartCache.dev;
  delete tableCache.dev;
  delete chartCache["dev-energy"];
  $("#dev-name").textContent = d.name;
  const body = $("#dev-body");
  body.textContent = "";
  body.append(buildHierarchyNav("device", d.id));

  // equipment type + measurement-source chip
  const typeRow = document.createElement("div");
  typeRow.className = "dev-type-row";
  const typeEl = document.createElement("span");
  typeEl.className = "dev-type";
  typeEl.textContent = d.type_label || d.kind;
  const srcChip = document.createElement("span");
  srcChip.className = "src-chip " + (d.source || "simulated");
  srcChip.textContent = (d.source || "simulated").toUpperCase();
  typeRow.append(typeEl, srcChip);
  body.append(typeRow);

  // simulated equipment is always clearly labelled as such
  if ((d.source || "simulated") === "simulated") {
    const banner = document.createElement("div");
    banner.className = "sim-mode-banner";
    banner.innerHTML = `<b>Simulation mode</b>
      <span>Readings are produced by the digital-twin model, not live sensor hardware.</span>`;
    body.append(banner);
  }

  // status row
  const row = document.createElement("div");
  row.className = "dev-status-row";
  const badge = document.createElement("span");
  badge.className = "status-badge";
  const dot = document.createElement("span");
  dot.className = "dot";
  const badgeLabel = document.createTextNode("");
  badge.append(dot, badgeLabel);
  const big = document.createElement("span");
  big.className = "dev-big";
  const bigText = document.createTextNode("");
  const small = document.createElement("small");
  big.append(bigText, small);
  row.append(badge, big);
  body.append(row);

  // panel position + performance block (individual panels only)
  let panelEls = null;
  if (d.kind === "panel" && d.panel) {
    const pb = document.createElement("div");
    pb.className = "dev-block panel-block";
    pb.innerHTML = `<h3>Panel monitoring</h3>
      <div class="panel-meta">
        <span>Position <b class="panel-pos">—</b></span>
        <span>Array <b>${d.panel.rows} rows × ${d.panel.cols} cols</b></span>
        <span>Performance <b class="panel-perf-val">—</b></span>
      </div>
      <div class="perf-bar"><div class="perf-fill"></div></div>
      <button type="button" class="btn back-btn">← Back to rooftop</button>`;
    body.append(pb);
    pb.querySelector(".back-btn").addEventListener("click", closeDrawer);
    panelEls = {
      pos: pb.querySelector(".panel-pos"),
      perf: pb.querySelector(".panel-perf-val"),
      fill: pb.querySelector(".perf-fill"),
    };
  }

  // sensor readings (labels fixed; values patched; row/col shown in the panel block)
  const extraCells = {};
  const extras = Object.entries(d.extra || {}).filter(([k]) => k !== "row" && k !== "col");
  {
    const block = document.createElement("div");
    block.className = "dev-block";
    block.innerHTML = "<h3>Sensor readings</h3>";
    if (extras.length) {
      const grid = document.createElement("div");
      grid.className = "extra-grid";
      for (const [k] of extras) {
        const [label] = EXTRA_LABELS[k] || [k, ""];
        const kEl = document.createElement("span");
        kEl.className = "k";
        kEl.textContent = label;
        const vEl = document.createElement("span");
        vEl.className = "v";
        extraCells[k] = vEl;
        grid.append(kEl, vEl);
      }
      block.append(grid);
    } else {
      const empty = document.createElement("p");
      empty.className = "alert-empty";
      empty.textContent = "No sensor readings are available for this equipment.";
      block.append(empty);
    }
    body.append(block);
  }

  // metering (equipment data model: energy, runtime, source, timestamp)
  const sourceSim = (d.source || "simulated") === "simulated";
  const meterCells = {};
  {
    const block = document.createElement("div");
    block.className = "dev-block";
    block.innerHTML = "<h3>Metering</h3>";
    const grid = document.createElement("div");
    grid.className = "extra-grid";
    const rows = [
      ["energy", sourceSim ? "Simulated consumption" : "Consumption today"],
      ["hours", "Operating hours"],
      ["source", "Measurement source"],
      ["measured", "Last measurement"],
      ["freshness", "Data freshness"],
    ];
    for (const [key, label] of rows) {
      const kEl = document.createElement("span");
      kEl.className = "k";
      kEl.textContent = label;
      const vEl = document.createElement("span");
      vEl.className = "v";
      meterCells[key] = vEl;
      grid.append(kEl, vEl);
    }
    block.append(grid);
    body.append(block);
  }

  // energy calculations: rated power, measured power, simulated consumption
  // and the calculated estimate are four distinct quantities - never conflated
  const energyCells = {};
  {
    const block = document.createElement("div");
    block.className = "dev-block";
    block.innerHTML = "<h3>Energy calculations</h3>";
    const grid = document.createElement("div");
    grid.className = "calc-rows";
    for (const [key, label] of [
      ["rated", "Rated power"],
      ["measured", "Measured power"],
      ["simulated", "Simulated consumption"],
      ["calculated", "Calculated estimate"],
      ["window", "Calculation window"],
      ["scenario", "Scenario estimate"],
    ]) {
      const rowEl = document.createElement("div");
      rowEl.className = "calc-row";
      const kEl = document.createElement("span");
      kEl.className = "k";
      kEl.textContent = label;
      const vEl = document.createElement("b");
      vEl.className = "v";
      const tagEl = document.createElement("span");
      tagEl.className = "tag";
      energyCells[key] = vEl;
      energyCells[key + "Tag"] = tagEl;
      rowEl.append(kEl, vEl, tagEl);
      grid.append(rowEl);
    }
    const formula = document.createElement("p");
    formula.className = "calc-formula";
    energyCells.formula = formula;
    const note = document.createElement("p");
    note.className = "calc-note";
    note.textContent = "Calculated estimates are derived from measured power — they are not metered consumption.";
    block.append(grid, formula, note);
    body.append(block);
  }

  // scenario configuration (simulated equipment only): rating, daily hours,
  // load factor, schedule start + same-window baseline comparison
  const scenarioEls = {};
  {
    const block = document.createElement("div");
    block.className = "dev-block";
    block.innerHTML = "<h3>Scenario configuration</h3>";
    if (sourceSim) {
      const sc = (d.energy && d.energy.scenario) || null;
      const en = d.energy || {};
      const form = document.createElement("div");
      form.className = "scenario-form";

      const ratedWrap = document.createElement("label");
      ratedWrap.className = "scenario-field";
      ratedWrap.append(document.createTextNode("Rated power (kW)"));
      const ratedInput = document.createElement("input");
      ratedInput.type = "number";
      ratedInput.min = "0";
      ratedInput.step = "0.1";
      ratedInput.value = sc ? Number(sc.rated_kw).toFixed(1)
        : Number(d.rating || 0).toFixed(1);
      ratedInput.setAttribute("aria-label", "Scenario rated power in kW");
      ratedWrap.append(ratedInput);

      const hoursWrap = document.createElement("label");
      hoursWrap.className = "scenario-field";
      hoursWrap.append(document.createTextNode("Operating hours (h/day)"));
      const hoursInput = document.createElement("input");
      hoursInput.type = "number";
      hoursInput.min = "0";
      hoursInput.max = "24";
      hoursInput.step = "0.5";
      hoursInput.value = sc ? Number(sc.operating_hours).toFixed(1) : "8.0";
      hoursInput.setAttribute("aria-label", "Scenario operating hours per day");
      hoursWrap.append(hoursInput);

      const loadWrap = document.createElement("label");
      loadWrap.className = "scenario-field";
      loadWrap.append(document.createTextNode("Load factor (0–1)"));
      const loadInput = document.createElement("input");
      loadInput.type = "number";
      loadInput.min = "0";
      loadInput.max = "1";
      loadInput.step = "0.05";
      loadInput.value = sc && sc.load_factor != null
        ? Number(sc.load_factor).toFixed(2) : "1.00";
      loadInput.setAttribute("aria-label", "Scenario load factor between 0 and 1");
      loadWrap.append(loadInput);

      const startWrap = document.createElement("label");
      startWrap.className = "scenario-field";
      startWrap.append(document.createTextNode("Window start (hour)"));
      const startInput = document.createElement("input");
      startInput.type = "number";
      startInput.min = "0";
      startInput.max = "24";
      startInput.step = "0.5";
      startInput.value = sc && sc.schedule_start != null
        ? Number(sc.schedule_start).toFixed(1) : "0.0";
      startInput.setAttribute("aria-label", "Scenario daily window start hour");
      startWrap.append(startInput);

      const preview = document.createElement("p");
      preview.className = "scenario-preview";
      const compareEl = document.createElement("div");
      compareEl.className = "scenario-compare";
      compareEl.setAttribute("aria-label", "Baseline vs scenario comparison");
      const actions = document.createElement("div");
      actions.className = "scenario-actions";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn scenario-save";
      saveBtn.textContent = "Save scenario";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "btn scenario-clear";
      clearBtn.textContent = "Clear";
      actions.append(saveBtn, clearBtn);

      const readConfig = () => {
        const p = parseFloat(ratedInput.value);
        const h = parseFloat(hoursInput.value);
        const lf = parseFloat(loadInput.value);
        const start = parseFloat(startInput.value);
        if (![p, h, lf, start].every(Number.isFinite)) return null;
        if (p < 0 || p > 100000 || h < 0 || h > 24) return null;
        if (lf < 0 || lf > 1 || start < 0 || start > 24) return null;
        if (h > 0 && start + h > 24 + 1e-9) return null;
        return {
          rated_kw: p,
          operating_hours: h,
          load_factor: lf,
          schedule_start: start,
        };
      };

      // E = P x t x LF, with the configured daily window made explicit
      const updatePreview = () => {
        const cfg = readConfig();
        if (!cfg) {
          preview.textContent =
            "Enter rated power ≥ 0, hours 0–24, load factor 0–1 and a start hour with start + hours ≤ 24.";
          renderScenarioCompare(compareEl, en, null);
          return;
        }
        const daily = cfg.rated_kw * cfg.load_factor * cfg.operating_hours;
        const factors = [`${cfg.rated_kw.toFixed(1)} kW`];
        if (cfg.load_factor !== 1) factors.push(`${cfg.load_factor.toFixed(2)} LF`);
        factors.push(`${cfg.operating_hours.toFixed(1)} h`);
        const when = cfg.operating_hours > 0
          ? `Window ${scenarioClock(cfg.schedule_start)}–${scenarioClock(cfg.schedule_start + cfg.operating_hours)}`
          : "No operating window";
        preview.textContent =
          `E = ${factors.join(" × ")} = ${daily.toFixed(1)} kWh/day` +
          ` · ${(daily * 30).toFixed(0)} kWh/month\n` +
          `${when} · calculated scenario — not metered`;
        renderScenarioCompare(compareEl, en, cfg);
      };
      ratedInput.addEventListener("input", updatePreview);
      hoursInput.addEventListener("input", updatePreview);
      loadInput.addEventListener("input", updatePreview);
      startInput.addEventListener("input", updatePreview);
      updatePreview();

      saveBtn.addEventListener("click", async () => {
        const cfg = readConfig();
        if (!cfg) {
          preview.textContent = "Fix the scenario values before saving.";
          return;
        }
        saveBtn.disabled = true;
        try {
          const res = await fetch(`/api/equipment/${encodeURIComponent(d.id)}/scenario`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cfg),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            preview.textContent = err.error || "Could not save the scenario.";
            return;
          }
          S.devEls = null;  // rebuild so saved inputs + estimate appear
          refreshDevice();
        } catch (err) {
          preview.textContent = "Could not reach the server. The scenario was not saved.";
        } finally {
          saveBtn.disabled = false;
        }
      });

      clearBtn.addEventListener("click", async () => {
        clearBtn.disabled = true;
        try {
          const res = await fetch(`/api/equipment/${encodeURIComponent(d.id)}/scenario`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clear: true }),
          });
          if (!res.ok) return;
          S.devEls = null;
          refreshDevice();
        } catch (err) {
          renderConnection();
        } finally {
          clearBtn.disabled = false;
        }
      });

      form.append(ratedWrap, hoursWrap, loadWrap, startWrap, preview, compareEl, actions);
      block.append(form);
      scenarioEls.rated = ratedInput;
      scenarioEls.hours = hoursInput;
      scenarioEls.load = loadInput;
      scenarioEls.start = startInput;
      scenarioEls.preview = preview;
      scenarioEls.compare = compareEl;
    } else {
      const empty = document.createElement("p");
      empty.className = "alert-empty";
      empty.textContent = "Scenario configuration is available for simulated equipment only.";
      block.append(empty);
    }
    body.append(block);
  }

  // recent alerts for this equipment (patched when the alert set changes)
  const alertsBlock = document.createElement("div");
  alertsBlock.className = "dev-block";
  alertsBlock.innerHTML = "<h3>Recent alerts</h3>";
  const devAlerts = document.createElement("div");
  devAlerts.className = "dev-alerts";
  alertsBlock.append(devAlerts);
  body.append(alertsBlock);

  // diagnostics summary (model expectation, residual, detector state)
  const diagCells = {};
  {
    const block = document.createElement("div");
    block.className = "dev-block";
    block.innerHTML = "<h3>Diagnostics</h3>";
    const grid = document.createElement("div");
    grid.className = "diag-rows";
    for (const [key, label] of [
      ["expected", "Expected model"],
      ["residual", "Measured residual"],
      ["status", "Detector state"],
      ["anomaly", "Active anomaly"],
    ]) {
      const rowEl = document.createElement("div");
      const kEl = document.createElement("span");
      kEl.textContent = label;
      const vEl = document.createElement("b");
      vEl.className = "diag-" + key;
      diagCells[key] = vEl;
      rowEl.append(kEl, vEl);
      grid.append(rowEl);
    }
    block.append(grid);
    body.append(block);
  }

  // fault injection (rows fixed; active state patched)
  const faultBtns = {};
  const fb = document.createElement("div");
  fb.className = "dev-block";
  fb.innerHTML = "<h3>Virtual fault injection</h3>";
  for (const f of d.faults) {
    const rowF = document.createElement("div");
    rowF.className = "fault-row";
    const fst = STATUS[f.severity] || STATUS.warning;
    rowF.innerHTML = `<div class="fault-info">
        <div class="fault-name">${escapeHTML(f.name)} <span class="conf-note" style="color:${cssVar(fst.color)}">${fst.glyph} ${fst.label}</span>${f.layer === "sensor" ? ' <span class="conf-note">SENSOR FAULT · measurement only</span>' : ""}</div>
        <div class="fault-desc">${escapeHTML(f.description)}</div>
      </div>`;
    const btn = document.createElement("button");
    btn.className = "fault-btn";
    btn.addEventListener("click", async () => {
      // toggle against the LATEST device state (the drawer patches in place,
      // so the fault objects captured at build time go stale)
      const current = ((S.device && S.device.faults) || []).find(x => x.id === f.id);
      const active = current ? current.active : f.active;
      try {
        await netFetch("/api/fault", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: d.id, fault_id: f.id, active: !active }),
        });
      } catch (err) {
        renderConnection();
        return;  // the drawer keeps showing the last confirmed state
      }
      refreshDevice();
    });
    faultBtns[f.id] = btn;
    rowF.append(btn);
    fb.append(rowF);
  }
  body.append(fb);

  // historical consumption chart (stable container; patched in place)
  const generating = d.kind === "solar" || d.kind === "panel" || d.kind === "inverter";
  const ch = document.createElement("div");
  ch.className = "dev-block";
  ch.innerHTML = `<h3>${generating ? "Generation history" : "Historical consumption"} · kW
    <button class="table-toggle" style="float:right" data-table="dev">table</button></h3>`;
  wireTableToggle(ch.querySelector(".table-toggle"));
  const chartEl = document.createElement("div");
  chartEl.className = "chart";
  const chartEmpty = document.createElement("p");
  chartEmpty.className = "alert-empty hidden";
  chartEmpty.textContent = "No measurements yet — history appears after the first few ticks.";
  ch.append(chartEl, chartEmpty);
  body.append(ch);

  // persisted energy history (equipment data model, sampled every 10 s)
  const eb = document.createElement("div");
  eb.className = "dev-block";
  eb.innerHTML = `<h3>${sourceSim ? "Simulated consumption" : "Energy"} · kWh</h3>`;
  const energyChartEl = document.createElement("div");
  energyChartEl.className = "chart";
  const energyEmpty = document.createElement("p");
  energyEmpty.className = "alert-empty hidden";
  eb.append(energyChartEl, energyEmpty);
  body.append(eb);

  // AI diagnosis box (persists; only the result block below it is replaced)
  const ai = document.createElement("div");
  ai.className = "dev-block";
  ai.innerHTML = "<h3>AI diagnosis</h3>";
  const box = document.createElement("div");
  box.className = "ai-box";
  const aiBtn = document.createElement("button");
  aiBtn.className = "ai-primary";
  aiBtn.textContent = "✨ Ask AI to diagnose";
  aiBtn.addEventListener("click", () => askAI(d.id));
  const aiNote = document.createElement("p");
  aiNote.className = "alert-empty";
  box.append(aiBtn, aiNote);
  ai.append(box);
  body.append(ai);

  S.devEls = {
    deviceId: d.id, badge, dot, badgeLabel, bigText, small,
    extraCells, meterCells, energyCells, scenarioEls,
    devAlerts, diagCells, faultBtns,
    chartEl, chartEmpty, energyChartEl, energyEmpty,
    aiBtn, aiNote, aiResultBlock: null,
    panelEls,
  };

  updateDrawer();
  if (S.aiResult && S.aiResult.device_id === d.id) renderAIResult(body);
}

function updateDrawer() {
  // patch in place: values, badges and the chart change; the DOM stays put
  const d = S.device;
  const els = S.devEls;
  if (!d || !els || els.deviceId !== d.id) return;
  // individual panels use the panel vocabulary (Normal/Underperforming/...)
  const st = d.kind === "panel"
    ? (PANEL_STATUS[d.status] || PANEL_STATUS.ok)
    : (STATUS[d.status] || STATUS.ok);
  els.badge.style.color = cssVar(st.color);
  els.badge.style.borderColor = cssVar(st.color);
  els.dot.style.background = cssVar(st.color);
  els.badgeLabel.textContent = `${st.glyph} ${st.label}`;
  // never substitute fabricated values: a missing reading renders as an em dash
  const actual = d.actual != null ? d.actual : null;
  const expected = d.expected != null ? d.expected : null;
  els.bigText.textContent = actual != null ? `${actual.toFixed(1)} kW ` : "— ";
  els.small.textContent = actual != null
    ? `actual · ${expected != null ? expected.toFixed(1) + " kW expected" : "expected unavailable"} (${d.kind === "panel" ? Number(d.rating).toFixed(2) : d.rating} kW rated)`
    : `no measurement available (${d.rating} kW rated)`;
  if (els.panelEls) {
    els.panelEls.pos.textContent = `Row ${d.panel.row} · Col ${d.panel.col}`;
    const perf = d.panel.performance;
    els.panelEls.perf.textContent = perf != null ? perf.toFixed(1) + "%" : "— (night)";
    els.panelEls.fill.style.width = `${Math.max(0, Math.min(100, perf != null ? perf : 0))}%`;
  }
  for (const [k, cell] of Object.entries(els.extraCells)) {
    cell.textContent = formatExtra(k, d.extra ? d.extra[k] : undefined);
  }
  if (els.meterCells) {
    els.meterCells.energy.textContent =
      d.energy_today_kwh != null ? d.energy_today_kwh.toFixed(2) + " kWh" : "—";
    els.meterCells.hours.textContent =
      d.operating_hours != null ? d.operating_hours.toFixed(1) + " h" : "—";
    els.meterCells.source.textContent = d.source || "—";
    els.meterCells.measured.textContent =
      d.measured_at ? `D${d.measured_at.day} ${d.measured_at.time}` : "—";
    els.meterCells.freshness.textContent = fmtFreshness(d.freshness);
  }

  // energy calculations: four quantities with explicit provenance tags
  if (els.energyCells) {
    const en = d.energy || {};
    const calc = en.calculated || {};
    const cell = (key, value, tag) => {
      els.energyCells[key].textContent = value;
      const tagEl = els.energyCells[key + "Tag"];
      if (tagEl) tagEl.textContent = tag || "";
    };
    cell("rated",
      en.rated_power_kw != null ? `${Number(en.rated_power_kw).toFixed(2)} kW` : "—",
      "nameplate");
    cell("measured",
      en.measured_power_kw != null ? `${Number(en.measured_power_kw).toFixed(2)} kW` : "—",
      en.measured_at
        ? `${en.measurement_source || "simulated"} reading · D${en.measured_at.day} ${en.measured_at.time}`
        : `${en.measurement_source || "simulated"} reading`);
    cell("simulated",
      en.simulated_energy_kwh != null ? `${Number(en.simulated_energy_kwh).toFixed(2)} kWh` : "—",
      en.simulated_energy_kwh != null ? "simulation counter · today" : "not applicable");
    if (calc.status === "ok") {
      cell("calculated", `${Number(calc.energy_kwh).toFixed(2)} kWh`,
        `${calc.method_label || calc.method} · not metered`);
      cell("window", `${Number(calc.duration_hours).toFixed(2)} h`,
        `${calc.used_samples} of ${calc.samples} samples` +
        (calc.skipped_intervals ? ` · ${calc.skipped_intervals} gap(s) skipped` : ""));
      els.energyCells.formula.textContent =
        `${calc.formula} — calculated from measured power, not metered.`;
    } else {
      cell("calculated", "—", "insufficient data");
      cell("window", "—", "");
      els.energyCells.formula.textContent = calc.reason
        ? `No calculation: ${calc.reason}.`
        : "No calculation available for this equipment.";
    }
    const sc = en.scenario;
    let scenarioTag = (d.source || "simulated") === "simulated" ? "set below" : "simulated only";
    if (sc) {
      const lf = sc.load_factor != null ? Number(sc.load_factor) : 1;
      const factors = [`${Number(sc.rated_kw).toFixed(1)} kW`];
      if (lf !== 1) factors.push(`LF ${lf.toFixed(2)}`);
      factors.push(`${Number(sc.operating_hours).toFixed(1)} h`);
      scenarioTag = `${factors.join(" × ")} · ${sc.schedule_label || "not scheduled"} · calculated`;
    }
    cell("scenario",
      sc ? `${Number(sc.daily_energy_kwh).toFixed(1)} kWh/day` : "not configured",
      scenarioTag);
  }

  // recent alerts (rebuilt only when the alert set/state changes)
  renderDeviceAlerts(els.devAlerts, d.alerts);

  // diagnostics summary
  if (els.diagCells) {
    els.diagCells.expected.textContent = expected != null
      ? `${expected.toFixed(1)} kW expected` : "no model value";
    els.diagCells.residual.textContent = d.rel != null
      ? `${d.rel > 0 ? "+" : ""}${(d.rel * 100).toFixed(1)}%`
      : "—";
    els.diagCells.residual.style.color =
      Math.abs(d.rel || 0) > 0.1 ? cssVar(st.color) : "";
    els.diagCells.status.textContent = `${st.glyph} ${st.label}`;
    els.diagCells.status.style.color = cssVar(st.color);
    els.diagCells.anomaly.textContent = d.anomaly ? d.anomaly.message : "none";
    els.diagCells.anomaly.style.color = d.anomaly ? cssVar("--warning") : "";
  }
  for (const f of d.faults) {
    const btn = els.faultBtns[f.id];
    if (!btn) continue;
    btn.className = "fault-btn " + (f.active ? "clear" : "inject");
    btn.textContent = f.active ? "✓ Clear" : "Inject";
  }
  if (d.anomaly) {
    els.aiNote.innerHTML = `Active anomaly: <b>${escapeHTML(d.anomaly.message)}</b>`;
  } else {
    els.aiNote.textContent = "No active anomaly. Inject a fault above, wait a few seconds for detection, then ask the AI.";
  }

  // historical power chart, with a real empty state
  if (d.history && d.history.length >= 2) {
    els.chartEl.classList.remove("hidden");
    els.chartEmpty.classList.add("hidden");
    renderLineChart(els.chartEl, devChartData(d));
  } else {
    els.chartEl.classList.add("hidden");
    els.chartEmpty.classList.remove("hidden");
    els.chartEmpty.textContent = "No measurements yet — history appears after the first few ticks.";
  }

  // persisted energy history from the equipment store
  const persisted = d.persisted;
  const ph = (persisted && persisted.history) || [];
  if (ph.length >= 2) {
    els.energyEmpty.classList.add("hidden");
    els.energyChartEl.classList.remove("hidden");
    renderLineChart(els.energyChartEl, {
      key: "dev-energy",
      x: ph.map(p => p.measured_at),
      series: [{
        key: "energy",
        label: (d.source || "simulated") === "simulated"
          ? "Simulated consumption" : "Energy",
        color: cssVar("--series-1"), area: true,
        v: ph.map(p => p.energy_today_kwh),
      }],
      height: 150,
    });
  } else {
    els.energyChartEl.classList.add("hidden");
    els.energyEmpty.classList.remove("hidden");
    els.energyEmpty.textContent = persisted
      ? "Energy history builds as measurements are recorded (one sample every 10 s)."
      : "No persisted measurements yet for this equipment.";
  }
}

/* "live · 3s ago" / "paused · 2m ago" / "—" when no snapshot time exists. */
function fmtFreshness(fr) {
  if (!fr || fr.age_seconds == null || !isFinite(fr.age_seconds)) return "—";
  const s = fr.age_seconds;
  const age = s < 2 ? "just now" : s < 60 ? Math.round(s) + "s ago"
    : s < 3600 ? Math.round(s / 60) + "m ago" : (s / 3600).toFixed(1) + "h ago";
  return (fr.paused ? "paused · " : "live · ") + age;
}

/* Recent alerts for the inspected equipment; empty state when none exist. */
function renderDeviceAlerts(listEl, alerts) {
  if (!listEl) return;
  const list = alerts || [];
  const sig = list.map(a => `${a.id}|${a.active ? 1 : 0}|${a.severity}|${a.message}`).join("§");
  if (listEl.dataset.sig === sig) return;
  listEl.dataset.sig = sig;
  listEl.textContent = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "alert-empty";
    p.textContent = "No alerts recorded for this equipment.";
    listEl.append(p);
    return;
  }
  for (const a of list) {
    const st = STATUS[a.severity] || STATUS.warning;
    const row = document.createElement("div");
    row.className = "dev-alert" + (a.active ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "dev-alert-dot";
    dot.style.background = cssVar(st.color);
    const main = document.createElement("span");
    main.className = "dev-alert-main";
    const msg = document.createElement("span");
    msg.className = "dev-alert-msg";
    msg.textContent = a.message || "";
    const meta = document.createElement("span");
    meta.className = "dev-alert-meta";
    meta.textContent = `D${a.day} ${a.time} · ${st.label.toLowerCase()} · ${a.active ? "active" : "resolved"}`;
    main.append(msg, meta);
    row.append(dot, main);
    listEl.append(row);
  }
}

async function askAI(deviceId) {
  const btn = S.devEls && S.devEls.aiBtn;
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Diagnosing…"; }
  try {
    const res = await netJSON("/api/ai/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
      timeout: 20000,   // a live model call can take a while
    });
    S.aiResult = { device_id: deviceId, diagnosis: res.diagnosis };
    // replace the previous AI result block without rebuilding the drawer
    if (S.devEls && S.devEls.aiResultBlock) {
      S.devEls.aiResultBlock.remove();
      S.devEls.aiResultBlock = null;
    }
    renderAIResult($("#dev-body"));
  } catch (err) {
    // keep any previous diagnosis visible; explain the failed attempt
    if (btn) btn.dataset.failed = "1";
    renderConnection();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.failed
        ? "AI unavailable — try again"
        : "✨ Ask AI to diagnose";
      delete btn.dataset.failed;
    }
  }
}

function renderAIResult(body) {
  const diag = S.aiResult.diagnosis;
  const block = document.createElement("div");
  block.className = "dev-block";
  block.innerHTML = `<h3>AI diagnosis
      <span class="ai-engine-chip" style="float:right;margin-left:8px">${diag.engine === "claude" ? "CLAUDE-OPUS-5" : "RULE ENGINE"}</span></h3>`;
  const box = document.createElement("div");
  box.className = "ai-box";
  box.innerHTML = `<p class="ai-summary">${escapeHTML(diag.summary)}</p>`;
  for (const c of diag.causes) {
    const cause = document.createElement("div");
    cause.className = "ai-cause";
    const conf = Math.round((c.confidence || 0.4) * 100);
    cause.innerHTML = `<div class="ai-cause-head">
        <span>${escapeHTML(c.cause)}</span>
        <span class="conf-note">${conf}%</span>
      </div>
      <div class="conf-bar"><div class="conf-fill" style="width:${conf}%"></div></div>
      <ul class="ai-actions">${c.actions.map(a => `<li>${escapeHTML(a)}</li>`).join("")}</ul>`;
    box.append(cause);
  }
  if (diag.basis && diag.basis.length) {
    const basis = document.createElement("div");
    basis.className = "ai-basis";
    basis.innerHTML = diag.basis.map(b => `· ${escapeHTML(b)}`).join("<br>");
    box.append(basis);
  }
  block.append(box);
  body.append(block);
  if (S.devEls) S.devEls.aiResultBlock = block;
}

/* ---------------- controls ---------------- */

async function postControl(action, value) {
  try {
    await netFetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, value }),
    });
  } catch (err) {
    renderConnection();  // the banner explains the server is unreachable
  }
}

/* Visualization mode selector (status / energy / alerts / health / data). */
function initVizControls() {
  const wrap = $("#viz-modes");
  if (!wrap || typeof VIZ_MODES === "undefined") return;
  wrap.textContent = "";
  for (const m of VIZ_MODES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "viz-mode" + (VIZ.mode === m.id ? " selected" : "");
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.title = m.title;
    b.setAttribute("aria-pressed", VIZ.mode === m.id ? "true" : "false");
    b.addEventListener("click", () => {
      VIZ.mode = m.id;
      VIZ.cache = null;
      wrap.querySelectorAll(".viz-mode").forEach(x => {
        const on = x.dataset.mode === m.id;
        x.classList.toggle("selected", on);
        x.setAttribute("aria-pressed", on ? "true" : "false");
      });
      if (typeof renderVizLegend === "function") renderVizLegend();
      if (typeof playbackOnModeChange === "function") playbackOnModeChange(m.id);
    });
    wrap.append(b);
  }
  if (typeof renderVizLegend === "function") renderVizLegend();
}

function wireControls() {
  const connClose = $("#conn-banner-close");
  if (connClose) connClose.addEventListener("click", dismissConnectionNotice);
  // Phase 9: the connection notice carries an action beside its message —
  // the alarm center keeps the operator's alarm records reachable while the
  // live feed is reconnecting. The banner stays up until it is dismissed or
  // the connection returns. On routes whose stage is hidden (Settings,
  // Intelligence) the overlay cannot display, so the action opens the Alarms
  // page — the same alarm records, never an invisible overlay.
  const connAction = $("#conn-banner-action");
  if (connAction) connAction.addEventListener("click", () => {
    const stage = document.getElementById("stage");
    const stageVisible = stage && stage.offsetParent !== null;
    if (!stageVisible && typeof shellNavigate === "function") {
      shellNavigate("/alarms");
    } else if (typeof openAlarms === "function") {
      openAlarms(true);
    }
  });
  $("#speed").addEventListener("change", (e) => postControl("speed", parseInt(e.target.value, 10)));
  $("#weather").addEventListener("change", (e) => postControl("weather", e.target.value));
  $("#pause-btn").addEventListener("click", () => {
    const paused = S.snap && S.snap.sim.paused;
    postControl("pause", !paused);
  });
  $("#reset-btn").addEventListener("click", () => {
    if (confirm("Reset the simulation? All faults and alerts will be cleared.")) {
      postControl("reset", true);
      closeDrawer();
      setView("campus");
    }
  });
  $("#theme-btn").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    S._mainHover = null;
    // Before the first snapshot the renderers have no data to paint; the
    // theme attribute still applies and the first poll builds the chrome.
    if (!S.snap) {
      if (typeof clearCssVarCache === "function") clearCssVarCache();
      if (typeof sceneInvalidate === "function") sceneInvalidate();
      return;
    }
    // colors are baked into the persistent skeletons, so rebuild them on theme change
    for (const k of Object.keys(chartCache)) delete chartCache[k];
    for (const k of Object.keys(tableCache)) delete tableCache[k];
    mix.mode = null;
    renderMainChart();
    if (S.device) renderDrawer();
    else if (S.levelCard) renderLevelCard();
    renderMix();
    renderOverlay();
    renderTrend();
    // canvas colours are read from CSS variables and cached; both caches
    // must be dropped before the next frame is drawn
    if (typeof clearCssVarCache === "function") clearCssVarCache();
    if (typeof perfClearCaches === "function") perfClearCaches();
    if (typeof sceneInvalidate === "function") sceneInvalidate();
  });

  // Effects quality: full motion, or a static scene that skips shadows,
  // pulses and the high-DPR backing store (also auto-selected for reduced
  // motion / data saver / low-power devices — see perf.js).
  const effects = $("#effects");
  if (effects) {
    if (typeof PERF !== "undefined") effects.value = PERF.quality;
    effects.addEventListener("change", () => {
      if (typeof perfSetQuality === "function") perfSetQuality(effects.value, true);
      if (typeof resizeTwin === "function") resizeTwin();
      if (typeof sceneInvalidate === "function") sceneInvalidate();
      renderMainChart();
    });
  }
  $("#drawer-close").addEventListener("click", closeDrawer);

  // twin camera controls
  $("#twin-zoom-in").addEventListener("click", () => zoomTwin(1.4));
  $("#twin-zoom-out").addEventListener("click", () => zoomTwin(1 / 1.4));
  $("#twin-zoom-reset").addEventListener("click", () => resetCamera());

  // left rail
  const logo = $("#rail-logo");
  if (logo) logo.addEventListener("click", (e) => { e.preventDefault(); resetCamera(); closeDrawer(); });
  $("#rail-home").addEventListener("click", () => { closeDrawer(); setView("campus"); });
  $("#rail-buildings").addEventListener("click", () => {
    if (typeof toggleNavigator === "function") toggleNavigator();
  });
  $("#rail-trend").addEventListener("click", () => {
    const target = $("#below-fold") || $("#energy-intelligence");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#rail-alerts").addEventListener("click", () => {
    // Phones hide the floating alerts card, so the rail opens the alarm
    // center there instead of toggling an invisible element.
    if (window.matchMedia("(max-width: 760px)").matches
        && typeof toggleAlarms === "function") {
      toggleAlarms();
      return;
    }
    const card = $("#alerts-card");
    if (card) card.classList.toggle("hidden");
  });
  $("#rail-equipment").addEventListener("click", () => {
    if (typeof toggleNavigator === "function") toggleNavigator(undefined, { focusSearch: true });
  });
  $("#rail-settings").addEventListener("click", () => toggleSimPop());
  $("#sim-close").addEventListener("click", () => toggleSimPop(false));
  $("#copilot-btn").addEventListener("click", () => {
    const ev = S.intel && S.intel.prioritized_events && S.intel.prioritized_events[0];
    openDrawer(ev ? ev.device_id : "solar");
    if (ev) askAI(ev.device_id);
  });
  $("#simulate-btn").addEventListener("click", () => toggleSimPop(true));

  // keyboard: Esc = close panel / go up one level, F = focus selection, R = reset camera
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.key === "Escape") {
      if (S.deviceId || S.levelCard) { closeDrawer(); return; }
      if (typeof isAlarmsOpen === "function" && isAlarmsOpen()) {
        closeAlarms();
        return;
      }
      if (typeof isNavigatorOpen === "function" && isNavigatorOpen()) {
        openNavigator(false);
        return;
      }
      const v = S.view || {};
      if (v.mode === "room") setView("floor", { buildingId: v.buildingId, floorId: v.floorId });
      else if (v.mode === "floor") setView("building", { buildingId: v.buildingId });
      else if (v.mode === "building" || v.mode === "roof") setView("campus");
    } else if (e.key === "f" || e.key === "F") {
      focusSelection();
    } else if (e.key === "r" || e.key === "R") {
      resetCamera();
    }
  });

  document.querySelectorAll(".range-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      S.range = parseInt(btn.dataset.range, 10) || 0;
      renderMainChart();
    });
  });
  document.querySelectorAll(".table-toggle").forEach(wireTableToggle);
}

function resetCamera() {
  CAM.x = 0; CAM.y = 0; CAM.zoom = 1;
  if (typeof ZOOM !== "undefined") { ZOOM.goal = 1; ZOOM.anchor = null; }
  if (typeof cameraResetExtras === "function") cameraResetExtras();
  if (typeof cancelFlight === "function") cancelFlight();
  if (typeof flyToView === "function" && S.view.mode) flyToView(S.view);
}

/* Focus the camera on whatever is currently selected (room / floor / device). */
function focusSelection() {
  if (typeof cameraFocusSelected === "function" && cameraFocusSelected()) return;
  if (!S.selection) { resetCamera(); return; }
  const thing = findTwinThing(S.selection.id);
  if (!thing) return;
  if (thing.kind === "device") {
    // focus the room/floor that contains the device
    const ctx = deviceContext(S.selection.id);
    if (ctx && ctx.room) {
      setView("room", { buildingId: ctx.building.id, floorId: ctx.floor.id, roomId: ctx.room.id });
    } else if (ctx && ctx.floor) {
      setView("floor", { buildingId: ctx.building.id, floorId: ctx.floor.id });
    } else if (ctx) {
      setView(ctx.roof ? "roof" : "building", { buildingId: ctx.building.id });
    }
    return;
  }
  if (thing.kind === "room") {
    setView("room", { buildingId: thing.building.id, floorId: thing.floor.id, roomId: thing.data.id });
  } else if (thing.kind === "floor") {
    setView("floor", { buildingId: thing.building.id, floorId: thing.data.id });
  } else if (thing.kind === "building") {
    setView("building", { buildingId: thing.data.id });
  } else if (thing.kind === "roof") {
    setView("roof", { buildingId: thing.building.id });
  }
}

function toggleSimPop(force) {
  const pop = $("#sim-pop");
  if (!pop) return;
  const open = force != null ? force : pop.classList.contains("hidden");
  pop.classList.toggle("hidden", !open);
  const rail = $("#rail-settings");
  if (rail) rail.classList.toggle("active", open);
  if (open) {
    // the navigator occupies the same floating slot
    if (typeof openNavigator === "function") openNavigator(false);
    if (S.snap) {
      $("#speed").value = String(S.snap.sim.speed);
      $("#weather").value = S.snap.sim.weather;
    }
  }
}

function wireTableToggle(btn) {
  btn.addEventListener("click", () => {
    const key = btn.dataset.table;
    if (S.tables.has(key)) { S.tables.delete(key); btn.textContent = "table"; }
    else { S.tables.add(key); btn.textContent = "chart"; }
    if (key === "mix") renderMix();
    else if (key === "main") renderMainChart();
    else if (key === "dev" && S.device) renderDrawer();
  });
}

/* ---------------- init ---------------- */

/* Deep links: #campus | #roof | #b1 | #b1f2 | #b1f2r2 open the matching view. */
function applyHashView() {
  // The Phase 2 shell owns both the new routes and the legacy aliases; its
  // parser falls back to the original map only if the shell is unavailable.
  if (typeof shellApplyHash === "function") return shellApplyHash();
  const h = (location.hash || "").replace("#", "");
  if (!h || h === "campus") { setView("campus"); return true; }
  if (h === "roof") { setView("roof", { buildingId: "b1" }); return true; }
  if (h === "b1" || h === "b2") { setView("building", { buildingId: h }); return true; }
  const floor = findTwinThing(h);
  if (floor && floor.kind === "floor") {
    setView("floor", { buildingId: floor.building.id, floorId: h });
    return true;
  }
  const room = findTwinThing(h);
  if (room && room.kind === "room") {
    setView("room", { buildingId: room.building.id, floorId: room.floor.id, roomId: h });
    return true;
  }
  return false;
}
window.addEventListener("hashchange", applyHashView);

/* Boot after all modules (keyboard.js, fallback.js) have parsed. */
function boot() {
  if (S._booted) return;
  S._booted = true;
  if (typeof initShell === "function") initShell();
  wireControls();
  if (typeof initCameraControls === "function") initCameraControls();
  initVizControls();
  if (typeof initPlayback === "function") initPlayback();
  if (typeof initKeyboard === "function") initKeyboard();
  if (typeof initFallback === "function") initFallback();
  startTwinLoop();
  startPolling();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
