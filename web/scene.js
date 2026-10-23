/* ============================================================
   Cinematic rooftop solar scene
   A small perspective camera projects a physical panel field onto
   the dashboard canvas. Every one of the 48 PV modules is a real
   object in world space with a frame, glass, cell grid, mounting
   legs and its own live status. The scene is the background of the
   whole app; all monitoring cards float above it.
   ============================================================ */

"use strict";

const TWIN = { W: 1600, H: 950, DPR: 1 };
const CAM = { x: 0, y: 0, zoom: 1 };

/* WebGL renderer (default).  twin3d.js is lazy-loaded unless the URL asks
   for the legacy Canvas renderer (?render=canvas) or the browser lacks
   WebGL2.  Hit testing, keyboard focus and camera flights keep flowing
   through the functions below and are delegated when active. */
let TWIN3D = null;
let TWIN3D_LOADING = false;
let TWIN3D_FAILED = false;
const CAM_MIN = 1, CAM_MAX = 5;
// Wheel zoom is eased toward ZOOM.goal by the frame loop (see building.js);
// ZOOM.anchor is the screen point the zoom is centred on.
const ZOOM = { goal: 1, anchor: null };

const PANEL_STATUS = {
  ok:       { color: "--good",     label: "Normal",          glyph: "✓" },
  warning:  { color: "--warning",  label: "Underperforming", glyph: "▲" },
  serious:  { color: "--serious",  label: "Faulted",         glyph: "●" },
  critical: { color: "--critical", label: "Offline",         glyph: "✕" },
};
const PANEL_GLYPH = { underperforming: "▲", faulted: "●", offline: "✕" };
const PANEL_BORDER = {
  underperforming: "#f0a92e",
  faulted: "#ef6a45",
  offline: "#e04646",
};

const PANEL_GEOM = [];          // projected panel quads, refreshed every frame
const zones = {};               // aggregate hit zones (array, inverter)

/* ---------------- camera ---------------- */

const VIEW = {
  yaw: -0.60,
  pitch: 0.78,
  dist: 24.5,
  fov: 52,
  target: { x: 0.3, y: 0.15, z: 0.38 },
  // Optional orbit pivot, used by the WebGL room camera so the eye can
  // circle the room centre while still looking at the selected equipment.
  // When null the target is also the orbit pivot (all Canvas views and the
  // campus / building / floor WebGL views).
  pivot: null,
  mode: "roof",   // roof | campus | building | floor | room (see building.js)
};
const SCENE = { ox: 15, oy: -42 };   // screen offset of the projected target
let cam = null;

function rebuildCamera() {
  const yaw = VIEW.yaw, pitch = VIEW.pitch, D = VIEW.dist, target = VIEW.target;
  const pivot = VIEW.pivot || target;
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const eye = {
    x: pivot.x + Math.sin(yaw) * D * cosP,
    y: pivot.y - Math.cos(yaw) * D * cosP,
    z: pivot.z + D * sinP,
  };
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // right = normalize(cross(forward, worldUp))
  let rx = fy, ry = -fx, rz = 0;
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl; ry /= rl;
  // up = cross(right, forward)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const focal = (TWIN.H * 0.5) / Math.tan((VIEW.fov * Math.PI / 180) * 0.5);
  cam = {
    eye, focal,
    f: { x: fx, y: fy, z: fz },
    r: { x: rx, y: ry, z: rz },
    u: { x: ux, y: uy, z: uz },
  };
}

function projectRaw(x, y, z) {
  if (!cam || !isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
  const dx = x - cam.eye.x, dy = y - cam.eye.y, dz = z - cam.eye.z;
  const cx = dx * cam.r.x + dy * cam.r.y + dz * cam.r.z;
  const cy = dx * cam.u.x + dy * cam.u.y + dz * cam.u.z;
  const cz = dx * cam.f.x + dy * cam.f.y + dz * cam.f.z;
  if (cz <= 0.2) return null;
  const s = cam.focal / cz;
  let sx = TWIN.W * 0.5 + SCENE.ox + cx * s;
  let sy = TWIN.H * 0.5 + SCENE.oy - cy * s;
  sx = sx * CAM.zoom + CAM.x;
  sy = sy * CAM.zoom + CAM.y;
  return { x: sx, y: sy, s: s * CAM.zoom, depth: cz };
}

/* Projected world points are immutable, so while the camera stands still
   every draw can reuse the previous frame's screen coordinates.  The map
   is rebuilt whenever the camera signature changes and is disabled while
   the camera is moving (there is nothing to reuse then).  Bounded size
   keeps the cache from growing during long interactive sessions. */
const PROJ = { sig: "", map: null, cap: 12000 };

function projCameraSignature() {
  const t = VIEW.target;
  const p = VIEW.pivot;
  return [
    VIEW.yaw.toFixed(4), VIEW.pitch.toFixed(4), VIEW.dist.toFixed(3),
    t.x.toFixed(3), t.y.toFixed(3), t.z.toFixed(3),
    p ? p.x.toFixed(3) + "," + p.y.toFixed(3) + "," + p.z.toFixed(3) : "-",
    CAM.zoom.toFixed(4), CAM.x.toFixed(2), CAM.y.toFixed(2),
    TWIN.W, TWIN.H, (typeof EXPLODE !== "undefined" ? EXPLODE.t.toFixed(4) : 0),
  ].join("|");
}

function projBeginFrame(enableCache) {
  const sig = projCameraSignature();
  const changed = sig !== PROJ.sig;
  PROJ.sig = sig;
  if (enableCache === false) { PROJ.map = null; return; }
  if (changed || !PROJ.map) PROJ.map = new Map();
}

function project(x, y, z) {
  if (!PROJ.map) return projectRaw(x, y, z);
  const key = x + "|" + y + "|" + z;
  const hit = PROJ.map.get(key);
  if (hit !== undefined) {
    if (typeof PERF !== "undefined") PERF.counters.projectionHits += 1;
    return hit;
  }
  const p = projectRaw(x, y, z);
  if (PROJ.map.size < PROJ.cap) PROJ.map.set(key, p);
  if (typeof PERF !== "undefined") PERF.counters.projections += 1;
  return p;
}

/* ---------------- world layout ---------------- */

const ARRAY = (function buildArray() {
  const cols = 12, rows = 4;
  const pw = 2.28, pd = 1.13, gx = 0.055, gy = 0.88;
  const tilt = 10 * Math.PI / 180;
  const zFront = 0.17;
  const zBack = zFront + pd * Math.sin(tilt);
  const rowW = cols * pw + (cols - 1) * gx;
  const halfStep = (pw + gx) / 2;
  const totalW = rowW + halfStep;
  const totalD = rows * pd + (rows - 1) * gy;
  const items = [];
  for (let r = 0; r < rows; r++) {
    const shift = (r % 2 ? halfStep : 0) - halfStep / 2;
    const yB = totalD / 2 - r * (pd + gy);
    const yF = yB - pd;
    for (let c = 0; c < cols; c++) {
      const x0 = -totalW / 2 + shift + c * (pw + gx);
      items.push({
        id: "p" + String(r * cols + c + 1).padStart(2, "0"),
        row: r + 1, col: c + 1,
        x0, x1: x0 + pw, yF, yB, zF: zFront, zB: zBack,
        rIndex: r,
      });
    }
  }
  return { cols, rows, pw, pd, gx, gy, tilt, totalW, totalD, items };
})();

const INVERTER = {
  x: 3.2, y: -7.8, w: 1.95, d: 1.05, h: 2.15,
};
const SHADOW_DIR = { x: -0.34, y: -0.78 };

/* ---------------- small math / colour helpers ---------------- */

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function lerp(a, b, t) { return a + (b - a) * t; }

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
}

function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/* Theme colours are read once and cached: getComputedStyle() forces a
   style recalculation, and the draw code asks for these many times per
   frame. `clearCssVarCache()` runs on theme changes and disposal. */
const CSSVAR_CACHE = new Map();

function cssVar(name) {
  let v = CSSVAR_CACHE.get(name);
  if (v !== undefined) return v;
  v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  CSSVAR_CACHE.set(name, v);
  return v;
}

function clearCssVarCache() {
  CSSVAR_CACHE.clear();
}

function daylight() {
  if (typeof S === "undefined" || !S.snap) return 0.85;
  return clamp((S.snap.sim.sun - 0.02) / 0.75, 0, 1);
}

function quadPath(ctx, q) {
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  ctx.lineTo(q[1].x, q[1].y);
  ctx.lineTo(q[2].x, q[2].y);
  ctx.lineTo(q[3].x, q[3].y);
  ctx.closePath();
}

function bilinear(q, u, v) {
  // q = [SW, SE, NE, NW]
  const ax = lerp(q[0].x, q[1].x, u), ay = lerp(q[0].y, q[1].y, u);
  const bx = lerp(q[3].x, q[2].x, u), by = lerp(q[3].y, q[2].y, u);
  return { x: lerp(ax, bx, v), y: lerp(ay, by, v) };
}

