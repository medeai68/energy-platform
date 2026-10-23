/* ============================================================
   Energy visualization modes for the 3D twin
   ------------------------------------------------------------
   Modes: status · energy · alerts · health · data · heatmap
   Colors (validated with the dataviz palette validator on the dark
   stage surface #121317):
     - energy ramp: single amber hue, monotone lightness, all steps
       >= 2.5:1 vs the surface (ordinal checks PASS)
     - availability: live #199e70, imported #3987e5, simulated #c98500
       (all-pairs CVD PASS); unavailable is neutral grey + icon
     - status/alerts/health bands use the reserved status palette
       (CSS --good/--warning/--serious/--critical) and always ship with
       a glyph + label, never color alone.
   Aggregation rules (single implementation, used by every level):
     - a room sums the devices that live in it
     - a floor sums its rooms plus its own FCU
     - a building sums the UNIQUE set of its devices (rooms + FCU +
       building equipment), so room-hosted system leaves count once
     - the campus sums its buildings
     - roll-up plant devices (hvac/lighting/plugs/systems) are never
       added to these sums - they are derived aggregates of the leaves.
   Energy intensity is explicitly NOT a fault signal: faults are judged
   on expected-vs-actual baselines in the alerts/health modes.
   ============================================================ */

"use strict";

const VIZ_MODES = [
  { id: "status", label: "Status", title: "Normal equipment status" },
  { id: "energy", label: "Energy", title: "Energy consumption intensity" },
  { id: "alerts", label: "Alerts", title: "Abnormal consumption alerts" },
  { id: "health", label: "Health", title: "Equipment health / diagnostics" },
  { id: "data", label: "Data", title: "Data availability" },
  { id: "heatmap", label: "Heatmap", title: "Room / floor energy heatmap with historical playback" },
];

const VIZ = {
  mode: "status",
  cache: null,
  // sequential amber ramp: dim (low) -> bright (high)
  ENERGY_RAMP: ["#6b5124", "#8a642b", "#ad7e33", "#d29a3f", "#f5bd5e"],
  AVAIL: {
    live: "#199e70",
    imported: "#3987e5",
    simulated: "#c98500",
    unavailable: "#6b7280",
  },
  STATUS_HEALTH: { ok: 100, warning: 70, serious: 35, critical: 0 },
  SEV_RANK: { ok: 0, warning: 1, serious: 2, critical: 3 },
  HEALTH_BANDS: [
    { min: 85, key: "ok", label: "Good", glyph: "✓" },
    { min: 65, key: "warning", label: "Fair", glyph: "▲" },
    { min: 40, key: "serious", label: "Poor", glyph: "●" },
    { min: -1, key: "critical", label: "Critical", glyph: "✕" },
  ],
};

function vizStatusColor(key) {
  const map = { ok: "--good", warning: "--warning", serious: "--serious", critical: "--critical" };
  return cssVar(map[key] || "--good");
}

function vizHealthBand(score) {
  for (const band of VIZ.HEALTH_BANDS) if (score >= band.min) return band;
  return VIZ.HEALTH_BANDS[VIZ.HEALTH_BANDS.length - 1];
}

function vizHealthColor(score) {
  return vizStatusColor(vizHealthBand(score).key);
}

/* ---------- aggregation (single implementation for every level) ---------- */

/* Unique devices belonging to a room, floor or building. */
function vizDevicesOf(space) {
  if (!space) return [];
  if (Array.isArray(space.devices)) return space.devices;          // room
  const byId = new Map();
  if (Array.isArray(space.rooms)) {                                // floor
    for (const r of space.rooms) for (const d of r.devices || []) byId.set(d.id, d);
    if (space.fcu) byId.set(space.fcu.id, space.fcu);
  } else if (Array.isArray(space.floors)) {                        // building
    for (const f of space.floors) {
      for (const r of f.rooms || []) for (const d of r.devices || []) byId.set(d.id, d);
      if (f.fcu) byId.set(f.fcu.id, f.fcu);
    }
    for (const d of space.equipment || []) byId.set(d.id, d);
  }
  return [...byId.values()];
}

function vizHealth(d) {
  return VIZ.STATUS_HEALTH[d.status] != null ? VIZ.STATUS_HEALTH[d.status] : 100;
}

function vizSpaceHealth(space) {
  const devs = vizDevicesOf(space);
  if (!devs.length) return 100;
  return devs.reduce((s, d) => s + vizHealth(d), 0) / devs.length;
}

