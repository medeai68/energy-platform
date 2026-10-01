/* ============================================================
   Energy AI Platform — dashboard logic
   Polls /api/state once per second and renders:
     - 2D digital twin (canvas, animated power flows)
     - KPI tiles, energy mix bar, alerts feed
     - SVG time-series charts (legend, crosshair tooltip, table twin)
     - device drawer with fault injection + AI diagnosis
   ============================================================ */

"use strict";

const $ = (sel) => document.querySelector(sel);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
  range: 0,              // sim-minutes window for the main chart (0 = all)
  tables: new Set(),     // chart keys currently in table mode
  hover: null,           // twin hover device id
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

async function poll() {
  try {
    const r = await fetch("/api/state");
    S.snap = await r.json();
  } catch (e) {
    return; // server briefly unavailable
  }
  renderClock();
  renderOverlay();
  renderKpis();
  renderMix();
  renderAlerts();
  renderMainChart();
  if (S.deviceId) refreshDevice(false);
}

async function refreshDevice(force) {
  try {
    const r = await fetch("/api/device/" + S.deviceId);
    const detail = await r.json();
    if (detail.error) { closeDrawer(); return; }
    const key = JSON.stringify([detail.actual, detail.expected, detail.status,
      detail.faults.map(f => f.active), detail.history.length, detail.anomaly]);
    if (force || key !== S._devKey) { S._devKey = key; S.device = detail; renderDrawer(); }
  } catch (e) { /* ignore */ }
}

setInterval(poll, 1000);
setInterval(() => { if (S.deviceId) refreshDevice(true); }, 5000);

/* ---------------- header clock ---------------- */

function renderClock() {
  const sim = S.snap.sim;
  $("#clock-day").textContent = sim.day;
  $("#clock-time").textContent = sim.time;
  $("#speed-chip").textContent = sim.speed + "×" + (sim.paused ? " paused" : "");
}

function renderOverlay() {
  const sim = S.snap.sim;
  $("#overlay-legend").innerHTML =
    `<span class="sw" style="background:${cssVar("--series-1")}"></span>Solar generation<br>` +
    `<span class="sw" style="background:${cssVar("--series-2")}"></span>Building load<br>` +
    `<span class="sw" style="background:${cssVar("--series-3")}"></span>Grid exchange`;
  $("#overlay-weather").innerHTML =
    `<b>${sim.temp_out}°C</b> · cloud ${Math.round(sim.cloud * 100)}% · ${sim.weather}<br>` +
    (sim.sun > 0.03 ? "☀ day" : "☾ night") + ` · sim day ${sim.day} ${sim.time}`;
}

/* ---------------- KPI tiles ---------------- */

function renderKpis() {
  const k = S.snap.kpis;
  $("#kpi-solar-val").textContent = k.solar_kw.toFixed(1) + " kW";
  $("#kpi-load-val").textContent = k.load_kw.toFixed(1) + " kW";
  const net = k.net_kw;
  $("#kpi-grid-val").textContent = (net >= 0 ? "+" : "−") + Math.abs(net).toFixed(1) + " kW " + (net >= 0 ? "importing" : "exporting");
  $("#kpi-suff-val").textContent = Math.round(k.sufficiency * 100) + "%";

  const delta = (today, yest) => {
    if (yest < 0.5) return "";
    const pct = ((today - yest) / yest) * 100;
    const cls = pct >= 0 ? "up" : "down";
    return ` <span class="${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs yesterday</span>`;
  };
  $("#kpi-solar-sub").innerHTML = `${k.today.solar_kwh.toFixed(0)} kWh today${delta(k.today.solar_kwh, k.yesterday.solar_kwh)}`;
  $("#kpi-load-sub").innerHTML = `${k.today.load_kwh.toFixed(0)} kWh today${delta(k.today.load_kwh, k.yesterday.load_kwh)}`;
  $("#kpi-grid-sub").textContent = `import ${k.today.import_kwh.toFixed(0)} · export ${k.today.export_kwh.toFixed(0)} kWh today`;
  $("#kpi-suff-sub").textContent = `${k.today.solar_kwh.toFixed(0)} kWh solar today`;
}

/* ---------------- energy mix ---------------- */