function quadSub(q, u0, u1, v0, v1) {
  return [
    bilinear(q, u0, v0), bilinear(q, u1, v0),
    bilinear(q, u1, v1), bilinear(q, u0, v1),
  ];
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function pointInQuad(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function panelState(p) {
  if (!p) return "ok";
  const ids = (p.faults || []).map(f => f.id);
  if (ids.includes("disconnected")) return "offline";
  if (ids.includes("overheating")) return "faulted";
  if (ids.includes("reduced_output")) return "underperforming";
  if (p.status === "critical") return "offline";
  if (p.status === "serious") return "faulted";
  if (p.status === "warning") return "underperforming";
  return "ok";
}

function findTwinDevice(id) {
  if (typeof S === "undefined" || !S.snap) return null;
  const d = (S.snap.devices || []).find(x => x.id === id);
  if (d) return d;
  const p = (S.snap.panels || []).find(x => x.id === id);
  if (p) return p;
  return (S.snap.equipment || []).find(x => x.id === id);
}

/* ============================================================
   Background: dusk atmosphere over a vast dark roof plane
   ============================================================ */

function drawBackdrop(ctx, now, sim) {
  const W = TWIN.W, H = TWIN.H;
  const day = daylight();

  // deep base wash
  const base = perfGradient(ctx, "backdrop-base", 0, 0, 0, H, [
    [0, "#17161a"], [0.34, "#121317"], [0.7, "#0d0e11"], [1, "#08090b"],
  ]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // warm sunset bloom upper right (fixed atmosphere for the "photo" look)
  let g = perfRadial(ctx, "backdrop-bloom",
    W * 0.735, H * 0.075, 10, W * 0.735, H * 0.075, W * 0.52, [
      [0, "rgba(255, 196, 132, 0.30)"],
      [0.22, "rgba(238, 160, 92, 0.13)"],
      [0.55, "rgba(170, 110, 64, 0.04)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // hot core of the sun, just out of frame top-right
  g = perfRadial(ctx, "backdrop-sun:" + Math.round(day * 20),
    W * 0.705, H * 0.035, 2, W * 0.705, H * 0.035, W * 0.14, [
      [0, `rgba(255, 232, 196, ${0.40 + 0.24 * day})`],
      [0.35, "rgba(255, 198, 138, 0.16)"],
      [1, "rgba(255, 190, 130, 0)"],
    ]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * 0.55);

  // drifting haze bands (drift is quantised so the material cache still
  // hits between frames - 4 px is below the visible threshold here)
  ctx.save();
  for (let i = 0; i < 5; i++) {
    const drift = (now / 90000) * (i + 1) * 20;
    const cx = ((W * (0.25 + i * 0.19) + drift) % (W * 1.3)) - W * 0.15;
    const cxq = Math.round(cx / 4) * 4;
    const cy = H * (0.05 + i * 0.038);
    const rx = W * (0.23 + i * 0.035);
    const ry = H * (0.018 + i * 0.005);
    const hz = perfRadial(ctx, "haze" + i, cxq, cy, 1, cxq, cy, rx, [
      [0, `rgba(255, 214, 175, ${0.035 + i * 0.008})`],
      [1, "rgba(255, 214, 175, 0)"],
    ]);
    ctx.save();
    ctx.translate(cxq, cy);
    ctx.scale(1, ry / rx * 4.2);
    ctx.translate(-cxq, -cy);
    ctx.fillStyle = hz;
    ctx.beginPath();
    ctx.arc(cxq, cy, rx, 0, 7);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // subtle warm bounce on the roof plane
  const bounce = perfGradient(ctx, "backdrop-bounce", 0, H * 0.18, W, H * 0.9, [
    [0, "rgba(255, 176, 110, 0)"],
    [0.55, "rgba(255, 176, 110, 0.025)"],
    [1, "rgba(255, 176, 110, 0)"],
  ]);
  ctx.fillStyle = bounce;
  ctx.fillRect(0, 0, W, H);
}

function drawRoof(ctx, now, sim) {
  // perspective seams across the concrete roof membrane
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.028)";
  ctx.beginPath();
  for (let x = -54; x <= 54; x += 3) {
    const a = project(x, -46, 0), b = project(x, 46, 0);
    if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  }
  for (let y = -46; y <= 46; y += 3) {
    const a = project(-54, y, 0), b = project(54, y, 0);
    if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.045)";
  ctx.beginPath();
  for (let x = -48; x <= 48; x += 12) {
    const a = project(x, -46, 0), b = project(x, 46, 0);
    if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  }
  for (let y = -40; y <= 44; y += 12) {
    const a = project(-54, y, 0), b = project(54, y, 0);
    if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
  }
  ctx.stroke();
  ctx.restore();
}

/* ============================================================
   Panel field
   ============================================================ */

const GLASS_PALETTE = {
  ok:                  { front: "#182536", mid: "#314761", back: "#758ca6", warm: 0.14 },
  underperforming:     { front: "#332b18", mid: "#6f5927", back: "#b08a35", warm: 0.18 },
  faulted:             { front: "#3d2119", mid: "#7d3a25", back: "#b95733", warm: 0.22 },
  offline:             { front: "#190d0d", mid: "#2c1414", back: "#4a1e1e", warm: 0.09 },
};

function drawPanelShadows(ctx, panelMap, now) {
  for (const g of ARRAY.items) {
    const p = panelMap[g.id];
    const st = panelState(p);
    const corners = [
      [g.x0 + SHADOW_DIR.x, g.yF + SHADOW_DIR.y],
      [g.x1 + SHADOW_DIR.x, g.yF + SHADOW_DIR.y],
      [g.x1 + SHADOW_DIR.x, g.yB + SHADOW_DIR.y],
      [g.x0 + SHADOW_DIR.x, g.yB + SHADOW_DIR.y],
    ].map(([x, y]) => project(x, y, 0.015));
    if (corners.every(Boolean)) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
      quadPath(ctx, corners);
      ctx.fill();
      // a tighter, darker contact shadow
      const contact = [
        [g.x0 + 0.08, g.yF - 0.04], [g.x1 + 0.08, g.yF - 0.04],
        [g.x1 + 0.08, g.yB - 0.04], [g.x0 + 0.08, g.yB - 0.04],
      ].map(([x, y]) => project(x, y, 0.012));
      if (contact.every(Boolean)) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.30)";
        quadPath(ctx, contact);
        ctx.fill();
      }
    }
    if (st !== "ok") {
      const c = project((g.x0 + g.x1) / 2, (g.yF + g.yB) / 2, 0.02);
      if (c) {
        const r = Math.max(26, 58 * c.s * 0.045 + 26);
        const col = st === "underperforming" ? "250, 178, 25" : st === "faulted" ? "236, 110, 70" : "220, 60, 60";
        const glow = perfRadial(ctx, "panel-glow:" + st, c.x, c.y, 2, c.x, c.y, r, [
          [0, `rgba(${col}, 0.20)`],
          [1, `rgba(${col}, 0)`],
        ]);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, 7);
        ctx.fill();
      }
    }
  }
}

function drawMounts(ctx) {
  const rail = "rgba(150, 156, 166, 0.28)";
  const leg = "rgba(160, 166, 176, 0.32)";
  ctx.save();
  // rails along each row
  for (let r = 0; r < ARRAY.rows; r++) {
    let xMin = Infinity, xMax = -Infinity, yF = 0, yB = 0;
    for (const g of ARRAY.items) {
      if (g.rIndex !== r) continue;
      xMin = Math.min(xMin, g.x0);
      xMax = Math.max(xMax, g.x1);
      yF = g.yF; yB = g.yB;
    }
    for (const y of [yF - 0.10, yB + 0.08]) {
      const a = project(xMin - 0.1, y, 0.10);
      const b = project(xMax + 0.1, y, 0.10);
      if (a && b) {
        ctx.strokeStyle = "rgba(8, 9, 11, 0.55)";
        ctx.lineWidth = Math.max(1.4, a.s * 0.05);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = rail;
        ctx.lineWidth = Math.max(0.8, a.s * 0.016);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
  }
  // mounting legs at the front corners of each panel
  for (const g of ARRAY.items) {
    for (const x of [g.x0 + 0.12, g.x1 - 0.12]) {
      const a = project(x, g.yF, 0.01);
      const b = project(x, g.yF, g.zF - 0.02);
      if (!a || !b) continue;
      ctx.strokeStyle = leg;
      ctx.lineWidth = Math.max(0.8, a.s * 0.014);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  ctx.restore();
}

function drawPanels(ctx, panelMap, now) {
  const day = daylight();
  const hovered = (typeof S !== "undefined") ? S.hover : null;
  const selected = (typeof S !== "undefined") ? S.deviceId : null;
  const light = 0.42 + 0.58 * day;          // overall scene brightness
  PANEL_GEOM.length = 0;

  // back rows first so nearer panels overlap correctly
  const ordered = [...ARRAY.items].sort((a, b) => b.yF - a.yF);
  const tags = [];

  for (const g of ordered) {
    const p = panelMap[g.id];
    const st = panelState(p);
    const zAt = (y) => g.zF + ((y - g.yF) / (g.yB - g.yF)) * (g.zB - g.zF);
    const frame = [
      project(g.x0, g.yF, g.zF), project(g.x1, g.yF, g.zF),
      project(g.x1, g.yB, g.zB), project(g.x0, g.yB, g.zB),
    ];
    if (!frame.every(Boolean)) continue;
    const m = 0.088;
    const glass = [
      project(g.x0 + m, g.yF + m, zAt(g.yF + m)),
      project(g.x1 - m, g.yF + m, zAt(g.yF + m)),
      project(g.x1 - m, g.yB - m, zAt(g.yB - m)),
      project(g.x0 + m, g.yB - m, zAt(g.yB - m)),
    ];
    if (!glass.every(Boolean)) continue;

    const panelPx = Math.hypot(frame[1].x - frame[0].x, frame[1].y - frame[0].y);
    const lift = 0.055;
    const south = [frame[0], frame[1], project(g.x1, g.yF, g.zF - lift), project(g.x0, g.yF, g.zF - lift)];
    const west = [frame[0], frame[3], project(g.x0, g.yB, g.zB - lift), project(g.x0, g.yF, g.zF - lift)];
    const sideCol = st === "ok" ? shade("#565b64", light) : mixHex("#565b64", PANEL_BORDER[st], 0.55);

    // visible panel thickness (south + west faces)
    ctx.save();
    if (south.every(Boolean)) {
      ctx.fillStyle = shade("#30333a", light * 0.88);
      quadPath(ctx, south);
      ctx.fill();
    }
    if (west.every(Boolean)) {
      ctx.fillStyle = shade("#24272d", light * 0.92);
      quadPath(ctx, west);
      ctx.fill();
    }
    ctx.restore();

    // aluminium frame face
    const frameStops = st === "ok" ? [
      [0, shade("#f4efe5", light)],
      [0.42, shade("#d8dade", light)],
      [0.75, shade("#a9adb4", light)],
      [1, shade("#6c7078", light)],
    ] : [
      [0, mixHex("#f4efe5", PANEL_BORDER[st], 0.42)],
      [0.5, mixHex("#d8dade", PANEL_BORDER[st], 0.52)],
      [1, mixHex("#868a92", PANEL_BORDER[st], 0.48)],
    ];
    const frameGrad = perfGradient(ctx, "panel-frame:" + st + ":" + Math.round(light * 50),
      frame[2].x, frame[2].y, frame[0].x, frame[0].y, frameStops);
    ctx.fillStyle = frameGrad;
    quadPath(ctx, frame);
    ctx.fill();
    ctx.strokeStyle = "rgba(10, 11, 14, 0.60)";
    ctx.lineWidth = 0.9;
    quadPath(ctx, frame);
    ctx.stroke();

    // glass
    const pal = GLASS_PALETTE[st];
    const glassGrad = perfGradient(ctx, "panel-glass:" + st + ":" + Math.round(light * 50),
      glass[0].x, glass[0].y, glass[2].x, glass[2].y, [
        [0, shade(pal.front, 0.55 + 0.45 * light)],
        [0.5, shade(pal.mid, 0.55 + 0.45 * light)],
        [1, shade(pal.back, 0.52 + 0.48 * light)],
      ]);
    ctx.fillStyle = glassGrad;
    quadPath(ctx, glass);
    ctx.fill();

    ctx.save();
    quadPath(ctx, glass);
    ctx.clip();

    // alternating cell columns for a subtle wafer texture
    ctx.fillStyle = "rgba(198, 218, 242, 0.035)";
    for (let k = 0; k < 6; k += 2) {
      const cq = quadSub(glass, k / 6, (k + 1) / 6, 0, 1);
      quadPath(ctx, cq);
      ctx.fill();
    }

    // warm sunset reflection and sky sheen
    const refl = perfGradient(ctx, "panel-refl:" + Math.round(day * 50),
      glass[0].x, glass[0].y, glass[2].x, glass[2].y, [
        [0, "rgba(188, 213, 240, 0.13)"],
        [0.34, "rgba(120, 154, 194, 0.02)"],
        [0.66, `rgba(255, 178, 116, ${0.16 * (0.4 + 0.6 * day)})`],
        [1, "rgba(255, 150, 92, 0)"],
      ]);
    ctx.fillStyle = refl;
    ctx.fillRect(glass[0].x - 20, glass[0].y - 20, Math.max(...glass.map(q => q.x)) - glass[0].x + 40, Math.max(...glass.map(q => q.y)) - glass[0].y + 40);

    // cell grid (6 strings x 10 rows) + busbars
    const lw = Math.max(0.45, panelPx * 0.006);
    ctx.strokeStyle = "rgba(202, 222, 248, 0.30)";
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let k = 1; k < 6; k++) {
      const a = bilinear(glass, k / 6, 0), b = bilinear(glass, k / 6, 1);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let j = 1; j < 10; j++) {
      const a = bilinear(glass, 0, j / 10), b = bilinear(glass, 1, j / 10);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    // stronger busbars every two cell rows
    ctx.strokeStyle = "rgba(214, 230, 248, 0.19)";
    ctx.lineWidth = Math.max(0.6, lw * 1.6);
    ctx.beginPath();
    for (let j = 2; j < 10; j += 2) {
      const a = bilinear(glass, 0, j / 10), b = bilinear(glass, 1, j / 10);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    // crisp inner bezel + shadow so the glass reads as recessed into the frame
    ctx.strokeStyle = "rgba(245, 250, 255, 0.22)";
    ctx.lineWidth = Math.max(0.8, panelPx * 0.008);
    quadPath(ctx, glass);
    ctx.stroke();
    ctx.strokeStyle = "rgba(4, 7, 12, 0.46)";
    ctx.lineWidth = Math.max(1, panelPx * 0.014);
    quadPath(ctx, glass);
    ctx.stroke();

    // fault tint / hot spot
    if (st === "underperforming" || st === "faulted" || st === "offline") {
      const tint = st === "underperforming" ? "250, 178, 25" : st === "faulted" ? "236, 100, 62" : "190, 36, 36";
      const a = st === "underperforming" ? 0.18 : st === "faulted" ? 0.30 : 0.46;
      ctx.fillStyle = `rgba(${tint}, ${a})`;
      quadPath(ctx, glass);
      ctx.fill();
      if ((p && (p.faults || []).some(f => f.id === "overheating"))) {
        const c = bilinear(glass, 0.62, 0.55);
        const hot = perfRadial(ctx, "panel-hot", c.x, c.y, 1, c.x, c.y,
          Math.max(8, panelPx * 0.35), [
            [0, "rgba(255, 190, 120, 0.45)"],
            [1, "rgba(255, 90, 40, 0)"],
          ]);
        ctx.fillStyle = hot;
        ctx.fillRect(glass[0].x - 30, glass[0].y - 30, panelPx + 60, panelPx + 60);
      }
    }

    // glossy diagonal glint
    const glint = perfGradient(ctx, "panel-glint",
      glass[0].x, glass[3].y, glass[2].x, glass[1].y, [
        [0, "rgba(255, 255, 255, 0)"],
        [0.42, "rgba(255, 255, 255, 0.05)"],
        [0.52, "rgba(255, 255, 255, 0.10)"],
        [0.62, "rgba(255, 255, 255, 0.02)"],
        [1, "rgba(255, 255, 255, 0)"],
      ]);
    ctx.fillStyle = glint;
    ctx.fillRect(glass[0].x - 20, glass[0].y - 20, panelPx + 80, panelPx + 80);

    ctx.restore();

    // frame highlight along the sunlit back edge
    ctx.strokeStyle = `rgba(255, 240, 220, ${0.10 + 0.20 * day})`;
    ctx.lineWidth = Math.max(0.7, panelPx * 0.008);
    ctx.beginPath();
    ctx.moveTo(frame[3].x, frame[3].y);
    ctx.lineTo(frame[2].x, frame[2].y);
    ctx.stroke();

    // hover / selection / fault rim
    if (g.id === selected) {
      ctx.save();
      ctx.strokeStyle = "#8fdcff";
      perfShadow(ctx, "rgba(96, 200, 255, 0.9)", 16);
      ctx.lineWidth = Math.max(1.6, panelPx * 0.016);
      quadPath(ctx, frame);
      ctx.stroke();
      ctx.restore();
    } else if (g.id === hovered) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
      perfShadow(ctx, "rgba(255, 255, 255, 0.45)", 8);
      ctx.lineWidth = Math.max(1.1, panelPx * 0.01);
      quadPath(ctx, frame);
      ctx.stroke();
      ctx.restore();
    } else if (st !== "ok") {
      ctx.save();
      ctx.strokeStyle = rgba(PANEL_BORDER[st], 0.9);
      perfShadow(ctx, rgba(PANEL_BORDER[st], 0.6), 10);
      ctx.lineWidth = Math.max(1.1, panelPx * 0.011);
      quadPath(ctx, frame);
      ctx.stroke();
      ctx.restore();
    }

    // remember projected geometry for hit-testing and overlays
    const cx = (glass[0].x + glass[2].x) / 2;
    const cy = (glass[0].y + glass[2].y) / 2;
    PANEL_GEOM.push({
      id: g.id, row: g.row, col: g.col,
      pts: glass, framePts: frame,
      cx, cy, w: panelPx, st,
      p,
    });
    tags.push({ g, p, st, frame, glass, panelPx, cx, cy });
  }

  // power tags float above each module (second pass keeps them legible)
  for (const t of tags) drawPowerTag(ctx, t, hovered, selected, now);
  // warning badges for faulted modules
  for (const t of tags) if (t.st !== "ok") drawFaultBadge(ctx, t, now);
  // panel ids when zoomed in
  if (CAM.zoom >= 1.35) {
    for (const t of tags) drawPanelId(ctx, t, hovered, selected);
  }

  // aggregate array zone (clicking the roof between panels opens the array)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tags) {
    for (const q of t.frame) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }
  if (isFinite(x0)) zones.solar = { x: x0 - 8, y: y0 - 8, w: x1 - x0 + 16, h: y1 - y0 + 16 };
}

function drawPowerTag(ctx, t, hovered, selected, now) {
  if (!t.p) return;
  if (t.panelPx < 44 && t.g.id !== hovered && t.g.id !== selected) return;
  const fault = t.st !== "ok";
  const actual = t.p.actual != null ? t.p.actual : 0;
  const text = `${Math.max(0, Math.round(actual * 1000))} W`;
  const fpx = clamp(t.panelPx * 0.112, 8.5, 11.5);
  ctx.save();
  ctx.font = `600 ${fpx.toFixed(1)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const tw = ctx.measureText(text).width;
  const padX = fpx * 0.62, h = fpx + 6.5, w = tw + padX * 2;
  const back = bilinear(t.glass, 0.5, 1);
  let x = back.x - w / 2;
  let y = back.y - h - Math.max(5, t.panelPx * 0.045);
  if (fault) {
    // faulted tags sit at the visual center like the reference
    x = t.cx - w / 2;
    y = t.cy - h / 2;
  }
  ctx.globalAlpha = fault ? 1 : 0.96;
  if (!fault) {
    perfShadow(ctx, "rgba(0, 0, 0, 0.55)", 6);
    ctx.shadowOffsetY = 2;
  }
  ctx.fillStyle = fault ? rgba(PANEL_BORDER[t.st], 0.9) : "rgba(8, 10, 14, 0.80)";
  roundRect(ctx, x, y, w, h, 4.5);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  if (!fault) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.20)";
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  ctx.fillStyle = fault ? "#fff8f4" : "rgba(244, 247, 251, 0.96)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

function drawFaultBadge(ctx, t, now) {
  if (!(t.g.id === (typeof S !== "undefined" ? S.hover : null) || true)) return;
  const pulse = 1 + Math.sin(now / 320) * 0.055;
  const r = clamp(t.panelPx * 0.125, 9, 15) * pulse;
  const bx = t.cx;
  const by = Math.min(...t.frame.map(q => q.y)) - r - 8;
  ctx.save();
  // halo ring
  ctx.strokeStyle = rgba(PANEL_BORDER[t.st], 0.28);
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(bx, by, r + 5 + Math.sin(now / 320) * 2.5, 0, 7); ctx.stroke();
  // badge
  perfShadow(ctx, rgba(PANEL_BORDER[t.st], 0.75), 16);
  ctx.fillStyle = PANEL_BORDER[t.st];
  ctx.beginPath(); ctx.arc(bx, by, r, 0, 7); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(bx, by, r, 0, 7); ctx.stroke();
  // exclamation
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${(r * 1.35).toFixed(1)}px system-ui, sans-serif`;
  ctx.fillText("!", bx, by + 0.5);
  ctx.restore();
}

function drawPanelId(ctx, t, hovered, selected) {
  if (t.g.id !== hovered && t.g.id !== selected && t.st === "ok" && CAM.zoom < 1.9) return;
  const front = bilinear(t.glass, 0.5, 0);
  const text = "P-" + t.g.id.slice(1);
  const fpx = clamp(t.panelPx * 0.085, 7.5, 10);
  ctx.save();
  ctx.font = `700 ${fpx.toFixed(1)}px system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  const w = tw + 8, h = fpx + 5;
  const x = front.x - w / 2;
  const y = front.y + Math.max(5, t.panelPx * 0.028);
  ctx.fillStyle = "rgba(10, 12, 16, 0.68)";
  roundRect(ctx, x, y, w, h, 3.5);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.fillStyle = "rgba(240, 244, 250, 0.9)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

/* ============================================================
   Inverter + cabling
   ============================================================ */

function drawInverter(ctx, dev, now) {
  const g = INVERTER;
  const x0 = g.x - g.w / 2, x1 = g.x + g.w / 2;
  const y0 = g.y - g.d / 2, y1 = g.y + g.d / 2;
  const day = daylight();
  const light = 0.45 + 0.55 * day;

  // roof shadow
  const sh = [
    project(x0 - 0.5, y0 - 1.0, 0), project(x1 - 0.3, y0 - 1.0, 0),
    project(x1 - 0.3, y1 - 0.8, 0), project(x0 - 0.5, y1 - 0.8, 0),
  ];
  if (sh.every(Boolean)) {
    ctx.fillStyle = "rgba(0,0,0,0.40)";
    quadPath(ctx, sh);
    ctx.fill();
  }

  const front = [
    project(x0, y0, 0), project(x1, y0, 0),
    project(x1, y0, g.h), project(x0, y0, g.h),
  ];
  const side = [
    project(x0, y1, 0), project(x0, y0, 0),
    project(x0, y0, g.h), project(x0, y1, g.h),
  ];
  const top = [
    project(x0, y0, g.h), project(x1, y0, g.h),
    project(x1, y1, g.h), project(x0, y1, g.h),
  ];
  if (!front.every(Boolean) || !top.every(Boolean)) return;

  // side + top faces
  if (side.every(Boolean)) {
    const sg = perfGradient(ctx, "inv-side:" + Math.round(light * 50),
      side[0].x, side[0].y, side[2].x, side[2].y, [
        [0, shade("#1a2533", light)],
        [1, shade("#2b3b50", light)],
      ]);
    ctx.fillStyle = sg;
    quadPath(ctx, side);
    ctx.fill();
  }
  {
    const tg = perfGradient(ctx, "inv-top:" + Math.round(light * 50),
      top[3].x, top[3].y, top[1].x, top[1].y, [
        [0, shade("#384a60", light)],
        [1, shade("#1d2734", light)],
      ]);
    ctx.fillStyle = tg;
    quadPath(ctx, top);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 220, 180, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(top[3].x, top[3].y);
    ctx.lineTo(top[2].x, top[2].y);
    ctx.stroke();
  }

  // front metal face
  const fg = perfGradient(ctx, "inv-front:" + Math.round(light * 50),
    front[0].x, front[0].y, front[2].x, front[2].y, [
      [0, shade("#22303f", light)],
      [0.55, shade("#31445b", light)],
      [1, shade("#1b2531", light)],
    ]);
  ctx.fillStyle = fg;
  quadPath(ctx, front);
  ctx.fill();
  ctx.strokeStyle = "rgba(8, 10, 14, 0.8)";
  ctx.lineWidth = 1;
  quadPath(ctx, front);
  ctx.stroke();

  // ventilation grille (lower half of the front face)
  const slat = "rgba(6, 9, 13, 0.55)";
  ctx.strokeStyle = slat;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let v = 0.08; v <= 0.38; v += 0.045) {
    const a = bilinear(front, 0.14, 0.30 + v);
    const b = bilinear(front, 0.86, 0.30 + v);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // status screen (live inverter readout)
  const s0 = bilinear(front, 0.15, 0.64), s1 = bilinear(front, 0.86, 0.64);
  const s2 = bilinear(front, 0.86, 0.84), s3 = bilinear(front, 0.15, 0.84);
  const screen = [s0, s1, s2, s3];
  ctx.fillStyle = "#07100e";
  quadPath(ctx, screen);
  ctx.fill();
  ctx.strokeStyle = "rgba(140, 255, 210, 0.22)";
  ctx.lineWidth = 1;
  quadPath(ctx, screen);
  ctx.stroke();
  const sc = bilinear(screen, 0.5, 0.5);
  const kw = dev && dev.actual != null ? dev.actual.toFixed(2) : "0.00";
  ctx.save();
  perfShadow(ctx, "rgba(120, 255, 205, 0.6)", 8);
  ctx.fillStyle = "#8ff2c5";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${clamp((s1.x - s0.x) * 0.215, 10, 18).toFixed(1)}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(kw + " kW", sc.x, sc.y - 2);
  ctx.font = `600 ${clamp((s1.x - s0.x) * 0.085, 6, 8.5).toFixed(1)}px system-ui, sans-serif`;
  ctx.globalAlpha = 0.7;
  ctx.fillText("AC OUT", sc.x, sc.y + clamp((s2.y - s0.y) * 0.26, 7, 11));
  ctx.restore();

  // small status LED
  const led = bilinear(front, 0.88, 0.9);
  ctx.save();
  const on = dev ? dev.status === "ok" : true;
  ctx.fillStyle = on ? "#4ff0a2" : "#f0b44f";
  perfShadow(ctx, on ? "rgba(79,240,162,0.9)" : "rgba(240,180,79,0.9)", 8);
  ctx.beginPath();
  ctx.arc(led.x, led.y, Math.max(2, (s1.x - s0.x) * 0.014), 0, 7);
  ctx.fill();
  ctx.restore();

  // floating inverter label + hit zone
  const labelY = Math.max(...front.map(q => q.y)) + 16;
  drawSceneChip(ctx, front[3].x + (front[2].x - front[3].x) * 0.5, labelY, "INVERTER 01", dev ? `${dev.actual.toFixed(1)} kW` : "", "rgba(96, 200, 255, 0.75)");

  zones.inverter = {
    x: Math.min(...front.map(q => q.x), ...top.map(q => q.x)) - 6,
    y: Math.min(...front.map(q => q.y), ...top.map(q => q.y)) - 6,
    w: Math.max(...front.map(q => q.x), ...top.map(q => q.x)) - Math.min(...front.map(q => q.x), ...top.map(q => q.x)) + 12,
    h: Math.max(...front.map(q => q.y), ...top.map(q => q.y)) - Math.min(...front.map(q => q.y), ...top.map(q => q.y)) + 12,
  };
}

function drawSceneChip(ctx, x, y, title, value, dotColor) {
  const fpx = 9.5;
  ctx.save();
  ctx.font = `600 ${fpx}px system-ui, sans-serif`;
  const tw = ctx.measureText(title).width;
  ctx.font = `700 ${fpx}px system-ui, sans-serif`;
  const vw = value ? ctx.measureText(value).width : 0;
  const w = Math.max(tw + 18, tw + vw + 30);
  const h = value ? 37 : 23;
  ctx.fillStyle = "rgba(12, 14, 18, 0.72)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
  ctx.lineWidth = 0.8;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 7);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = dotColor;
  perfShadow(ctx, dotColor, 6);
  ctx.arc(x - w / 2 + 10, value ? y - 7 : y, 2.6, 0, 7);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(228, 232, 239, 0.9)";
  ctx.font = `600 ${fpx}px system-ui, sans-serif`;
  ctx.fillText(title, x - w / 2 + 17, value ? y - 7 : y);
  if (value) {
    ctx.font = `700 11px system-ui, sans-serif`;
    ctx.fillStyle = "#f2f4f7";
    ctx.fillText(value, x - w / 2 + 17, y + 10);
  }
  ctx.restore();
}

function drawCables(ctx, now, panelMap) {
  const day = daylight();
  const westSum = Object.values(panelMap).filter(p => p.col <= 6).reduce((s, p) => s + (p.actual || 0), 0);
  const eastSum = Object.values(panelMap).filter(p => p.col > 6).reduce((s, p) => s + (p.actual || 0), 0);

  const routes = [
    {
      pts: [[INVERTER.x - 0.9, INVERTER.y - 1.0], [-2.4, -4.9], [-8.0, -3.9], [-9.8, -3.9]],
      value: westSum, label: "PV 1", color: "#48e0d0", labelAt: [-8.0, -3.9],
    },
    {
      pts: [[INVERTER.x + 1.0, INVERTER.y - 1.0], [6.0, -4.8], [8.0, -3.9], [10.0, -3.9]],
      value: eastSum, label: "PV 2", color: "#f07ba8", labelAt: [8.0, -3.9],
    },
  ];

  for (const route of routes) {
    const proj = route.pts.map(([x, y]) => project(x, y, 0.045)).filter(Boolean);
    if (proj.length < 2) continue;
    ctx.save();
    // dark casing
    ctx.strokeStyle = "rgba(6, 10, 12, 0.85)";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(proj[0].x, proj[0].y);
    for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i].x, proj[i].y);
    ctx.stroke();
    // glowing conductor
    ctx.strokeStyle = rgba(route.color, 0.48 + 0.12 * day);
    perfShadow(ctx, rgba(route.color, 0.65), 7);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(proj[0].x, proj[0].y);
    for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i].x, proj[i].y);
    ctx.stroke();
    // flowing energy dashes
    perfShadow(ctx, rgba(route.color, 0.65), 5);
    ctx.strokeStyle = "rgba(230, 255, 252, 0.8)";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 16]);
    ctx.lineDashOffset = -(now / 55) % 19;
    ctx.beginPath();
    ctx.moveTo(proj[0].x, proj[0].y);
    for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i].x, proj[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // junction box + PV chip
    const end = project(route.labelAt[0], route.labelAt[1], 0.05);
    if (end) {
      ctx.save();
      ctx.fillStyle = "rgba(9, 12, 15, 0.9)";
      ctx.strokeStyle = rgba(route.color, 0.5);
      ctx.lineWidth = 1;
      const bw = Math.max(9, 18 * end.s * 0.035);
      roundRect(ctx, end.x - bw / 2, end.y - bw * 0.34, bw, bw * 0.68, 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      drawSceneChip(ctx, end.x, end.y - 25, route.label, `${route.value.toFixed(2)} kW`, route.color);
    }
  }
}

/* ============================================================
   Hit testing / camera interaction
   ============================================================ */

function twinHit(px, py) {
  if (VIEW.mode !== "roof" && TWIN3D && TWIN3D.isActive()) {
    return TWIN3D.hit(px, py);
  }
  if (VIEW.mode !== "roof" && typeof buildingTwinHit === "function") {
    return buildingTwinHit(px, py);
  }
  for (let i = PANEL_GEOM.length - 1; i >= 0; i--) {
    const g = PANEL_GEOM[i];
    if (pointInQuad(px, py, g.framePts)) return g.id;
  }
  for (const id of ["inverter", "solar"]) {
    const z = zones[id];
    if (!z) continue;
    if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) return id;
  }
  return null;
}

function clampCam() {
  CAM.x = Math.min(0, Math.max(TWIN.W * (1 - CAM.zoom), CAM.x));
  CAM.y = Math.min(0, Math.max(TWIN.H * (1 - CAM.zoom), CAM.y));
}

/* World-space pan: move the camera target parallel to the view plane.
   Unlike screen-space panning this works at any zoom, and is clamped to
   one view-distance around the preset's home target so users can't drift
   away from the scene. */
function panCamera(dx, dy) {
  if (!cam) return;
  const k = VIEW.dist / cam.focal;
  const home = VIEW.home || VIEW.target;
  const sx = -dx * cam.r.x + dy * cam.u.x;
  const sy = -dx * cam.r.y + dy * cam.u.y;
  const sz = -dx * cam.r.z + dy * cam.u.z;
  const lim = VIEW.dist;
  const next = {
    x: VIEW.target.x + sx * k,
    y: VIEW.target.y + sy * k,
    z: VIEW.target.z + sz * k,
  };
  // The WebGL camera supplies mode-aware pan bounds (room floor area,
  // floor slab, building envelope).  In a room the pivot translates with
  // the target so the camera and its look point move together; panning is
  // no longer an aim-only rotation.
  if (typeof cameraPanClamp === "function") {
    const p = cameraPanClamp(next);
    if (p) {
      VIEW.target.x = p.x; VIEW.target.y = p.y; VIEW.target.z = p.z;
      if (VIEW.pivot) {
        const np = cameraPanClamp({
          x: VIEW.pivot.x + sx * k,
          y: VIEW.pivot.y + sy * k,
          z: VIEW.pivot.z + sz * k,
        });
        if (np) {
          VIEW.pivot.x = np.x; VIEW.pivot.y = np.y; VIEW.pivot.z = np.z;
        }
        // The user has deliberately panned away from the equipment pivot;
        // subsequent orbits follow the panned point.
        if (typeof CAMCTL !== "undefined") CAMCTL.inspectId = null;
      }
      return;
    }
  }
  VIEW.target.x = clamp(next.x, home.x - lim, home.x + lim);
  VIEW.target.y = clamp(next.y, home.y - lim, home.y + lim);
  VIEW.target.z = clamp(next.z, home.z - lim, home.z + lim);
}

function zoomTwin(factor) {
  if (typeof cameraZoomBy === "function" && cameraZoomBy(factor)) {
    sceneInvalidate();
    return;
  }
  ZOOM.anchor = { x: TWIN.W / 2, y: TWIN.H / 2 };
  ZOOM.goal = clamp(ZOOM.goal * factor, CAM_MIN, CAM_MAX);
}

/* Pointer coordinates come back in CSS pixels, while the scene is drawn in
   backing-store pixels.  They are equal on normal screens, but a canvas that
   hit its 320px floor on a very narrow viewport is scaled by CSS; converting
   here keeps hover and clicks aligned with what is on screen. */
function twinEventPos(e) {
  const cv = document.getElementById("twin");
  const rect = cv.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;
  const sx = rect.width ? cssX * (TWIN.W / rect.width) : cssX;
  const sy = rect.height ? cssY * (TWIN.H / rect.height) : cssY;
  return { cssX, cssY, sx, sy };
}

/* ============================================================
   Frame loop
   ============================================================ */

function resizeTwin() {
  const cv = document.getElementById("twin");
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const dprCap = (typeof PERF !== "undefined") ? PERF.dprCap : 1.75;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCap));
  // 320px (not 900px) is the floor: below the old floor the backing store no
  // longer matched CSS pixels, which broke hit testing on tablets/phones.
  const W = Math.max(320, Math.round(rect.width));
  const H = Math.max(320, Math.round(rect.height));
  const changed = W !== TWIN.W || H !== TWIN.H || dpr !== TWIN.DPR;
  TWIN.W = W;
  TWIN.H = H;
  TWIN.DPR = dpr;
  if (changed) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    PROJ.sig = "";
    PROJ.map = null;
    // gradients bake in pixel coordinates: a resized canvas needs new ones
    if (typeof perfClearCaches === "function") perfClearCaches();
  }
  rebuildCamera();
  clampCam();
  if (TWIN3D && TWIN3D.isActive()) TWIN3D.resize(W, H, dpr);
  sceneInvalidate();
}

/* One 2D context per canvas, fetched once.  Re-fetching it every frame was
   unnecessary, and caching the failure lets the fallback trip immediately
   when the browser cannot provide a context at all. */
let TWIN_CTX = null;
let TWIN_CTX_FAILED = false;
function twinContext(cv) {
  if (TWIN_CTX) return TWIN_CTX;
  if (TWIN_CTX_FAILED) return null;
  try { TWIN_CTX = cv.getContext("2d"); } catch (_) { TWIN_CTX = null; }
  if (!TWIN_CTX) TWIN_CTX_FAILED = true;
  return TWIN_CTX;
}

function drawTwin(now) {
  const cv = document.getElementById("twin");
  if (!cv) return;
  const ctx = twinContext(cv);
  if (!ctx) { sceneContextLost(); return; }
  const W = TWIN.W, H = TWIN.H;
  ctx.setTransform(TWIN.DPR, 0, 0, TWIN.DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const snap = (typeof S !== "undefined") ? S.snap : null;
  const sim = snap ? snap.sim : { sun: 0.8, cloud: 0.3, temp_out: 24, weather: "auto" };
  rebuildCamera();
  // while the camera moves every projected point changes, so the cache would
  // only add Map churn; it is enabled again as soon as the camera settles
  projBeginFrame(!SCHED.busy && !SCHED.interacting);

  const glOn = !!(TWIN3D && TWIN3D.isActive());
  if (glOn && VIEW.mode === "roof") TWIN3D.setVisible(false);

  /* The WebGL prototype paints the sky, ground and buildings itself, so
     the 2D backdrop/roof layer is skipped while it is active.  Roof mode
     is always the original Canvas scene. */
  if (!glOn || VIEW.mode === "roof") {
    drawBackdrop(ctx, now, sim);
    drawRoof(ctx, now, sim);
  }

  if (!snap) {
    ctx.fillStyle = "rgba(220, 224, 232, 0.5)";
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Initialising digital twin…", W / 2, H / 2);
    return;
  }

  const panelMap = {};
  for (const p of snap.panels || []) panelMap[p.id] = p;
  const devs = {};
  for (const d of snap.devices || []) devs[d.id] = d;

  if (VIEW.mode !== "roof" && typeof drawBuildingView === "function") {
    if (glOn) {
      TWIN3D.render(now, VIEW, (typeof S !== "undefined") ? S : null, TWIN);
      // the overlay needs the selected level (S.view), not the camera state
      const viewSel = (typeof S !== "undefined" && S && S.view) ? S.view : VIEW;
      TWIN3D.overlay(ctx, now, viewSel, (typeof S !== "undefined") ? S : null);
    } else {
      drawBuildingView(ctx, now, snap);
    }
  } else {
    drawPanelShadows(ctx, panelMap, now);
    drawMounts(ctx);
    drawPanels(ctx, panelMap, now);
    drawCables(ctx, now, panelMap);
    drawInverter(ctx, devs.inverter, now);

    // aggregate selection ring around the array
    const highlighted = (typeof S !== "undefined") ? (S.hover || S.deviceId) : null;
    if (highlighted === "solar" && zones.solar) {
      const z = zones.solar;
      ctx.save();
      ctx.strokeStyle = "rgba(140, 220, 255, 0.55)";
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.2;
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // soft foreground grade so the bottom cards read cleanly
  const fg = perfGradient(ctx, "scene-foreground", 0, H * 0.72, 0, H, [
    [0, "rgba(0,0,0,0)"],
    [1, "rgba(0,0,0,0.34)"],
  ]);
  ctx.fillStyle = fg;
  ctx.fillRect(0, H * 0.72, W, H * 0.28);

  drawSceneFocus(ctx);
}

/* ============================================================
   Frame scheduling
   ------------------------------------------------------------
   The scene used to repaint on every animation frame forever.  One
   scheduler now decides whether a frame is worth drawing:

     dirty   data / hover / selection / theme / resize changed -> one frame
     busy    camera flight, zoom ease or explode easing          -> 60 fps
     pulse   a fault badge or selection needs its attention cue  -> ~9 fps
     idle    nothing to show moving                              -> no rAF,
             no timers, no battery drain

   Reduced-effects mode drops the pulse entirely and leaves only the
   still image until something actually changes.
   ============================================================ */

const SCHED = {
  raf: 0,
  timer: 0,
  dirty: true,
  paused: false,
  busy: false,
  interacting: false,
  interactingTimer: 0,
  lastDraw: 0,
  errors: 0,
};

const SCENE_PULSE_MS = 110;

function scenePulseInterval() {
  return (typeof PERF !== "undefined" && PERF.quality === "reduced") ? 400 : SCENE_PULSE_MS;
}

/* Only attention cues justify redrawing while nothing else moves:
   fault badges, anomaly outlines and the selected-object ring pulse. */
function scenePulseWanted() {
  if (typeof PERF !== "undefined" && PERF.quality === "reduced") return false;
  if (typeof S === "undefined" || !S.snap) return false;
  if (S.selection) return true;
  const sn = S.snap;
  if (sn.anomalies && sn.anomalies.length) return true;
  for (const p of sn.panels || []) if ((p.status || "ok") !== "ok") return true;
  for (const d of sn.devices || []) if ((d.status || "ok") !== "ok") return true;
  return false;
}

function sceneClearSchedule() {
  if (SCHED.raf) { cancelAnimationFrame(SCHED.raf); SCHED.raf = 0; }
  if (SCHED.timer) { clearTimeout(SCHED.timer); SCHED.timer = 0; }
}

function sceneRequestFrame() {
  if (SCHED.paused || (typeof document !== "undefined" && document.hidden) || SCHED.raf) return;
  SCHED.raf = requestAnimationFrame(sceneFrame);
}

function sceneInvalidate() {
  SCHED.dirty = true;
  sceneRequestFrame();
}

function sceneSchedulePulse(delay) {
  if (SCHED.paused || SCHED.timer) return;
  SCHED.timer = setTimeout(() => {
    SCHED.timer = 0;
    sceneRequestFrame();
  }, Math.max(16, delay));
}

/* Called while a pointer gesture moves the camera.  Projection caching is
   off during the gesture; when it ends one last draw repopulates the cache. */
function sceneInteract() {
  SCHED.interacting = true;
  if (SCHED.interactingTimer) clearTimeout(SCHED.interactingTimer);
  SCHED.interactingTimer = setTimeout(() => {
    SCHED.interacting = false;
    SCHED.interactingTimer = 0;
    sceneInvalidate();
  }, 220);
}

function sceneSetPaused(on) {
  SCHED.paused = !!on;
  if (SCHED.paused) sceneClearSchedule();
  else sceneInvalidate();
}

function sceneFrame(now) {
  SCHED.raf = 0;
  if (SCHED.paused || (typeof document !== "undefined" && document.hidden)) return;
  if (typeof PERF !== "undefined") PERF.counters.frames += 1;

  const busy = (typeof animateCameraStep === "function") ? animateCameraStep(now) : false;
  SCHED.busy = busy;
  const pulse = !busy && scenePulseWanted();
  const interval = scenePulseInterval();
  const due = busy || SCHED.dirty || (pulse && now - SCHED.lastDraw >= interval - 4);

  if (due) {
    const t0 = performance.now();
    try {
      drawTwin(now);
      SCHED.dirty = false;
      SCHED.lastDraw = now;
      if (typeof perfNoteDraw === "function") perfNoteDraw(performance.now() - t0);
    } catch (err) {
      sceneRenderFailed(err);
      return;
    }
  } else if (typeof PERF !== "undefined") {
    PERF.counters.skipped += 1;
  }

  if (busy) { sceneRequestFrame(); return; }
  if (!SCHED.dirty && pulse) {
    sceneSchedulePulse(interval - (performance.now() - SCHED.lastDraw));
  }
}

/* Three failed draws mean the scene is not coming back on this canvas;
   trip the equipment-list fallback rather than burning frames on errors. */
function sceneRenderFailed(err) {
  SCHED.dirty = false;
  SCHED.errors += 1;
  if (typeof PERF !== "undefined") PERF.counters.renderErrors += 1;
  if (SCHED.errors === 1 && typeof console !== "undefined") {
    console.error("Digital twin render error:", err);
  }
  if (SCHED.errors >= 3) {
    sceneSetPaused(true);
    if (typeof FALLBACK !== "undefined" && FALLBACK && typeof FALLBACK.activate === "function") {
      FALLBACK.activate("render-error", err);
    }
    return;
  }
  sceneSchedulePulse(900);
}

function sceneContextLost() {
  sceneSetPaused(true);
  if (TWIN_CTX_FAILED) {
    if (typeof PERF !== "undefined") PERF.counters.renderErrors += 1;
    if (typeof FALLBACK !== "undefined" && FALLBACK && typeof FALLBACK.activate === "function") {
      FALLBACK.activate("canvas2d");
    }
  }
}

/* ---------------- keyboard focus in the scene ---------------- */

/* Ordered, de-duplicated list of objects the scene can currently select.
   Roof view lists panels then aggregates; building views use the hit
   registry left by the last draw, most specific object first. */
function sceneSelectables() {
  const out = [];
  if (typeof S === "undefined" || !S.snap) return out;
  if (VIEW.mode !== "roof" && TWIN3D && TWIN3D.isActive()) {
    return TWIN3D.selectables();
  }
  if (VIEW.mode === "roof") {
    if (PANEL_GEOM.length) {
      for (const g of PANEL_GEOM) out.push({ id: g.id, kind: "panel" });
    } else {
      // before the first draw (or with the canvas unavailable) the snapshot
      // still knows the panel order
      for (const p of S.snap.panels || []) out.push({ id: p.id, kind: "panel" });
    }
    out.push({ id: "solar", kind: "device" });
    out.push({ id: "inverter", kind: "device" });
    return out;
  }
  const groups = [
    ["devices", "device"], ["rooms", "room"], ["roofs", "roof"],
    ["floors", "floor"], ["buildings", "building"],
  ];
  const seen = new Set();
  for (const [list, kind] of groups) {
    const arr = (typeof HIT !== "undefined" && HIT[list]) || [];
    for (const z of arr) {
      if (!z || seen.has(z.id)) continue;
      seen.add(z.id);
      // In campus view the roof hit zone is registered under the building id
      // (clicking it opens the building), so trust the object lookup for the
      // announced kind instead of the registry group it came from.
      const thing = (typeof findTwinThing === "function") ? findTwinThing(z.id) : null;
      out.push({ id: z.id, kind: thing ? thing.kind : kind });
    }
  }
  return out;
}

function sceneFocusRect(id) {
  if (!id) return null;
  if (VIEW.mode !== "roof" && TWIN3D && TWIN3D.isActive()) {
    return TWIN3D.focusRect(id);
  }
  if (VIEW.mode === "roof") {
    const g = PANEL_GEOM.find(x => x.id === id);
    if (g) {
      const xs = g.framePts.map(p => p.x), ys = g.framePts.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys),
               w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    const z = zones[id];
    return z ? { x: z.x, y: z.y, w: z.w, h: z.h } : null;
  }
  if (typeof HIT === "undefined") return null;
  const lists = [HIT.devices, HIT.rooms, HIT.roofs, HIT.floors, HIT.buildings];
  for (const list of lists) {
    const z = list.find(q => q.id === id);
    if (z) return { x: z.x, y: z.y, w: z.w, h: z.h };
  }
  return null;
}

/* White dashed ring, clearly distinct from the cyan selection glow, drawn
   around whatever the keyboard is currently focused on. */
function drawSceneFocus(ctx) {
  if (typeof KB === "undefined" || !KB.active || !KB.focusId || KB.pointerRing) return;
  const r = sceneFocusRect(KB.focusId);
  if (!r) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  roundRect(ctx, r.x - 5, r.y - 5, r.w + 10, r.h + 10, 6);
  ctx.stroke();
  ctx.restore();
}

/* ---------------- WebGL prototype bootstrap ---------------- */

function twin3dRequested() {
  try {
    const v = (new URLSearchParams(location.search).get("render") || "").toLowerCase();
    // WebGL is the default renderer. The legacy Canvas renderer is an
    // explicit opt-out (?render=canvas), and ?render=gl|webgl remains
    // accepted as the explicit spelling of the default.
    if (v === "canvas" || v === "canvas2d" || v === "2d") return false;
    return true;
  } catch (_) { return true; }
}

function twin3dSupported() {
  try {
    if (typeof WebGL2RenderingContext === "undefined") return false;
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2", { failIfMajorPerformanceCaveat: false, antialias: true });
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return true;
  } catch (_) { return false; }
}

function initTwin3D() {
  if (TWIN3D || TWIN3D_LOADING || TWIN3D_FAILED) return;
  if (!twin3dRequested()) return;
  if (!twin3dSupported()) {
    TWIN3D_FAILED = true;
    if (typeof console !== "undefined") {
      console.info("Twin3D: WebGL2 is unavailable here — using the Canvas renderer.");
    }
    return;
  }
  TWIN3D_LOADING = true;
  import("./twin3d.js").then((mod) => {
    TWIN3D_LOADING = false;
    const glCanvas = document.getElementById("twin-gl");
    if (!glCanvas) { TWIN3D_FAILED = true; return; }
    TWIN3D = mod.createTwin3D({
      canvas: glCanvas,
      BUILD,
      roomRect,
      twin: TWIN,
      cam: CAM,
      view: VIEW,
      sceneOffset: SCENE,
      state: () => (typeof S !== "undefined" ? S : null),
      stColor,
      drawSceneChip,
      drawAnomalyBadge,
      findTwinThing: (id) => (typeof findTwinThing === "function" ? findTwinThing(id) : null),
      vizSpaceColor: (space) => (typeof vizSpaceColor === "function" ? vizSpaceColor(space) : null),
      vizSpaceChip: (space, compact) => (typeof vizSpaceChip === "function" ? vizSpaceChip(space, compact) : null),
      vizMode: () => (typeof VIZ !== "undefined" ? VIZ.mode : "status"),
      reduced: () => (typeof PERF !== "undefined" && PERF.quality === "reduced"),
      sceneInvalidate: () => sceneInvalidate(),
    });
    if (TWIN3D && TWIN3D.isActive()) {
      if (typeof console !== "undefined") {
        console.info("Twin3D: WebGL renderer active (default; ?render=canvas opts out).");
      }
      resizeTwin();
      if (typeof resetCameraForRenderer === "function") resetCameraForRenderer();
      sceneInvalidate();
    } else {
      TWIN3D = null;
      TWIN3D_FAILED = true;
    }
  }).catch((err) => {
    TWIN3D_LOADING = false;
    TWIN3D_FAILED = true;
    if (typeof console !== "undefined") {
      console.warn("Twin3D: module failed to load — keeping the Canvas renderer.", err);
    }
  });
}

/* ---------------- lifecycle ---------------- */

let SCENE_AC = null;

function disposeScene() {
  sceneClearSchedule();
  if (SCHED.interactingTimer) { clearTimeout(SCHED.interactingTimer); SCHED.interactingTimer = 0; }
  if (SCENE_AC) { SCENE_AC.abort(); SCENE_AC = null; }
  if (TWIN3D) { try { TWIN3D.dispose(); } catch (_) {} TWIN3D = null; }
  PANEL_GEOM.length = 0;
  for (const k of Object.keys(zones)) delete zones[k];
  PROJ.map = null;
  PROJ.sig = "";
  TWIN_CTX = null;
  TWIN_CTX_FAILED = false;
  if (typeof perfDispose === "function") perfDispose();
  if (typeof clearCssVarCache === "function") clearCssVarCache();
}

function startTwinLoop() {
  const cv = document.getElementById("twin");
  const tip = document.getElementById("twin-tip");
  const stage = document.getElementById("stage");
  if (!cv) return;
  if (!SCENE_AC) SCENE_AC = new AbortController();
  const sig = { signal: SCENE_AC.signal };
  resizeTwin();
  initTwin3D();
  window.addEventListener("resize", () => {
    resizeTwin();
    if (typeof renderMainChart === "function") renderMainChart();
  }, sig);
  // A hidden tab paints nothing: drop the pending frame and resume on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sceneClearSchedule();
    else if (!SCHED.paused) sceneInvalidate();
  }, sig);

  // Hover redraws only when the target changes; crossing one panel just
  // repositions the tooltip.
  let hoverId = null;
  cv.addEventListener("mousemove", (e) => {
    // A drag must never run hover raycasts or overwrite the grabbing cursor.
    if (SCHED.paused || document.body.classList.contains("cam-dragging")) return;
    const { cssX, cssY, sx, sy } = twinEventPos(e);
    const id = twinHit(sx, sy);
    const changed = id !== hoverId;
    hoverId = id;
    if (typeof S !== "undefined" && S.hover !== id) S.hover = id;
    const is3d = typeof TWIN3D !== "undefined" && TWIN3D && TWIN3D.isActive();
    cv.style.cursor = id ? "pointer" : (is3d || CAM.zoom > 1 ? "grab" : "default");
    if (!id || typeof S === "undefined" || !S.snap) {
      tip.classList.add("hidden");
      if (changed) sceneInvalidate();
      return;
    }
    // Rebuilding the tooltip DOM is only needed when the hovered object
    // changes; the same panel under a moving cursor just repositions it.
    if (changed || tip.classList.contains("hidden")) {
      const thing = (typeof findTwinThing === "function") ? findTwinThing(id) : null;
      if (thing && thing.kind !== "device") {
        if (typeof renderTwinTip === "function") renderTwinTip(thing);
        else tip.classList.add("hidden");
      } else {
        const d = thing && thing.d ? thing.d : findTwinDevice(id);
        if (!d) { tip.classList.add("hidden"); return; }
        if (d.kind === "panel") {
          const st = PANEL_STATUS[d.status] || PANEL_STATUS.ok;
          const perf = d.extra && d.extra.performance != null ? d.extra.performance.toFixed(1) + "% perf" : "no sunlight";
          const faultNames = (d.faults || []).map(f => f.name).join(", ");
          tip.classList.remove("hidden");
          tip.innerHTML = `<div class="tip-name">${escapeHTML(d.name)} · row ${d.row} · col ${d.col}</div>
            <div class="tip-row">${d.actual.toFixed(2)} kW actual · ${d.expected.toFixed(2)} kW expected · ${perf}</div>
            <div class="tip-row">status: <span style="color:${cssVar(st.color)}">${st.glyph} ${st.label}</span>${faultNames ? " · " + escapeHTML(faultNames) : ""}</div>`;
        } else {
          const st = STATUS[d.status] || STATUS.ok;
          tip.classList.remove("hidden");
          tip.innerHTML = `<div class="tip-name">${escapeHTML(d.name)}</div>
            <div class="tip-row">${d.actual.toFixed(1)} kW actual · ${d.expected.toFixed(1)} kW expected</div>
            <div class="tip-row">status: <span style="color:${cssVar(st.color)}">${st.glyph} ${st.label}</span></div>`;
        }
      }
      sceneInvalidate();
    }
    const w = stage ? stage.clientWidth : TWIN.W;
    tip.style.left = Math.min(cssX + 16, w - 260) + "px";
    tip.style.top = Math.max(cssY - 52, 6) + "px";
  }, sig);
  cv.addEventListener("mouseleave", () => {
    hoverId = null;
    if (typeof S !== "undefined") S.hover = null;
    tip.classList.add("hidden");
    sceneInvalidate();
  }, sig);

  // Smooth zoom: the wheel only sets a goal; the frame loop eases CAM.zoom
  // toward it while keeping the point under the cursor anchored.
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { sx, sy } = twinEventPos(e);
    if (typeof cameraWheel === "function") {
      cameraWheel(e.deltaY, { x: sx, y: sy });
      sceneInvalidate();
      return;
    }
    ZOOM.anchor = { x: sx, y: sy };
    ZOOM.goal = clamp(ZOOM.goal * Math.exp(-e.deltaY * 0.0012), CAM_MIN, CAM_MAX);
    sceneInvalidate();   // the camera easing below keeps frames coming until settled
  }, { passive: false, signal: SCENE_AC.signal });

  // Gestures: left drag orbits, right/shift/middle drag pans, wheel zooms.
  // Pointer capture keeps a drag alive over the floating cards and outside
  // the canvas, so a pan never turns into a text selection or a click on an
  // overlapping panel.  Touch is handled by the touch listeners below.
  let dragState = null, lastDragMoved = 0;
  const endDrag = (pointerId) => {
    if (!dragState || (pointerId != null && dragState.pointerId !== pointerId)) return;
    lastDragMoved = dragState.moved;
    try { if (cv.hasPointerCapture && cv.hasPointerCapture(dragState.pointerId)) cv.releasePointerCapture(dragState.pointerId); } catch (_) { /* ignore */ }
    dragState = null;
    document.body.classList.remove("cam-dragging");
    cv.style.cursor = "";
    if (typeof cameraGestureEnd === "function") cameraGestureEnd();
  };
  cv.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;      // dedicated touch gestures below
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const pan = e.button === 1 || e.button === 2 || e.shiftKey || e.altKey;
    // Prevent native text selection / drag; restore canvas focus for keyboard
    // users because preventDefault suppresses the default focus action.
    e.preventDefault();
    // Real pointer input may focus the scene (keyboard ring policy handles
    // the modality); synthetic test events must not steal focus.
    if (e.isTrusted) {
      try { cv.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    dragState = { x: e.clientX, y: e.clientY, moved: 0, pan, pointerId: e.pointerId };
    lastDragMoved = 0;
    if (typeof cancelFlight === "function") cancelFlight();
    if (typeof cameraGestureStart === "function") cameraGestureStart(pan ? "pan" : "orbit");
    ZOOM.anchor = null;
    document.body.classList.add("cam-dragging");
    sceneInteract();
    cv.style.cursor = "grabbing";
  }, sig);
  cv.addEventListener("contextmenu", (e) => e.preventDefault(), sig);
  // Only suppress the context menu while a 3D drag is active or the pointer
  // is over the viewport.  Normal browser menus elsewhere are unaffected.
  window.addEventListener("contextmenu", (e) => {
    if (dragState || e.target === cv || e.target === document.getElementById("twin-gl")) {
      e.preventDefault();
    }
  }, true);
  window.addEventListener("pointermove", (e) => {
    if (!dragState || e.pointerType === "touch") return;
    const dx = e.clientX - dragState.x;
    const dy = e.clientY - dragState.y;
    dragState.moved += Math.abs(dx) + Math.abs(dy);
    dragState.x = e.clientX; dragState.y = e.clientY;
    if (dragState.pan) {
      if (typeof cameraInputPan === "function") cameraInputPan(dx, dy);
      else panCamera(dx, dy);
    } else if (typeof cameraInputOrbit === "function") {
      cameraInputOrbit(dx, dy);
    } else if (typeof cameraOrbitBy === "function") {
      cameraOrbitBy(dx, dy);
    } else {
      // orbit around the current target
      VIEW.yaw -= dx * 0.005;
      VIEW.pitch = clamp(VIEW.pitch - dy * 0.004, 0.18, 1.45);
    }
    sceneInvalidate();
  }, sig);
  window.addEventListener("pointerup", (e) => endDrag(e.pointerId), sig);
  window.addEventListener("pointercancel", (e) => endDrag(e.pointerId), sig);
  window.addEventListener("blur", () => endDrag(null), sig);

  // Touch: one finger orbits, two fingers pinch-zoom + pan.
  let touchState = null;
  const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  cv.addEventListener("touchstart", (e) => {
    if (typeof cancelFlight === "function") cancelFlight();
    ZOOM.anchor = null;
    sceneInteract();
    if (e.touches.length === 1) {
      touchState = { mode: "orbit", x: e.touches[0].clientX, y: e.touches[0].clientY, moved: 0 };
      if (typeof cameraGestureStart === "function") cameraGestureStart("orbit");
    } else if (e.touches.length >= 2) {
      touchState = {
        mode: "pinch", dist: touchDist(e.touches),
        mx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        my: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        moved: 100,  // a pinch is never a tap
      };
      if (typeof cameraGestureStart === "function") cameraGestureStart("pinch");
    }
  }, { passive: true, signal: SCENE_AC.signal });
  cv.addEventListener("touchmove", (e) => {
    if (!touchState) return;
    e.preventDefault();
    if (touchState.mode === "orbit" && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - touchState.x, dy = t.clientY - touchState.y;
      touchState.moved += Math.abs(dx) + Math.abs(dy);
      touchState.x = t.clientX; touchState.y = t.clientY;
      if (typeof cameraInputOrbit === "function") cameraInputOrbit(dx, dy);
      else if (typeof cameraOrbitBy === "function") cameraOrbitBy(dx, dy);
      else {
        VIEW.yaw -= dx * 0.005;
        VIEW.pitch = clamp(VIEW.pitch - dy * 0.004, 0.18, 1.45);
      }
    } else if (e.touches.length >= 2) {
      const d = touchDist(e.touches);
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = cv.getBoundingClientRect();
      ZOOM.anchor = { x: mx - rect.left, y: my - rect.top };
      if (touchState.dist > 0) {
        if (typeof cameraPinchZoom === "function") {
          cameraPinchZoom(d / touchState.dist, { x: mx - rect.left, y: my - rect.top });
        } else {
          ZOOM.goal = clamp(ZOOM.goal * (d / touchState.dist), CAM_MIN, CAM_MAX);
        }
      }
      panCamera(mx - touchState.mx, my - touchState.my);
      touchState.dist = d; touchState.mx = mx; touchState.my = my;
    }
    sceneInvalidate();
  }, { passive: false, signal: SCENE_AC.signal });
  cv.addEventListener("touchend", () => {
    lastDragMoved = touchState ? touchState.moved : 0;
    touchState = null;
    ZOOM.anchor = null;
    if (typeof cameraGestureEnd === "function") cameraGestureEnd();
  }, sig);
  cv.addEventListener("touchcancel", () => {
    touchState = null;
    ZOOM.anchor = null;
    if (typeof cameraGestureEnd === "function") cameraGestureEnd();
  }, sig);

  cv.addEventListener("click", (e) => {
    if (lastDragMoved > 6) return;
    const { sx, sy } = twinEventPos(e);
    const id = twinHit(sx, sy);
    if (!id) return;
    if (typeof openLevel === "function" && typeof findTwinThing === "function") {
      const thing = findTwinThing(id);
      if (thing && thing.kind !== "device") {
        openLevel(id);
        sceneInvalidate();
        return;
      }
    }
    if (typeof openDrawer === "function") openDrawer(id);
    sceneInvalidate();
  }, sig);
}
