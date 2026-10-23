/* ============================================================
   Step 10 — performance core
   ------------------------------------------------------------
   The twin is painted by a single Canvas 2D context (scene.js), so
   "geometry" means projected screen paths and "materials" means
   gradients, brushes, CSS colours and shadow state.  This module
   owns the shared, bounded caches and the quality switch:

     - gradient/brush cache (bounded FIFO, cleared on theme/resize)
     - quality mode "full" | "reduced", persisted per browser
     - counters and the optional ?perf=1 HUD
     - dispose helpers so tests can prove the caches are released

   Nothing here draws the scene; scene.js owns the frame scheduler
   and building.js owns camera easing.  Keeping the resource policy
   separate makes it reusable and unit-testable.
   ============================================================ */

"use strict";

const PERF = {
  quality: "full",          // "full" | "reduced"
  dprCap: 1.75,
  reducedMotion: false,
  autoReason: "",           // why reduced quality was auto-selected
  gradientCache: new Map(),
  gradientCap: 96,
  counters: {
    frames: 0,            // rAF callbacks
    draws: 0,             // actual scene draws
    skipped: 0,           // frames that did not need a draw
    gradients: 0,         // gradient objects created
    gradientHits: 0,
    gradientEvictions: 0,
    projections: 0,       // project() misses
    projectionHits: 0,
    effectsSkipped: 0,    // shadows/effects suppressed by reduced mode
    renderErrors: 0,
  },
  drawMsEma: 0,
  lastDrawMs: 0,
  lastDrawAt: 0,
  startedAt: (typeof performance !== "undefined" ? performance.now() : Date.now()),
  hud: null,
  hudTimer: 0,
  _lastHudAt: 0,
};

const PERF_STORE_KEY = "efi.effects";

function perfR2(v) {
  return Math.round(v * 100) / 100;
}

/* ---------- quality ---------- */

function perfAutoReducedReason() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      PERF.reducedMotion = true;
      return "reduced-motion preference";
    }
  } catch (_) { /* matchMedia can be unavailable in tests */ }
  try {
    const conn = navigator.connection;
    if (conn && conn.saveData) return "data-saver mode";
    if (typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 2) {
      return "low device memory";
    }
    if (typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 2) {
      return "limited CPU";
    }
  } catch (_) { /* navigator hints are optional */ }
  return "";
}

function perfStoredQuality() {
  try {
    const v = localStorage.getItem(PERF_STORE_KEY);
    return v === "full" || v === "reduced" ? v : "";
  } catch (_) {
    return "";
  }
}

function perfInit() {
  PERF.showHud = /[?&]perf=1(?:&|$)/.test(location.search);
  const auto = perfAutoReducedReason();
  PERF.autoReason = auto;
  const saved = perfStoredQuality();
  PERF.quality = saved || (auto ? "reduced" : "full");
  perfApplyQuality(false);
  if (PERF.showHud) perfHud(true);
  window.addEventListener("pagehide", () => perfHud(false));
  return PERF.quality;
}