function vizSpaceSeverity(space) {
  let worst = "ok";
  for (const d of vizDevicesOf(space)) {
    const s = d.status || "ok";
    if (VIZ.SEV_RANK[s] > VIZ.SEV_RANK[worst]) worst = s;
  }
  return worst;
}

function vizSpaceAvail(space, avail) {
  const devs = vizDevicesOf(space);
  let worst = null, worstRank = -1, stale = false, sources = new Set();
  for (const d of devs) {
    const a = avail[d.id];
    if (!a) {
      if (worstRank < 3) { worstRank = 3; worst = { key: "unavailable" }; }
      continue;
    }
    const src = a.source || "simulated";
    sources.add(src);
    if (a.age_seconds > 30) {
      stale = true;
      if (worstRank < 2) { worstRank = 2; worst = { key: src, source: src }; }
    } else if (worstRank < 1) {
      worstRank = 1; worst = { key: src, source: src };
    }
  }
  if (!worst) return { key: "unavailable", source: null, stale: false };
  return { key: worst.key, source: worst.source || (sources.size ? [...sources][0] : null), stale };
}

/* ---------- color scales ---------- */

function vizRampColor(value, max) {
  if (!(max > 0)) return VIZ.ENERGY_RAMP[0];
  const t = Math.max(0, Math.min(1, value / max));
  const i = Math.min(VIZ.ENERGY_RAMP.length - 1,
    Math.floor(t * (VIZ.ENERGY_RAMP.length - 1) + 1e-9));
  return VIZ.ENERGY_RAMP[i];
}

/* ---------- cache (recomputed once per snapshot + mode) ---------- */

function vizEnsure() {
  if (typeof S === "undefined" || !S.snap) return null;
  const snap = S.snap;
  const pbRev = (typeof playbackRevision === "function") ? playbackRevision() : "live";
  if (VIZ.cache && VIZ.cache.snap === snap && VIZ.cache.mode === VIZ.mode
      && VIZ.cache.pbRev === pbRev) return VIZ.cache;
  const avail = snap.availability || {};
  let maxDev = 0, maxSpace = 0;
  for (const d of snap.equipment || []) {
    maxDev = Math.max(maxDev, d.energy_today_kwh || 0);
  }
  const playback = (typeof playbackActive === "function") && playbackActive();
  if (VIZ.mode === "heatmap" && playback) {
    // fixed day-maximum so colours do not rescale while scrubbing
    maxSpace = playbackMaxIntensity();
  } else {
    for (const b of snap.buildings || []) {
      const spaces = [b, ...(b.floors || [])];
      for (const f of b.floors || []) spaces.push(...(f.rooms || []));
      for (const s of spaces) {
        const area = s.area || 0;
        if (area > 0) maxSpace = Math.max(maxSpace, (s.energy_today_kwh || 0) / area);
      }
    }
  }
  VIZ.cache = { snap, mode: VIZ.mode, pbRev, avail, maxDev, maxSpace };
  return VIZ.cache;
}

/* ---------- device-level styles (scene overlay dots) ---------- */

function vizDeviceColor(d) {
  const c = vizEnsure();
  if (!c || !d) return null;
  switch (VIZ.mode) {
    case "energy":
      return vizRampColor(d.energy_today_kwh || 0, c.maxDev);
    case "health":
      return vizHealthColor(vizHealth(d));
    case "alerts":
      return d.status && d.status !== "ok" ? vizStatusColor(d.status) : null;
    case "data": {
      const a = c.avail[d.id];
      if (!a) return VIZ.AVAIL.unavailable;
      return VIZ.AVAIL[a.source || "simulated"] || VIZ.AVAIL.unavailable;
    }
    default:
      return null; // status mode keeps the existing equipment glyph language
  }
}

/* Small colored marker drawn next to a device glyph in the 3D scene.
   Accepts a device object or a device id (resolved from the snapshot). */