function renderMix() {
  const el = $("#mix-chart");
  const t = S.snap.kpis.today;
  if (S.tables.has("mix")) { el.innerHTML = mixTableHTML(t); return; }
  const solarUsed = Math.max(0, t.solar_kwh - t.export_kwh);
  const grid = t.import_kwh;
  const total = solarUsed + grid;
  if (total < 0.5) { el.innerHTML = '<p class="alert-empty">No consumption recorded yet.</p>'; return; }
  const sPct = (solarUsed / total) * 100;
  const gPct = (grid / total) * 100;
  el.innerHTML = `
    <div class="mix-bar" role="img" aria-label="Energy mix: solar ${sPct.toFixed(0)} percent, grid ${gPct.toFixed(0)} percent">
      <div class="mix-seg" style="flex:${sPct};background:${cssVar("--series-1")}"></div>
      <div class="mix-seg" style="flex:${gPct};background:${cssVar("--series-3")}"></div>
    </div>
    <div class="mix-legend">
      <span><span class="swatch" style="background:${cssVar("--series-1")}"></span>Solar ${sPct.toFixed(0)}% · ${solarUsed.toFixed(0)} kWh</span>
      <span><span class="swatch" style="background:${cssVar("--series-3")}"></span>Grid ${gPct.toFixed(0)}% · ${grid.toFixed(0)} kWh</span>
      ${t.export_kwh > 0.5 ? `<span>Exported ${t.export_kwh.toFixed(0)} kWh</span>` : ""}
    </div>`;
}