function perfApplyQuality(persist) {
  const reduced = PERF.quality === "reduced";
  PERF.dprCap = reduced ? 1.1 : 1.75;
  document.documentElement.classList.toggle("reduced-effects", reduced);
  document.documentElement.dataset.effects = PERF.quality;
  perfClearCaches();
  const sel = document.getElementById("effects");
  if (sel) sel.value = PERF.quality;
  if (persist) {
    try { localStorage.setItem(PERF_STORE_KEY, PERF.quality); } catch (_) { /* private mode */ }
  }
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

function perfSetQuality(q, persist) {
  const next = q === "reduced" ? "reduced" : "full";
  if (next === PERF.quality && !persist) { perfApplyQuality(false); return next; }
  PERF.quality = next;
  perfApplyQuality(persist !== false);
  return next;
}

/* ---------- bounded material cache ----------
   Gradients are immutable once built, so the same rounded coordinates
   can reuse one CanvasGradient across frames.  The cache is FIFO and
   bounded; perfClearCaches() runs on theme changes and canvas resizes,
   because both change the stop colours or the geometry. */

function perfClearCaches() {
  PERF.gradientCache.clear();
}

function perfGradient(ctx, tag, x0, y0, x1, y1, stops) {
  if (!ctx || typeof ctx.createLinearGradient !== "function") return null;
  const key = tag + "|" + perfR2(x0) + "," + perfR2(y0) + "," + perfR2(x1) + "," + perfR2(y1);
  let g = PERF.gradientCache.get(key);
  if (g) {
    PERF.counters.gradientHits += 1;
    return g;
  }
  g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
  PERF.counters.gradients += 1;
  if (PERF.gradientCache.size >= PERF.gradientCap) {
    const oldest = PERF.gradientCache.keys().next().value;
    PERF.gradientCache.delete(oldest);
    PERF.counters.gradientEvictions += 1;
  }
  PERF.gradientCache.set(key, g);
  return g;
}

function perfRadial(ctx, tag, x0, y0, r0, x1, y1, r1, stops) {
  if (!ctx || typeof ctx.createRadialGradient !== "function") return null;
  const key = tag + "|r|" + perfR2(x0) + "," + perfR2(y0) + "," + perfR2(r0)
    + "," + perfR2(x1) + "," + perfR2(y1) + "," + perfR2(r1);
  let g = PERF.gradientCache.get(key);
  if (g) {
    PERF.counters.gradientHits += 1;
    return g;
  }
  g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
  PERF.counters.gradients += 1;
  if (PERF.gradientCache.size >= PERF.gradientCap) {
    const oldest = PERF.gradientCache.keys().next().value;
    PERF.gradientCache.delete(oldest);
    PERF.counters.gradientEvictions += 1;
  }
  PERF.gradientCache.set(key, g);
  return g;
}

/* Reduce the cost of a glow: shadows are the most expensive canvas
   state, and the first thing to drop when effects are reduced. */
function perfShadow(ctx, color, blur) {
  if (!ctx) return false;
  if (PERF.quality === "reduced" || !(blur > 0)) {
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    PERF.counters.effectsSkipped += 1;
    return false;
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  return true;
}

/* ---------- counters / HUD ---------- */

function perfNoteDraw(ms) {
  const c = PERF.counters;
  c.draws += 1;
  PERF.lastDrawMs = ms;
  PERF.lastDrawAt = performance.now();
  PERF.drawMsEma = PERF.drawMsEma ? PERF.drawMsEma * 0.85 + ms * 0.15 : ms;
  if (PERF.showHud && PERF.lastDrawAt - PERF._lastHudAt > 500) perfHud();
}

function perfStats() {
  const c = PERF.counters;
  return {
    quality: PERF.quality,
    dprCap: PERF.dprCap,
    draws: c.draws,
    frames: c.frames,
    skipped: c.skipped,
    drawMs: Math.round(PERF.lastDrawMs * 100) / 100,
    drawMsEma: Math.round(PERF.drawMsEma * 100) / 100,
    gradientCache: PERF.gradientCache.size,
    gradients: c.gradients,
    gradientHits: c.gradientHits,
    gradientEvictions: c.gradientEvictions,
    projectionHits: c.projectionHits,
    projections: c.projections,
    effectsSkipped: c.effectsSkipped,
    renderErrors: c.renderErrors,
    canvas: typeof TWIN !== "undefined" ? { w: TWIN.W, h: TWIN.H, dpr: TWIN.DPR } : null,
  };
}

function perfHud(force) {
  let el = PERF.hud || document.getElementById("perf-hud");
  if (!el) {
    if (!force) return;
    el = document.createElement("div");
    el.id = "perf-hud";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "off");
    document.body.append(el);
    PERF.hud = el;
  }
  el.classList.toggle("hidden", !PERF.showHud);
  if (!PERF.showHud) return;
  const s = perfStats();
  const age = ((performance.now() - PERF.startedAt) / 1000).toFixed(0);
  const fps = s.draws > 1 ? (s.draws / Math.max(1, (performance.now() - PERF.startedAt) / 1000)).toFixed(1) : "0";
  el.textContent = [
    `quality ${s.quality}${PERF.autoReason && s.quality === "reduced" ? " (" + PERF.autoReason + ")" : ""}`,
    `draw ${s.draws} · ${fps}/s avg · ${s.drawMs.toFixed(1)} ms (ema ${s.drawMsEma.toFixed(1)})`,
    `frames ${s.frames} · skipped ${s.skipped} · errors ${s.renderErrors}`,
    `gradients ${s.gradients} hit ${s.gradientHits} cache ${s.gradientCache} evict ${s.gradientEvictions}`,
    `projections hit ${s.projectionHits} miss ${s.projections}`,
    `effects skipped ${s.effectsSkipped} · dpr ${s.canvas ? s.canvas.dpr : "—"} · ${s.canvas ? s.canvas.w + "×" + s.canvas.h : ""}`,
    `up ${age}s`,
  ].join("  \\n");
}

function perfHudHasElement() {
  return !!(PERF.hud || document.getElementById("perf-hud"));
}

function perfDispose() {
  perfClearCaches();
  if (PERF.hudTimer) { clearTimeout(PERF.hudTimer); PERF.hudTimer = 0; }
  if (PERF.hud) { PERF.hud.remove(); PERF.hud = null; }
}

/* Initialise as soon as the script is parsed: scene.js and app.js rely
   on the quality class before their first frame. */
perfInit();