function vizDeviceMarker(ctx, x, y, devOrId, now) {
  const dev = typeof devOrId === "string" ? findTwinDevice(devOrId) : devOrId;
  const c = vizDeviceColor(dev);
  if (!c) return;
  const pulse = VIZ.mode === "alerts" ? 1 + 0.25 * Math.sin((now || 0) / 260) : 1;
  const r = 2.6 * pulse;
  ctx.save();
  ctx.fillStyle = c;
  ctx.strokeStyle = "rgba(8, 10, 14, 0.85)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/* ---------- space-level styles (room / floor / building tints + chips) ---------- */

function vizSpaceColor(space) {
  const c = vizEnsure();
  if (!c || !space) return null;
  switch (VIZ.mode) {
    case "energy": {
      const area = space.area || 0;
      if (area <= 0) return null;
      return vizRampColor((space.energy_today_kwh || 0) / area, c.maxSpace);
    }
    case "heatmap": {
      const area = space.area || 0;
      if (area <= 0) return null;
      if (typeof playbackActive === "function" && playbackActive()) {
        const entry = playbackSpaceValue(space);
        // A bucket without coverage stays neutral: no data is not zero.
        if (!entry || entry.intensity_kwh_m2 == null) return null;
        return vizRampColor(entry.intensity_kwh_m2, c.maxSpace);
      }
      return vizRampColor((space.energy_today_kwh || 0) / area, c.maxSpace);
    }
    case "health":
      return vizHealthColor(vizSpaceHealth(space));
    case "alerts": {
      const sev = vizSpaceSeverity(space);
      return sev === "ok" ? null : vizStatusColor(sev);
    }
    case "data": {
      const a = vizSpaceAvail(space, c.avail);
      if (a.key === "unavailable") return VIZ.AVAIL.unavailable;
      return VIZ.AVAIL[a.source || "simulated"] || VIZ.AVAIL.unavailable;
    }
    default:
      return null;
  }
}

/* Chip value shown for a space in the current mode (null = default kW).
   `compact` is used for the smaller floor/building chips. */
function vizSpaceChip(space, compact) {
  const c = vizEnsure();
  if (!c || !space) return null;
  switch (VIZ.mode) {
    case "energy": {
      const area = space.area || 0;
      const kwh = space.energy_today_kwh || 0;
      if (compact) return area > 0 ? `${(kwh / area).toFixed(2)} kWh/m²` : `${kwh.toFixed(1)} kWh`;
      return area > 0
        ? `${kwh.toFixed(1)} kWh · ${(kwh / area).toFixed(2)} kWh/m²`
        : `${kwh.toFixed(1)} kWh`;
    }
    case "heatmap": {
      const area = space.area || 0;
      if (area <= 0) return "no area";
      if (typeof playbackActive === "function" && playbackActive()) {
        const entry = playbackSpaceValue(space);
        if (!entry || entry.energy_kwh == null || entry.intensity_kwh_m2 == null) {
          return "no data";
        }
        const kwh = entry.energy_kwh;
        const intensity = entry.intensity_kwh_m2;
        return compact
          ? `${intensity.toFixed(3)} kWh/m²`
          : `${kwh.toFixed(2)} kWh · ${intensity.toFixed(3)} kWh/m²`;
      }
      const kwh = space.energy_today_kwh || 0;
      return compact
        ? `${(kwh / area).toFixed(2)} kWh/m²`
        : `${kwh.toFixed(1)} kWh · ${(kwh / area).toFixed(2)} kWh/m²`;
    }
    case "alerts": {
      const sev = vizSpaceSeverity(space);
      if (sev === "ok") return compact ? "no alerts" : "no active alerts";
      const n = space.anomalies || 1;
      const label = { warning: "warning", serious: "serious", critical: "critical" }[sev] || sev;
      return `${n} alert${n > 1 ? "s" : ""} · ${label}`;
    }
    case "health":
      return `health ${Math.round(vizSpaceHealth(space))}`;
    case "data": {
      const a = vizSpaceAvail(space, c.avail);
      if (a.key === "unavailable") return "no data";
      return `${a.source || "simulated"}${a.stale ? " · stale" : " · fresh"}`;
    }
    default:
      return null;
  }
}

/* Chip dot color for a space (null = caller's default). */
function vizSpaceDot(space) {
  return vizSpaceColor(space);
}

/* ---------- legend ---------- */

function vizSwatch(color, glyph) {
  return `<span class="viz-swatch" style="background:${color}">${glyph ? `<i>${glyph}</i>` : ""}</span>`;
}

function renderVizLegend() {
  const el = document.getElementById("viz-legend");
  if (!el) return;
  const mode = VIZ.mode;
  let html = "";
  if (mode === "status") {
    html = `<div class="viz-legend-title">Equipment status</div>
      <div class="viz-items">
        <span>${vizSwatch(vizStatusColor("ok"), "✓")}Normal</span>
        <span>${vizSwatch(vizStatusColor("warning"), "▲")}Warning</span>
        <span>${vizSwatch(vizStatusColor("serious"), "●")}Serious</span>
        <span>${vizSwatch(vizStatusColor("critical"), "✕")}Critical</span>
      </div>
      <p class="viz-note">Status comes from the expected-vs-actual model, not raw consumption.</p>`;
  } else if (mode === "energy") {
    const stops = VIZ.ENERGY_RAMP.map(c => `<span class="viz-ramp-step" style="background:${c}"></span>`).join("");
    html = `<div class="viz-legend-title">Energy intensity · today</div>
      <div class="viz-ramp">${stops}</div>
      <div class="viz-range"><span>low</span><span>high</span></div>
      <p class="viz-note"><b>Spaces:</b> kWh/m² today · <b>devices:</b> kWh today.<br>
      High consumption is <b>not</b> a fault — alerts compare against the expected baseline.</p>`;
  } else if (mode === "alerts") {
    html = `<div class="viz-legend-title">Abnormal consumption alerts</div>
      <div class="viz-items">
        <span>${vizSwatch(vizStatusColor("warning"), "▲")}Warning</span>
        <span>${vizSwatch(vizStatusColor("serious"), "●")}Serious</span>
        <span>${vizSwatch(vizStatusColor("critical"), "✕")}Critical</span>
        <span>${vizSwatch("rgba(255,255,255,0.18)")}No alert</span>
      </div>
      <p class="viz-note">Raised by sustained deviation from each device's expected model.</p>`;
  } else if (mode === "heatmap") {
    const stops = VIZ.ENERGY_RAMP.map(c => `<span class="viz-ramp-step" style="background:${c}"></span>`).join("");
    const active = (typeof playbackActive === "function") && playbackActive();
    const when = (typeof playbackTimeLabel === "function") ? playbackTimeLabel() : "Live";
    const bucket = (typeof PLAYBACK !== "undefined" && PLAYBACK.data)
      ? PLAYBACK.data.bucket_minutes : null;
    html = `<div class="viz-legend-title">Energy heatmap · ${active ? "history" : "today"}</div>
      <div class="viz-ramp">${stops}</div>
      <div class="viz-range"><span>low kWh/m²</span><span>${when}</span></div>
      <p class="viz-note"><b>kWh/m²</b> per ${bucket ? bucket + "-min" : "60-min"} bucket · ${active ? "calculated from simulated history" : "live simulated totals"} — <b>not metered</b>. High use is not a fault.</p>`;
  } else if (mode === "health") {
    html = `<div class="viz-legend-title">Equipment health</div>
      <div class="viz-items">
        <span>${vizSwatch(vizStatusColor("ok"), "✓")}Good ≥ 85</span>
        <span>${vizSwatch(vizStatusColor("warning"), "▲")}Fair ≥ 65</span>
        <span>${vizSwatch(vizStatusColor("serious"), "●")}Poor ≥ 40</span>
        <span>${vizSwatch(vizStatusColor("critical"), "✕")}Critical &lt; 40</span>
      </div>
      <p class="viz-note">Health reflects diagnostics (residual + detector state); a space is the mean of its devices.</p>`;
  } else {
    const present = (typeof S !== "undefined" && S.snap && S.snap.availability)
      ? new Set(Object.values(S.snap.availability).map(a => a.source || "simulated")) : new Set();
    const sourceItems = ["live", "imported", "simulated"]
      .map(k => `<span>${vizSwatch(VIZ.AVAIL[k])}${k[0].toUpperCase() + k.slice(1)}</span>`).join("");
    const allSimulated = present.size === 1 && present.has("simulated");
    html = `<div class="viz-legend-title">Data availability</div>
      <div class="viz-items">
        ${sourceItems}
        <span>${vizSwatch(VIZ.AVAIL.unavailable, "✕")}No data</span>
      </div>
      <p class="viz-note">⚠ Stale = no persisted sample for over 30 s. Times are real seconds.</p>
      ${allSimulated ? `<p class="viz-note viz-caveat">All equipment reports <b>simulated</b> data — no live telemetry is connected.</p>` : ""}`;
  }
  el.innerHTML = html;
}