function mixTableHTML(t) {
  const rows = [
    ["Solar (self-consumed)", (t.solar_kwh - t.export_kwh).toFixed(1)],
    ["Grid import", t.import_kwh.toFixed(1)],
    ["Grid export", t.export_kwh.toFixed(1)],
    ["Total load", t.load_kwh.toFixed(1)],
  ];
  return `<table class="mix-table"><thead><tr><th>Source</th><th>kWh today</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("") + `</tbody></table>`;
}

/* ---------------- alerts ---------------- */

function renderAlerts() {
  const ul = $("#alerts");
  const events = S.snap.events;
  $("#alert-count").textContent = S.snap.kpis.anomalies
    ? `${S.snap.kpis.anomalies} active anomaly${S.snap.kpis.anomalies > 1 ? "ies" : ""}` : "";
  if (!events.length) { ul.innerHTML = '<li class="alert-empty">No events yet. Click a device in the twin and inject a fault.</li>'; return; }
  ul.textContent = "";
  for (const ev of events) {
    const li = document.createElement("li");
    li.className = "alert-row" + (ev.severity === "operator" ? " operator" : "");
    const dot = document.createElement("span");
    dot.className = "alert-dot";
    dot.style.background = ev.severity === "operator" ? cssVar("--text-muted") : cssVar(STATUS[ev.severity].color);
    const msg = document.createElement("span");
    msg.className = "alert-msg";
    const b = document.createElement("b");
    b.textContent = ev.device_name;
    msg.append(b, " — " + ev.message.replace(/^[^:]+:\s*/, ""));
    const meta = document.createElement("span");
    meta.className = "alert-meta";
    meta.textContent = `D${ev.day} ${ev.time}`;
    li.append(dot, msg, meta);
    li.addEventListener("click", () => openDrawer(ev.device_id));
    if (ev.severity !== "operator") {
      const btn = document.createElement("button");
      btn.className = "alert-ai";
      btn.textContent = "Ask AI";
      btn.addEventListener("click", (e) => { e.stopPropagation(); openDrawer(ev.device_id); askAI(ev.device_id); });
      li.append(btn);
    }
    ul.append(li);
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

function renderLineChart(container, data) {
  // data: { key, x: [t], series: [{key, label, color, dashed, v: [...]}], height }
  const key = data.key;
  if (S.tables.has(key)) { container.innerHTML = chartTableHTML(data); return; }
  const width = Math.max(container.clientWidth || 600, 320);
  const height = data.height || 240;
  const m = { l: 46, r: 84, t: 12, b: 26 };
  const pw = width - m.l - m.r, ph = height - m.t - m.b;
  const n = data.x.length;
  const allV = data.series.flatMap(s => s.v);
  let yMin = Math.min(0, ...allV), yMax = Math.max(1, ...allV);
  const step = niceStep((yMax - yMin) / 4);
  yMax = Math.ceil(yMax / step) * step;
  yMin = Math.floor(yMin / step) * step;
  const xAt = i => m.l + (n > 1 ? (i / (n - 1)) * pw : 0);
  const yAt = v => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.height = height + "px";

  // gridlines (hairline, solid) + y tick labels
  const yTicks = [];
  for (let v = yMin; v <= yMax + step * 0.01; v += step) yTicks.push(Math.round(v * 100) / 100);
  for (const v of yTicks) {
    const y = yAt(v);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", m.l); line.setAttribute("x2", width - m.r);
    line.setAttribute("y1", y); line.setAttribute("y2", y);
    line.setAttribute("stroke", v === 0 ? cssVar("--baseline") : cssVar("--gridline"));
    line.setAttribute("stroke-width", "1");
    svg.append(line);
    const label = svgText(v.toFixed(v < 10 && v !== 0 ? 1 : 0), m.l - 8, y + 3.5, "end", "11px", cssVar("--text-muted"));
    svg.append(label);
  }

  // x tick labels (5 across)
  for (let k = 0; k <= 4; k++) {
    const i = Math.round((k / 4) * (n - 1));
    const label = svgText(fmtTicks(data.x[i]), xAt(i), height - 8, "middle", "11px", cssVar("--text-muted"));
    svg.append(label);
  }

  // series lines (2px, round) + end dots + end labels
  const endLabels = [];
  for (const s of data.series) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    let d = "";
    for (let i = 0; i < n; i++) d += (i ? "L" : "M") + xAt(i).toFixed(1) + " " + yAt(s.v[i]).toFixed(1);
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", s.color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    if (s.dashed) path.setAttribute("stroke-dasharray", "6 4");
    svg.append(path);
    const ex = xAt(n - 1), ey = yAt(s.v[n - 1]);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", ex); dot.setAttribute("cy", ey); dot.setAttribute("r", "4");
    dot.setAttribute("fill", s.color);
    dot.setAttribute("stroke", cssVar("--surface-1")); dot.setAttribute("stroke-width", "2");
    svg.append(dot);
    endLabels.push({ s, x: width - m.r + 6, y: ey });
  }
  // stack end labels so they never overlap; leader lines when displaced
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y < endLabels[i - 1].y + 14) endLabels[i].y = endLabels[i - 1].y + 14;
  }
  for (const L of endLabels) {
    if (Math.abs(L.y - yAt(L.s.v[n - 1])) > 7) {
      const lead = document.createElementNS("http://www.w3.org/2000/svg", "line");
      lead.setAttribute("x1", xAt(n - 1)); lead.setAttribute("y1", yAt(L.s.v[n - 1]));
      lead.setAttribute("x2", width - m.r + 2); lead.setAttribute("y2", L.y);
      lead.setAttribute("stroke", cssVar("--text-muted")); lead.setAttribute("stroke-width", "1");
      svg.append(lead);
    }
    const txt = svgText(L.s.label + " " + L.s.v[n - 1].toFixed(1), L.x, L.y + 3.5, "start", "11px", cssVar("--text-secondary"));
    txt.setAttribute("font-weight", "600");
    svg.append(txt);
  }

  // legend (always for >= 2 series)
  if (data.series.length >= 2) {
    const legend = document.createElementNS("http://www.w3.org/2000/svg", "g");
    legend.setAttribute("transform", `translate(${m.l + 4}, 14)`);
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
    svg.append(legend);
  }

  // crosshair overlay (full plot area = generous hit target)
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  overlay.setAttribute("x", m.l); overlay.setAttribute("y", m.t);
  overlay.setAttribute("width", pw); overlay.setAttribute("height", ph);
  overlay.setAttribute("fill", "transparent");
  const cross = document.createElementNS("http://www.w3.org/2000/svg", "line");
  cross.setAttribute("y1", m.t); cross.setAttribute("y2", m.t + ph);
  cross.setAttribute("stroke", cssVar("--text-muted")); cross.setAttribute("stroke-width", "1");
  cross.style.display = "none";
  const crossDots = data.series.map(s => {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("r", "4"); c.setAttribute("fill", s.color);
    c.setAttribute("stroke", cssVar("--surface-1")); c.setAttribute("stroke-width", "2");
    c.style.display = "none";
    svg.append(c);
    return c;
  });
  svg.append(cross, overlay);

  const tip = document.createElement("div");
  tip.className = "twin-tip";
  tip.style.display = "none";
  tip.style.position = "absolute";
  tip.style.pointerEvents = "none";
  container.style.position = "relative";
  container.append(tip);

  const showAt = (i) => {
    cross.style.display = "";
    cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i));
    data.series.forEach((s, k) => {
      crossDots[k].style.display = "";
      crossDots[k].setAttribute("cx", xAt(i));
      crossDots[k].setAttribute("cy", yAt(s.v[i]));
    });
    tip.style.display = "";
    tip.innerHTML = `<div class="tip-name">${fmtTime(data.x[i])}</div>` +
      data.series.map(s =>
        `<div class="tip-row"><span style="display:inline-block;width:14px;height:3px;background:${s.color};margin-right:5px;vertical-align:middle"></span>` +
        `${escapeHTML(s.label)}: <b style="color:${cssVar("--text-primary")}">${s.v[i].toFixed(1)} kW</b></div>`).join("");
    const px = (i / (n - 1)) * pw;
    tip.style.left = Math.min(px + m.l + 12, width - 190) + "px";
    tip.style.top = Math.max(yAt(Math.max(...data.series.map(s => s.v[i]))) - 8, 4) + "px";
  };
  const hide = () => { cross.style.display = "none"; crossDots.forEach(c => c.style.display = "none"); tip.style.display = "none"; };
  overlay.addEventListener("mousemove", (e) => {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left - m.l;
    const i = Math.max(0, Math.min(n - 1, Math.round((x / pw) * (n - 1))));
    showAt(i);
    S._mainHover = { key, i };
  });
  overlay.addEventListener("mouseleave", hide);

  container.textContent = "";
  container.append(svg, tip);
  if (S._mainHover && S._mainHover.key === key && S._mainHover.i < n) showAt(S._mainHover.i);
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

function chartTableHTML(data) {
  const rows = [];
  const step = Math.max(1, Math.floor(data.x.length / 24));
  for (let i = data.x.length - 1; i >= 0; i -= step) {
    rows.push(`<tr><td>${fmtTime(data.x[i])}</td>` +
      data.series.map(s => `<td>${s.v[i].toFixed(1)}</td>`).join("") + `</tr>`);
  }
  return `<table class="chart-table"><thead><tr><th>Time</th>` +
    data.series.map(s => `<th>${escapeHTML(s.label)} (kW)</th>`).join("") +
    `</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- main chart ---------------- */

function renderMainChart() {
  const h = S.snap.history;
  if (h.length < 2) return;
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
    x: rows.map(p => p.t),
    series: [
      { key: "solar", label: "Solar generation", color: cssVar("--series-1"), v: rows.map(p => p.solar) },
      { key: "load", label: "Building load", color: cssVar("--series-2"), v: rows.map(p => p.load) },
      { key: "grid", label: "Grid exchange", color: cssVar("--series-3"), v: rows.map(p => p.grid) },
    ],
    height: 240,
  });
}

