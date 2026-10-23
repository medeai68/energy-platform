/* ============================================================
   Step 10 — equipment-list fallback
   ------------------------------------------------------------
   The twin is drawn with Canvas 2D.  If a browser cannot create a 2D
   context, or the renderer fails repeatedly, the dashboard must still
   work: this module replaces the scene with a plain DOM equipment list
   (buildings → floors → rooms → equipment, plus the rooftop PV array).

   The list is also available on purpose through the 3D / List toggle,
   so keyboard and low-power users can choose it.  The choice is
   remembered in localStorage; automatic fallback reasons are not
   persisted (the next session retries the scene).

   Updates patch values in place instead of rebuilding the tree, so
   scroll position and focus survive the one-second data poll.
   ============================================================ */

"use strict";

const FALLBACK = {
  active: false,
  reason: "",
  error: null,
  builtSig: "",
  rows: new Map(),       // device id -> { btn, val, state }
};

const FALLBACK_KEY = "efi.view";
const FB_STATUS = {
  ok: "OK",
  warning: "Warning",
  serious: "Serious",
  critical: "Critical",
};

function fallbackCanvasSupported() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext && c.getContext("2d"));
  } catch (_) {
    return false;
  }
}

function fallbackSceneAvailable() {
  if (typeof TWIN_CTX_FAILED !== "undefined" && TWIN_CTX_FAILED) return false;
  return fallbackCanvasSupported();
}

function fallbackStored() {
  try { return localStorage.getItem(FALLBACK_KEY) || ""; } catch (_) { return ""; }
}

function fallbackStore(view) {
  try { localStorage.setItem(FALLBACK_KEY, view); } catch (_) { /* private mode */ }
}

function fallbackReasonText() {
  switch (FALLBACK.reason) {
    case "canvas2d":
      return "This browser could not create a 2D canvas, so the 3D scene is unavailable. "
        + "The equipment list below shows the same monitored objects.";
    case "render-error":
      return "The 3D scene stopped rendering after repeated errors. "
        + "The equipment list below shows the same monitored objects.";
    case "manual":
      return "Equipment-list view. Select an object to open its details.";
    default:
      return "The 3D scene is unavailable. The equipment list shows the same monitored objects.";
  }
}

function fbSpan(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  if (text != null) s.textContent = text;
  return s;
}