/* ============================================================
   2D digital twin (canvas)
   ============================================================ */

const TWIN = { W: 980, H: 560 };
const zones = {};   // device_id -> {x, y, w, h} filled during draw

function panelStep(f) {
  // Sequential blue ramp; dark mode anchors low->dark, high->light (flipped).
  const dark = document.documentElement.dataset.theme !== "light";
  const steps = ["--seq-700", "--seq-600", "--seq-450", "--seq-400", "--seq-250", "--seq-100"];
  const i = Math.max(0, Math.min(5, Math.round(f * 5)));
  return cssVar(steps[dark ? i : 5 - i]);
}

function drawTwin(now) {
  const cv = $("#twin");
  const ctx = cv.getContext("2d");
  const snap = S.snap;
  const dark = document.documentElement.dataset.theme !== "light";
  ctx.clearRect(0, 0, TWIN.W, TWIN.H);
  if (!snap) return;
  const devs = {};
  for (const d of snap.devices) devs[d.id] = d;
  const sim = snap.sim;
  const hour = sim.minutes / 60;
  const ink = cssVar("--text-primary"), ink2 = cssVar("--text-secondary");
  const surface = cssVar("--surface-1");

  // --- sky ---
  const sky = ctx.createLinearGradient(0, 0, 0, 168);
  sky.addColorStop(0, cssVar("--twin-sky-top"));
  sky.addColorStop(1, cssVar("--twin-sky-bottom"));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, TWIN.W, TWIN.H);
  // stars at night
  if (sim.sun < 0.15) {
    ctx.fillStyle = dark ? "rgba(255,255,255,0.7)" : "rgba(40,60,90,0.7)";
    for (let i = 0; i < 26; i++) {
      const sx = (i * 137 + 40) % 940, sy = (i * 83 + 17) % 120;
      ctx.beginPath(); ctx.arc(sx, sy, 1.3, 0, 7); ctx.fill();
    }
  }
  // sun / moon
  if (sim.sun > 0.03) {
    const sx = 130 + 720 * ((hour - 5.5) / 13);
    const sy = 150 - 95 * Math.sin(Math.PI * ((hour - 6) / 12.5));
    const g = ctx.createRadialGradient(sx, sy, 4, sx, sy, 34);
    g.addColorStop(0, "rgba(247,209,84,0.95)");
    g.addColorStop(1, "rgba(247,209,84,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, 34, 0, 7); ctx.fill();
    ctx.fillStyle = "#f7d154"; ctx.beginPath(); ctx.arc(sx, sy, 14, 0, 7); ctx.fill();
  } else {
    ctx.fillStyle = dark ? "#d8d8d0" : "#8b8b85";
    ctx.beginPath(); ctx.arc(760, 60, 14, 0, 7); ctx.fill();
    ctx.fillStyle = cssVar("--twin-sky-bottom");
    ctx.beginPath(); ctx.arc(754, 56, 12, 0, 7); ctx.fill();
  }
  // clouds
  for (let i = 0; i < 4; i++) {
    const cx = (i * 250 + 120 + ((now / 9000) * (i + 1) * 30) % 300) % 1000;
    const cy = 52 + (i % 3) * 34;
    ctx.fillStyle = `rgba(${dark ? "220,225,232" : "120,130,140"},${0.55 * sim.cloud})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 62, 17, 0, 0, 7);
    ctx.ellipse(cx + 34, cy + 6, 40, 13, 0, 0, 7);
    ctx.fill();
  }

  // --- building ---
  ctx.fillStyle = cssVar("--twin-building");
  ctx.strokeStyle = cssVar("--twin-building-edge");
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(95, 168, 730, 132); ctx.fill(); ctx.stroke();      // roof band
  ctx.beginPath(); ctx.rect(110, 300, 700, 245); ctx.fill(); ctx.stroke();      // walls
  ctx.fillStyle = cssVar("--page");                                            // ground
  ctx.fillRect(60, 546, 880, 14);
  // interior zone dividers
  ctx.strokeStyle = cssVar("--twin-building-edge");
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(272, 300); ctx.lineTo(272, 545);
  ctx.moveTo(562, 300); ctx.lineTo(562, 545);
  ctx.stroke();

  // --- solar array (48 panels, sequential fill by generation) ---
  const array = devs.solar;
  const f = Math.max(0, Math.min(1, array.actual / array.rating));
  const pw = 50, ph = 22, gx = 4, gy = 4, cols = 12, rows = 4;
  const ax0 = 95 + (730 - (cols * pw + (cols - 1) * gx)) / 2, ay0 = 184;
  const panelColor = panelStep(f);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = panelColor;
      ctx.beginPath();
      ctx.rect(ax0 + c * (pw + gx), ay0 + r * (ph + gy), pw, ph);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  zones.solar = { x: ax0, y: ay0, w: cols * pw + (cols - 1) * gx, h: rows * ph + (rows - 1) * gy };

  // --- power lines (animated dashes show direction) ---
  const dashOffset = (now / 40) % 60;
  const lineW = (kw) => Math.max(1.5, Math.min(5, 1.5 + kw / 14));
  // DC: array -> inverter
  ctx.strokeStyle = cssVar("--series-1");
  ctx.lineWidth = lineW(array.actual);
  ctx.setLineDash([11, 9]);
  ctx.lineDashOffset = dashOffset;
  ctx.beginPath();
  ctx.moveTo(250, 284); ctx.lineTo(250, 340); ctx.lineTo(197, 340); ctx.lineTo(197, 390);
  ctx.stroke();
  // AC bus: inverter -> loads
  ctx.strokeStyle = cssVar("--series-2");
  ctx.lineWidth = lineW(snap.kpis.load_kw);
  ctx.beginPath();
  ctx.moveTo(245, 390); ctx.lineTo(245, 330); ctx.lineTo(770, 330);
  ctx.moveTo(345, 330); ctx.lineTo(345, 352);
  ctx.moveTo(480, 330); ctx.lineTo(480, 352);
  ctx.moveTo(680, 330); ctx.lineTo(680, 442);
  ctx.moveTo(460, 330); ctx.lineTo(460, 318);
  ctx.stroke();
  // grid: building <-> pole
  const net = snap.grid.net_kw;
  ctx.strokeStyle = cssVar("--series-3");
  ctx.lineWidth = lineW(Math.abs(net));
  ctx.lineDashOffset = net >= 0 ? -dashOffset : dashOffset; // flow direction
  ctx.beginPath(); ctx.moveTo(770, 330); ctx.lineTo(912, 330); ctx.stroke();
  ctx.setLineDash([]);
  // grid pole
  ctx.strokeStyle = ink2;
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(912, 330); ctx.lineTo(912, 556); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(884, 340); ctx.lineTo(940, 340); ctx.stroke();
  ctx.fillStyle = cssVar("--twin-building");
  ctx.beginPath(); ctx.rect(894, 396, 36, 26); ctx.fill();
  ctx.strokeStyle = cssVar("--twin-building-edge"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(894, 396, 36, 26); ctx.stroke();

  // --- inverter ---
  const inv = devs.inverter;
  ctx.fillStyle = cssVar("--surface-2");
  ctx.strokeStyle = cssVar("--twin-building-edge");
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(150, 390, 95, 80); ctx.fill(); ctx.stroke();
  ctx.fillStyle = ink2; ctx.font = "600 11px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("INVERTER", 197, 405);
  ctx.fillStyle = ink;
  ctx.font = "700 14px system-ui";
  ctx.fillText(inv.actual.toFixed(1) + " kW", 197, 424);
  ctx.fillStyle = ink2; ctx.font = "11px system-ui";
  ctx.fillText("η " + (inv.extra.efficiency != null ? (inv.extra.efficiency * 100).toFixed(0) + "%" : "—"), 197, 441);
  ctx.textAlign = "left";
  ctx.font = "11px system-ui";
  ctx.fillText("Inverter 50 kW", 125, 495);
  zones.inverter = { x: 150, y: 390, w: 95, h: 80 };

  // --- HVAC units (rotating fans) ---
  const hvac = devs.hvac;
  const duty = hvac.extra.duty || 0;
  const fanAngle = (now / 220) * (0.4 + duty * 2.2);
  for (let u = 0; u < 3; u++) {
    const ux = 290 + u * 95, uy = 352;
    ctx.fillStyle = cssVar("--surface-2");
    ctx.strokeStyle = cssVar("--twin-building-edge");
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(ux, uy, 80, 108); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ink2; ctx.font = "10px system-ui"; ctx.textAlign = "center";
    ctx.fillText("AC-" + (u + 1), ux + 40, uy + 96);
    // fan
    const fx = ux + 40, fy = uy + 42;
    ctx.strokeStyle = cssVar("--twin-building-edge");
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(fx, fy, 24, 0, 7); ctx.stroke();
    ctx.strokeStyle = duty > 0.03 ? cssVar("--series-2") : cssVar("--text-muted");
    ctx.lineWidth = 2.5;
    for (let b = 0; b < 3; b++) {
      const a = fanAngle + (b * Math.PI * 2) / 3;
      ctx.beginPath(); ctx.arc(fx, fy, 17, a, a + 0.85); ctx.stroke();
    }
  }
  ctx.textAlign = "left";
  ctx.fillStyle = ink2; ctx.font = "11px system-ui";
  ctx.fillText(`HVAC × 3 · ${Math.round(duty * 100)}% duty`, 285, 486);
  zones.hvac = { x: 290, y: 352, w: 268, h: 118 };

  // --- lighting fixtures (glow when on) ---
  const lit = devs.lighting;
  const litFrac = Math.min(1, lit.actual / lit.rating);
  for (let i = 0; i < 5; i++) {
    const lx = 160 + i * 150, ly = 318;
    if (litFrac > 0.03) {
      const g = ctx.createRadialGradient(lx, ly + 14, 4, lx, ly + 14, 42);
      g.addColorStop(0, `rgba(250,219,25,${0.34 * litFrac})`);
      g.addColorStop(1, "rgba(250,219,25,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(lx, ly + 14, 42, 0, 7); ctx.fill();
    }
    ctx.fillStyle = litFrac > 0.03 ? "#fadb19" : ink2;
    ctx.beginPath(); ctx.arc(lx, ly, 4, 0, 7); ctx.fill();
  }
  ctx.fillStyle = ink2; ctx.font = "11px system-ui";
  ctx.fillText("Lighting 6 kW", 120, 306 - 14);
  zones.lighting = { x: 120, y: 292, w: 690, h: 26 };

  // --- plug loads (desks) ---
  for (let r = 0; r < 3; r++) {
    ctx.fillStyle = cssVar("--surface-2");
    ctx.strokeStyle = cssVar("--twin-building-edge");
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(585, 445 + r * 34, 190, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ink2;
    ctx.fillRect(585, 450 + r * 34, 190, 5); // monitor strip
  }
  ctx.fillStyle = ink2; ctx.font = "11px system-ui";
  ctx.fillText("Plug Loads 9 kW", 585, 496 + 34);
  zones.plugs = { x: 585, y: 442, w: 195, h: 100 };

  // --- labels on roof ---
  ctx.fillStyle = ink2; ctx.textAlign = "center"; ctx.font = "11px system-ui";
  ctx.fillText("Solar Array 50 kWp", 455, 296);
  ctx.textAlign = "left";

  // --- status dots (icon + label) ---
  for (const [id, zone] of Object.entries(zones)) {
    const d = devs[id];
    if (!d) continue;
    const st = STATUS[d.status] || STATUS.ok;
    let dx, dy;
    if (id === "solar") { dx = zone.x + zone.w - 4; dy = zone.y - 10; }
    else if (id === "inverter") { dx = zone.x + zone.w - 10; dy = zone.y - 10; }
    else if (id === "hvac") { dx = zone.x + zone.w - 8; dy = zone.y - 10; }
    else if (id === "lighting") { dx = zone.x + zone.w - 8; dy = zone.y - 10; }
    else { dx = zone.x + zone.w - 8; dy = zone.y - 10; }
    ctx.fillStyle = cssVar(st.color);
    ctx.beginPath(); ctx.arc(dx, dy, 5, 0, 7); ctx.fill();
    ctx.strokeStyle = surface; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(dx, dy, 5, 0, 7); ctx.stroke();
  }

  // --- selection / hover outlines ---
  const highlight = S.hover || S.deviceId;
  if (highlight && zones[highlight]) {
    const z = zones[highlight];
    ctx.strokeStyle = highlight === S.deviceId ? ink : cssVar("--text-muted");
    ctx.lineWidth = highlight === S.deviceId ? 2 : 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.rect(z.x - 6, z.y - 6, z.w + 12, z.h + 12); ctx.stroke();
    ctx.setLineDash([]);
  }

}

function twinHit(px, py) {
  // device zones in canvas coords; return device id or null
  const order = ["solar", "lighting", "hvac", "plugs", "inverter"];
  for (const id of order) {
    const z = zones[id];
    if (z && px >= z.x - 6 && px <= z.x + z.w + 6 && py >= z.y - 6 && py <= z.y + z.h + 6) return id;
  }
  return null;
}

function startTwinLoop() {
  const cv = $("#twin");
  const tip = $("#twin-tip");
  const wrap = $("#twin-wrap");
  const loop = (now) => { drawTwin(now); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  cv.addEventListener("mousemove", (e) => {
    const rect = cv.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * TWIN.W;
    const py = ((e.clientY - rect.top) / rect.height) * TWIN.H;
    const id = twinHit(px, py);
    S.hover = id;
    cv.style.cursor = id ? "pointer" : "default";
    if (!id || !S.snap) { tip.classList.add("hidden"); return; }
    const d = S.snap.devices.find(x => x.id === id);
    const st = STATUS[d.status] || STATUS.ok;
    tip.classList.remove("hidden");
    tip.innerHTML = `<div class="tip-name">${escapeHTML(d.name)}</div>
      <div class="tip-row">${d.actual.toFixed(1)} kW actual · ${d.expected.toFixed(1)} kW expected</div>
      <div class="tip-row">status: <span style="color:${cssVar(st.color)}">${st.glyph} ${st.label}</span></div>`;
    const sx = e.clientX - wrap.getBoundingClientRect().left;
    const sy = e.clientY - wrap.getBoundingClientRect().top;
    tip.style.left = Math.min(sx + 14, wrap.clientWidth - 230) + "px";
    tip.style.top = Math.max(sy - 60, 4) + "px";
  });
  cv.addEventListener("mouseleave", () => { S.hover = null; tip.classList.add("hidden"); });
  cv.addEventListener("click", (e) => {
    const rect = cv.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * TWIN.W;
    const py = ((e.clientY - rect.top) / rect.height) * TWIN.H;
    const id = twinHit(px, py);
    if (id) openDrawer(id);
  });
}

/* ============================================================
   Device drawer
   ============================================================ */

function openDrawer(id) {
  S.deviceId = id;
  S._devKey = null;
  $("#device-drawer").classList.remove("hidden");
  refreshDevice(true);
}

function closeDrawer() {
  S.deviceId = null;
  S.device = null;
  S.aiResult = null;
  $("#device-drawer").classList.add("hidden");
}

const EXTRA_LABELS = {
  ghi: ["Irradiance", ""], cell_temp: ["Cell temp", "°C"],
  dc_in: ["DC input", "kW"], efficiency: ["Efficiency", ""],
  duty: ["Cooling duty", ""], units_online: ["Units online", ""],
  dimming: ["Dimming level", ""], occupancy: ["Occupancy", ""],
};

function renderDrawer() {
  const d = S.device;
  if (!d) return;
  $("#dev-name").textContent = d.name;
  const st = STATUS[d.status] || STATUS.ok;
  const body = $("#dev-body");
  body.textContent = "";

  // status row
  const row = document.createElement("div");
  row.className = "dev-status-row";
  const badge = document.createElement("span");
  badge.className = "status-badge";
  badge.style.color = cssVar(st.color);
  badge.style.borderColor = cssVar(st.color);
  badge.innerHTML = `<span class="dot" style="background:${cssVar(st.color)}"></span>${st.glyph} ${st.label}`;
  const big = document.createElement("span");
  big.className = "dev-big";
  big.textContent = `${d.actual.toFixed(1)} kW `;
  const small = document.createElement("small");
  small.textContent = `actual · ${d.expected.toFixed(1)} kW expected (${d.rating} kW rated)`;
  big.append(small);
  row.append(badge, big);
  body.append(row);

  // extra fields
  const extras = Object.entries(d.extra || {});
  if (extras.length) {
    const block = document.createElement("div");
    block.className = "dev-block";
    block.innerHTML = "<h3>Live telemetry</h3>";
    const grid = document.createElement("div");
    grid.className = "extra-grid";
    for (const [k, v] of extras) {
      const [label, unit] = EXTRA_LABELS[k] || [k, ""];
      let text = v;
      if (k === "efficiency" && v != null) text = (v * 100).toFixed(0) + "%";
      if (k === "duty" && v != null) text = (v * 100).toFixed(0) + "%";
      if (k === "dimming" && v != null) text = (v * 100).toFixed(0) + "%";
      if (k === "occupancy" && v != null) text = (v * 100).toFixed(0) + "%";
      grid.innerHTML += `<span class="k">${escapeHTML(label)}</span><span class="v">${v == null ? "—" : escapeHTML(String(text)) + (unit ? " " + unit : "")}</span>`;
    }
    block.append(grid);
    body.append(block);
  }

  // fault injection
  const fb = document.createElement("div");
  fb.className = "dev-block";
  fb.innerHTML = "<h3>Virtual fault injection</h3>";
  for (const f of d.faults) {
    const rowF = document.createElement("div");
    rowF.className = "fault-row";
    const fst = STATUS[f.severity] || STATUS.warning;
    rowF.innerHTML = `<div class="fault-info">
        <div class="fault-name">${escapeHTML(f.name)} <span class="conf-note" style="color:${cssVar(fst.color)}">${fst.glyph} ${fst.label}</span></div>
        <div class="fault-desc">${escapeHTML(f.description)}</div>
      </div>`;
    const btn = document.createElement("button");
    btn.className = "fault-btn " + (f.active ? "clear" : "inject");
    btn.textContent = f.active ? "✓ Clear" : "Inject";
    btn.addEventListener("click", async () => {
      await fetch("/api/fault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: d.id, fault_id: f.id, active: !f.active }),
      });
      refreshDevice(true);
    });
    rowF.append(btn);
    fb.append(rowF);
  }
  body.append(fb);

  // expected vs actual chart
  const ch = document.createElement("div");
  ch.className = "dev-block";
  ch.innerHTML = `<h3>Expected vs actual · kW <button class="table-toggle" style="float:right" data-table="dev">table</button></h3>`;
  wireTableToggle(ch.querySelector(".table-toggle"));
  const chartEl = document.createElement("div");
  chartEl.className = "chart";
  ch.append(chartEl);
  body.append(ch);
  const hist = d.history;
  if (hist.length >= 2) {
    renderLineChart(chartEl, {
      key: "dev",
      x: hist.map(p => p.t),
      series: [
        { key: "actual", label: "Actual", color: cssVar("--series-1"), v: hist.map(p => p.actual) },
        { key: "expected", label: "Expected", color: cssVar("--series-2"), dashed: true, v: hist.map(p => p.expected) },
      ],
      height: 190,
    });
  } else {
    chartEl.innerHTML = '<p class="alert-empty">Collecting data…</p>';
  }

  // AI diagnosis
  const ai = document.createElement("div");
  ai.className = "dev-block";
  ai.innerHTML = "<h3>AI diagnosis</h3>";
  const box = document.createElement("div");
  box.className = "ai-box";
  const btn = document.createElement("button");
  btn.className = "ai-primary";
  btn.textContent = "✨ Ask AI to diagnose";
  btn.addEventListener("click", () => askAI(d.id));
  box.append(btn);
  if (d.anomaly) {
    const note = document.createElement("p");
    note.className = "alert-empty";
    note.innerHTML = `Active anomaly: <b>${escapeHTML(d.anomaly.message)}</b>`;
    box.append(note);
  } else {
    const note = document.createElement("p");
    note.className = "alert-empty";
    note.textContent = "No active anomaly. Inject a fault above, wait a few seconds for detection, then ask the AI.";
    box.append(note);
  }
  ai.append(box);
  body.append(ai);

  if (S.aiResult && S.aiResult.device_id === d.id) renderAIResult(body);
}

async function askAI(deviceId) {
  const btn = document.querySelector(".ai-primary");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Diagnosing…"; }
  try {
    const r = await fetch("/api/ai/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
    });
    const res = await r.json();
    S.aiResult = { device_id: deviceId, diagnosis: res.diagnosis };
    renderDrawer();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "✨ Ask AI to diagnose"; }
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
}

/* ---------------- controls ---------------- */

async function postControl(action, value) {
  await fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value }),
  });
}

function wireControls() {
  $("#speed").addEventListener("change", (e) => postControl("speed", parseInt(e.target.value, 10)));
  $("#weather").addEventListener("change", (e) => postControl("weather", e.target.value));
  $("#pause-btn").addEventListener("click", () => {
    const paused = S.snap && S.snap.sim.paused;
    postControl("pause", !paused);
    $("#pause-btn").textContent = paused ? "⏸ Pause" : "▶ Resume";
  });
  $("#reset-btn").addEventListener("click", () => {
    if (confirm("Reset the simulation? All faults and alerts will be cleared.")) {
      postControl("reset", true);
      closeDrawer();
    }
  });
  $("#theme-btn").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    S._mainHover = null;
    renderMainChart();
    if (S.device) renderDrawer();
    renderMix();
    renderOverlay();
  });
  $("#drawer-close").addEventListener("click", closeDrawer);

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

wireControls();
startTwinLoop();
poll();