function fbKw(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)} kW` : "—";
}

function fbStatus(status) {
  return FB_STATUS[status] || FB_STATUS.ok;
}

function fbSummary(text, meta) {
  const summary = document.createElement("summary");
  summary.className = "fb-summary";
  const name = fbSpan("fb-summary-name", text);
  const value = fbSpan("fb-summary-meta", meta || "");
  summary.append(name, value);
  return summary;
}

function fbDeviceRow(d) {
  const li = document.createElement("li");
  li.className = "fb-item";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-row";
  btn.dataset.device = d.id;
  const name = fbSpan("fb-name", d.name || d.id);
  const val = fbSpan("fb-val", fbKw(d.actual));
  const state = fbSpan("fb-state", fbStatus(d.status));
  state.dataset.status = d.status || "ok";
  btn.append(name, val, state);
  btn.addEventListener("click", () => {
    if (typeof openDrawer === "function") openDrawer(d.id);
  });
  li.append(btn);
  FALLBACK.rows.set(d.id, { btn, val, state });
  return li;
}

function fbLevelRow(id, name, meta, icon) {
  const li = document.createElement("li");
  li.className = "fb-item";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-row fb-level";
  btn.dataset.level = id;
  btn.append(
    fbSpan("fb-name", `${icon || "▢"} ${name}`),
    fbSpan("fb-val", meta || ""),
  );
  btn.addEventListener("click", () => {
    if (typeof openLevel === "function") openLevel(id);
  });
  li.append(btn);
  return li;
}

function fallbackSignature() {
  const s = (typeof S !== "undefined") ? S.snap : null;
  if (!s) return "";
  const parts = [];
  for (const b of s.buildings || []) {
    parts.push("B" + b.id + ":" + (b.floors || []).length);
    for (const f of b.floors || []) {
      parts.push("F" + f.id + ":" + (f.rooms || []).length);
      for (const r of f.rooms || []) {
        parts.push("R" + r.id + ":" + (r.devices || []).length);
      }
    }
    parts.push("E" + (b.equipment || []).length);
  }
  parts.push("P" + (s.panels || []).length);
  return parts.join("|");
}

function fallbackBuild(force) {
  const list = document.getElementById("fallback-list");
  if (!list) return;
  const s = (typeof S !== "undefined") ? S.snap : null;
  if (!s) {
    if (list.dataset.state !== "waiting") {
      list.dataset.state = "waiting";
      list.textContent = "";
      const p = document.createElement("p");
      p.className = "fb-empty";
      p.textContent = "Waiting for the first snapshot…";
      list.append(p);
    }
    return;
  }
  const sig = fallbackSignature();
  if (!force && sig === FALLBACK.builtSig) { fallbackUpdate(); return; }
  list.dataset.state = "ready";
  FALLBACK.builtSig = sig;
  FALLBACK.rows.clear();
  list.textContent = "";

  const devicesById = new Map();
  for (const d of s.devices || []) devicesById.set(d.id, d);
  for (const d of s.panels || []) devicesById.set(d.id, d);
  for (const d of s.equipment || []) devicesById.set(d.id, d);

  // rooftop PV first: it is the scene's primary subject
  const panels = s.panels || [];
  if (panels.length || devicesById.has("solar") || devicesById.has("inverter")) {
    const det = document.createElement("details");
    det.className = "fb-group";
    det.open = true;
    const solarKw = s.kpis ? s.kpis.solar_kw : null;
    det.append(fbSummary("Rooftop PV", `${panels.length} panels`
      + (solarKw != null ? ` · ${Number(solarKw).toFixed(1)} kW` : "")));
    const ul = document.createElement("ul");
    ul.className = "fb-devices";
    for (const id of ["solar", "inverter"]) {
      const d = devicesById.get(id);
      if (d) ul.append(fbDeviceRow(d));
    }
    for (const p of panels) {
      const row = { id: p.id, name: `${p.name || p.id} · row ${p.row} col ${p.col}`,
                    actual: p.actual, status: p.status };
      ul.append(fbDeviceRow(row));
    }
    det.append(ul);
    list.append(det);
  }

  for (const b of s.buildings || []) {
    const bDet = document.createElement("details");
    bDet.className = "fb-group";
    bDet.open = s.buildings.length === 1;
    bDet.append(fbSummary(b.name, `${Number(b.actual || 0).toFixed(1)} kW`
      + (b.anomalies ? ` · ${b.anomalies} anomalies` : "")));
    const bUl = document.createElement("ul");
    bUl.className = "fb-devices";

    for (const f of b.floors || []) {
      const fDet = document.createElement("details");
      fDet.className = "fb-subgroup";
      fDet.append(fbSummary(f.name, `${Number(f.actual || 0).toFixed(1)} kW`
        + (f.anomalies ? ` · ${f.anomalies} anomalies` : "")));
      const fUl = document.createElement("ul");
      fUl.className = "fb-devices";

      for (const r of f.rooms || []) {
        const rDet = document.createElement("details");
        rDet.className = "fb-subgroup";
        rDet.append(fbSummary(r.name, `${Number(r.actual || 0).toFixed(1)} kW`));
        const rUl = document.createElement("ul");
        rUl.className = "fb-devices";
        for (const d of r.devices || []) rUl.append(fbDeviceRow(d));
        rDet.append(rUl);
        fUl.append(rDet);
      }
      // the floor FCU serves the whole floor, so it sits beside the rooms
      if (f.fcu) fUl.append(fbDeviceRow(f.fcu));
      fDet.append(fUl);
      bUl.append(fDet);
    }
    for (const d of b.equipment || []) bUl.append(fbDeviceRow(d));
    bDet.append(bUl);
    list.append(bDet);
  }

  if (!list.children.length) {
    const p = document.createElement("p");
    p.className = "fb-empty";
    p.textContent = "No equipment has been reported yet.";
    list.append(p);
  }
}

function fallbackUpdate() {
  if (!FALLBACK.active) return;
  const s = (typeof S !== "undefined") ? S.snap : null;
  if (!s) { fallbackBuild(true); return; }
  if (fallbackSignature() !== FALLBACK.builtSig) { fallbackBuild(true); return; }
  const byId = new Map();
  for (const d of s.devices || []) byId.set(d.id, d);
  for (const d of s.panels || []) byId.set(d.id, d);
  for (const d of s.equipment || []) byId.set(d.id, d);
  for (const [id, row] of FALLBACK.rows) {
    const d = byId.get(id);
    if (!d) continue;
    row.val.textContent = fbKw(d.actual);
    row.state.textContent = fbStatus(d.status);
    row.state.dataset.status = d.status || "ok";
    row.btn.setAttribute("aria-label",
      `${d.name || d.id}: ${fbKw(d.actual)}, ${fbStatus(d.status)}`);
  }
}

/* ---------------- view switching ---------------- */

function fallbackSyncToggle() {
  const sceneBtn = document.getElementById("view-scene");
  const listBtn = document.getElementById("view-list");
  const sceneOk = fallbackSceneAvailable();
  if (sceneBtn) {
    sceneBtn.classList.toggle("selected", !FALLBACK.active);
    sceneBtn.setAttribute("aria-pressed", FALLBACK.active ? "false" : "true");
    sceneBtn.disabled = !sceneOk;
    sceneBtn.title = sceneOk ? "Show the 3D scene" : "The 3D scene is unavailable in this browser";
  }
  if (listBtn) {
    listBtn.classList.toggle("selected", FALLBACK.active);
    listBtn.setAttribute("aria-pressed", FALLBACK.active ? "true" : "false");
  }
}

function fallbackActivate(reason, err) {
  const wasActive = FALLBACK.active;
  FALLBACK.active = true;
  FALLBACK.reason = reason || "manual";
  FALLBACK.error = err || null;
  document.body.classList.add("fallback-on");
  const root = document.getElementById("fallback-view");
  if (root) {
    root.classList.remove("hidden");
    const reasonEl = document.getElementById("fallback-reason");
    if (reasonEl) reasonEl.textContent = fallbackReasonText();
  }
  const canvas = document.getElementById("twin");
  if (canvas) canvas.setAttribute("aria-hidden", "true");
  if (typeof sceneSetPaused === "function") sceneSetPaused(true);
  fallbackSyncToggle();
  fallbackBuild(true);
  if (FALLBACK.reason === "manual") fallbackStore("list");
  if (!wasActive && typeof kbAnnounce === "function") {
    kbAnnounce("Equipment list view. " + fallbackReasonText());
  }
}

function fallbackDeactivate() {
  if (!FALLBACK.active) return;
  FALLBACK.active = false;
  FALLBACK.reason = "";
  FALLBACK.error = null;
  document.body.classList.remove("fallback-on");
  const root = document.getElementById("fallback-view");
  if (root) root.classList.add("hidden");
  const canvas = document.getElementById("twin");
  if (canvas) canvas.removeAttribute("aria-hidden");
  fallbackStore("scene");
  fallbackSyncToggle();
  if (typeof sceneSetPaused === "function") sceneSetPaused(false);
  if (typeof kbAnnounce === "function") kbAnnounce("3D scene view.");
}

/* Public surface used by scene.js and the header toggle. */
FALLBACK.activate = fallbackActivate;
FALLBACK.deactivate = fallbackDeactivate;
FALLBACK.toggle = function () {
  if (FALLBACK.active) fallbackDeactivate();
  else fallbackActivate("manual");
};
FALLBACK.update = fallbackUpdate;

function initFallback() {
  const sceneBtn = document.getElementById("view-scene");
  const listBtn = document.getElementById("view-list");
  if (sceneBtn) sceneBtn.addEventListener("click", () => fallbackDeactivate());
  if (listBtn) listBtn.addEventListener("click", () => fallbackActivate("manual"));

  if (!fallbackCanvasSupported()) fallbackActivate("canvas2d");
  else if (fallbackStored() === "list") fallbackActivate("manual");
  else fallbackSyncToggle();
}
