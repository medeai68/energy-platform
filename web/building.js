/* ============================================================
   Interactive 3D smart building — campus / building / floor / room
   Extends the hand-rolled perspective camera of scene.js (project,
   quadPath, drawSceneChip, VIEW, S) with procedural building geometry:
     - campus: two glass commercial buildings on a shared ground plane
     - building: stacked floors behind a translucent curtain wall,
       floor bands and the rooftop PV plant are clickable
     - floor: cutaway plan view with rooms, furniture and live
       equipment glyphs (lights, plugs, FCU, racks, elevator)
     - room: close-up of one room with its devices and live readouts
   Every level and device is hit-testable; scene.js dispatches hover
   tips and clicks through findTwinThing / buildingTwinHit.
   ============================================================ */

"use strict";

/* ---------------- world layout ---------------- */

const BUILD = {
  groundZ: -3.3,
  b1: {
    id: "b1", name: "Tower A", x0: -16.5, x1: 16.5, y0: -12.5, y1: 12.5,
    fh: 1.1, roofZ: 0, solar: true,
    elevator: { fx: 0.895, fy: 0.44, fw: 0.07, fd: 0.16 },
    floors: [
      { id: "b1f1", name: "Floor 1", rooms: [
        { id: "b1f1r1", name: "Lobby", usage: "lobby", fx: 0.02, fy: 0.06, fw: 0.46, fd: 0.38 },
        { id: "b1f1r2", name: "Open Office 1", usage: "office", fx: 0.02, fy: 0.56, fw: 0.46, fd: 0.38 },
        { id: "b1f1r3", name: "Meeting Room", usage: "meeting", fx: 0.56, fy: 0.56, fw: 0.33, fd: 0.38 },
        { id: "b1f1r4", name: "Restrooms", usage: "services", fx: 0.56, fy: 0.06, fw: 0.33, fd: 0.38 },
      ]},
      { id: "b1f2", name: "Floor 2", rooms: [
        { id: "b1f2r1", name: "Open Office 2", usage: "office", fx: 0.02, fy: 0.56, fw: 0.46, fd: 0.38 },
        { id: "b1f2r2", name: "Server Room", usage: "server", fx: 0.56, fy: 0.06, fw: 0.33, fd: 0.38 },
        { id: "b1f2r3", name: "Meeting Room", usage: "meeting", fx: 0.56, fy: 0.56, fw: 0.33, fd: 0.38 },
        { id: "b1f2r4", name: "Pantry", usage: "services", fx: 0.02, fy: 0.06, fw: 0.46, fd: 0.38 },
      ]},
      { id: "b1f3", name: "Floor 3", rooms: [
        { id: "b1f3r1", name: "Executive Suite", usage: "office", fx: 0.02, fy: 0.56, fw: 0.46, fd: 0.38 },
        { id: "b1f3r2", name: "Open Office 3", usage: "office", fx: 0.02, fy: 0.06, fw: 0.46, fd: 0.38 },
        { id: "b1f3r3", name: "Meeting Room", usage: "meeting", fx: 0.56, fy: 0.56, fw: 0.33, fd: 0.38 },
        { id: "b1f3r4", name: "Restrooms", usage: "services", fx: 0.56, fy: 0.06, fw: 0.33, fd: 0.38 },
      ]},
    ],
  },
  b2: {
    id: "b2", name: "Annex B", x0: 22, x1: 38, y0: -6, y1: 6,
    fh: 1.2, roofZ: -0.9, solar: false,
    floors: [
      { id: "b2f1", name: "Floor 1", rooms: [
        { id: "b2f1r1", name: "Reception", usage: "lobby", fx: 0.04, fy: 0.06, fw: 0.48, fd: 0.40 },
        { id: "b2f1r2", name: "Workshop", usage: "office", fx: 0.04, fy: 0.54, fw: 0.48, fd: 0.40 },
        { id: "b2f1r3", name: "Storage", usage: "storage", fx: 0.58, fy: 0.06, fw: 0.38, fd: 0.88 },
      ]},
      { id: "b2f2", name: "Floor 2", rooms: [
        { id: "b2f2r1", name: "Studio", usage: "office", fx: 0.04, fy: 0.06, fw: 0.48, fd: 0.88 },
        { id: "b2f2r2", name: "Office", usage: "office", fx: 0.58, fy: 0.06, fw: 0.38, fd: 0.48 },
        { id: "b2f2r3", name: "Restrooms", usage: "services", fx: 0.58, fy: 0.60, fw: 0.38, fd: 0.34 },
      ]},
    ],
  },
};

for (const b of Object.values(BUILD)) {
  if (typeof b !== "object" || !b.floors) continue;
  b.w = b.x1 - b.x0; b.d = b.y1 - b.y0;
  b.cx = (b.x0 + b.x1) / 2; b.cy = (b.y0 + b.y1) / 2;
  b.groundZ = b.roofZ - b.floors.length * b.fh;
}

const ST_COLORS = { ok: "#4ff0a2", warning: "#f0b44f", serious: "#ef6a45", critical: "#e04646" };
const USAGE_TINT = {
  office: "rgba(140, 170, 205, 0.05)",
  meeting: "rgba(150, 165, 190, 0.05)",
  lobby: "rgba(160, 150, 200, 0.06)",
  server: "rgba(120, 190, 190, 0.07)",
  services: "rgba(150, 155, 165, 0.05)",
  storage: "rgba(160, 140, 120, 0.05)",
};

/* ---------------- camera ---------------- */

const CAM_PRESETS = {
  roof: { yaw: -0.60, pitch: 0.78, dist: 24.5, target: { x: 0.3, y: 0.15, z: 0.38 } },
  campus: { yaw: -0.62, pitch: 0.50, dist: 62, target: { x: 9, y: -1, z: -2.0 } },
};

/* Exploded floor view (feature A). `t` eases 0..1 so floors slide apart
   rather than jumping; only the building view applies a lift. */
const EXPLODE = { on: false, t: 0, gap: 0.7 };

let flight = null;  // keyframed camera path: { keys: [{v, dur, from}], i, t, last }
let LAST_SEL = { mode: null, buildingId: null, floorId: null, roomId: null };

/* Quintic smootherstep: zero velocity AND zero acceleration at both ends,
   so a transition starts and settles without a visible kick. */
function smootherstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/* Shortest signed angular delta.  Yaw is intentionally unbounded (the user
   can keep orbiting past 360°); flights must still take the short way round
   instead of spinning through several turns to a wrapped destination. */
function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function lerpAngle(from, to, k) {
  return from + shortestAngle(from, to) * k;
}

function cameraFlightActive() {
  return !!flight;
}

/* The initial page view is chosen before the lazy WebGL module finishes
   loading, so it uses the Canvas camera units.  Once the presentation
   renderer is alive, snap the current view onto its authored framing
   instead of leaving the camera at an unrelated compact preset. */
function resetCameraForRenderer() {
  LAST_SEL = { mode: null, buildingId: null, floorId: null, roomId: null };
  VIEW.pivot = null;
  if (typeof S !== "undefined" && S.view && typeof flyToView === "function") {
    flyToView(S.view);
  }
}

/* Cancel any running camera flight (manual orbit/pan/zoom takes over).
   The current eye pose is kept, so the user can continue from exactly
   where the animation stopped. */
function cancelFlight() {
  if (!flight) return false;
  flight = null;
  if (VIEW.transition) {
    VIEW.transition.interrupted = true;
    VIEW.transition.ended = performance.now();
  }
  if (typeof cameraFlightInterrupted === "function") cameraFlightInterrupted();
  return true;
}

function currentCameraEye() {
  const p = VIEW.pivot || VIEW.target;
  const cosP = Math.cos(VIEW.pitch), sinP = Math.sin(VIEW.pitch);
  return {
    x: p.x + Math.sin(VIEW.yaw) * VIEW.dist * cosP,
    y: p.y - Math.cos(VIEW.yaw) * VIEW.dist * cosP,
    z: p.z + VIEW.dist * sinP,
  };
}

/* The WebGL room camera orbits a pivot that is not the look target.  When a
   transition leaves that room, fold the real eye back into target-relative
   orbit values before the Canvas / standard keyframe path uses them. */
function detachPivot() {
  if (!VIEW.pivot) return;
  const eye = currentCameraEye();
  const dx = eye.x - VIEW.target.x;
  const dy = eye.y - VIEW.target.y;
  const dz = eye.z - VIEW.target.z;
  const dist = Math.max(0.05, Math.hypot(dx, dy, dz));
  VIEW.yaw = Math.atan2(dx, -dy);
  VIEW.pitch = Math.asin(Math.max(-1, Math.min(1, dz / dist)));
  VIEW.dist = dist;
  VIEW.pivot = null;
}

/* Is the eye physically inside the room it claims to be leaving?  Used to
   decide whether a reverse transition should play the authored window /
   door exit path.  An interrupted or retargeted flight can have LAST_SEL
   pointing at a room the camera never actually entered; in that case the
   path must not teleport back to that room's façade. */
function cameraInsideLastRoom() {
  if (LAST_SEL.mode !== "room" || !LAST_SEL.roomId) return null;
  const P = (typeof window !== "undefined") ? window.TWIN3D_PRESENT : null;
  if (!P) return LAST_SEL.roomId;   // Canvas coordinates are a different scale
  const r = P.rooms[LAST_SEL.roomId];
  const f = r && P.floors[r.floorId];
  if (!r || !f) return null;
  const eye = P.eyeFromOrbit(VIEW);
  const pad = 2.4;
  const inside = eye.x > r.rect.x0 - pad && eye.x < r.rect.x1 + pad
    && eye.y > r.rect.y0 - pad && eye.y < r.rect.y1 + pad
    && eye.z > f.base - 1.0 && eye.z < f.base + f.height + 1.0;
  return inside ? LAST_SEL.roomId : null;
}

/* Called when an eased flight reaches its destination (or settles
   immediately on a renderer handoff).  The navigation header already shows
   the destination; this records that the camera actually arrived and lets
   the room camera arm its interior pivot and any queued equipment focus. */
function finishCameraTransition() {
  const meta = VIEW.transition;
  if (meta) {
    meta.ended = performance.now();
    meta.mode = meta.mode || VIEW.mode;
  }
  LAST_SEL = {
    mode: VIEW.mode,
    buildingId: (meta && meta.buildingId) || null,
    floorId: (meta && meta.floorId) || null,
    roomId: (meta && meta.roomId) || null,
  };
  if (typeof cameraTransitionComplete === "function") {
    cameraTransitionComplete(meta);
  }
}

/* Animate orbit parameters directly (presets, equipment focus, room
   reframing).  Unlike the cinematic polyline this stays in view space, so
   the eye arcs around the pivot and the target stays fixed. */
function startOrbitFlight(pose, opts) {
  const o = opts || {};
  cancelFlight();
  if (typeof cameraFlightStarting === "function") cameraFlightStarting();
  const cur = {
    yaw: VIEW.yaw, pitch: VIEW.pitch, dist: VIEW.dist,
    target: { x: VIEW.target.x, y: VIEW.target.y, z: VIEW.target.z },
    pivot: VIEW.pivot ? { x: VIEW.pivot.x, y: VIEW.pivot.y, z: VIEW.pivot.z } : null,
  };
  const destPivot = o.keepPivot && cur.pivot
    ? { ...cur.pivot }
    : (pose.pivot ? { ...pose.pivot } : null);
  const dest = {
    yaw: cur.yaw + shortestAngle(cur.yaw, pose.yaw),
    pitch: pose.pitch,
    dist: pose.dist,
    target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
    pivot: destPivot,
  };
  const fromMode = VIEW.mode;
  flight = {
    keys: [{ v: dest, dur: Math.max(120, o.dur || 650) }],
    i: 0, t: 0, from: cur,
    last: performance.now(),
  };
  VIEW.transition = {
    kind: o.kind || "camera-move",
    mode: fromMode,
    buildingId: S.view ? S.view.buildingId : null,
    floorId: S.view ? S.view.floorId : null,
    roomId: S.view ? S.view.roomId : null,
    keyframes: 1,
    started: performance.now(),
  };
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

/* ---------------- WebGL presentation camera ----------------
   The opt-in WebGL renderer authors its architecture at metre scale
   (twin3d-presentation.js), so the compact Canvas orbit presets would
   put the camera inside a wall.  While that renderer is alive it
   publishes PRESENT and these transitions use the authored cinematic
   polyline instead: approach the façade, pass the selected floor,
   enter through the room's exterior wall and settle on its viewpoint.
   The Canvas path further down is untouched and runs unchanged when
   the prototype is absent or unavailable. */

function catmullAt(pts, u) {
  const n = pts.length;
  if (!n) return null;
  if (n === 1) return { x: pts[0].x, y: pts[0].y, z: pts[0].z };
  const x = Math.max(0, Math.min(1, u)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  // endpoint knots are duplicated, which halves their tangent and stops
  // the spline from overshooting past the authored final viewpoint
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n - 1, i + 2)];
  const f2 = f * f, f3 = f2 * f;
  const out = {};
  for (const k of ["x", "y", "z"]) {
    out[k] = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * f
      + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2
      + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3);
  }
  return out;
}

/* Returns true when the presentation renderer handled the transition. */
function flyPresentation(P, mode, ids) {
  let dest = null;
  if (mode === "campus") {
    dest = P.campusView();
  } else if (mode === "building") {
    const bId = ids.buildingId || "b1";
    if (!P.towers[bId]) return false;
    dest = P.buildingView(bId, ids.floorId || null, EXPLODE.on ? 1 : 0);
  } else if (mode === "floor") {
    if (!ids.floorId || !P.floors[ids.floorId]) return false;
    dest = P.floorView(ids.floorId, EXPLODE.on ? 1 : 0);
  } else if (mode === "room") {
    if (!ids.roomId || !P.rooms[ids.roomId]) return false;
    dest = P.roomView(ids.roomId);
  } else {
    return false;   // roof and unknown modes stay on the Canvas scene
  }
  if (!dest) return false;

  /* First frame after load, or any transition across the roof / GL
     boundary: the two scales are unrelated, so settle directly rather
     than flying through the wrong coordinate space. */
  const handoff = !LAST_SEL.mode || LAST_SEL.mode === "roof";
  const fromEye = P.eyeFromOrbit(VIEW);
  const fromTarget = { x: VIEW.target.x, y: VIEW.target.y, z: VIEW.target.z };
  const prevRoom = cameraInsideLastRoom();
  const prevRoomId = (mode === "room" && prevRoom === ids.roomId) ? null : prevRoom;
  const finalEye = dest.eye || P.eyeFromOrbit(dest);
  const finalTarget = { x: dest.target.x, y: dest.target.y, z: dest.target.z };
  const finalFov = Number.isFinite(dest.fov) ? dest.fov : 52;
  const fromFov = Number.isFinite(VIEW.fov) ? VIEW.fov : 52;

  VIEW.home = { ...finalTarget };  // pan clamp anchor for the new view
  VIEW.pivot = null;               // flights interpolate in eye/target space
  const meta = {
    mode,
    kind: mode === "room"
      ? (prevRoomId ? "room-transition" : "room-entry") : mode,
    buildingId: ids.buildingId || null,
    floorId: ids.floorId || null,
    roomId: ids.roomId || null,
    keyframes: handoff ? 0 : 1,
    started: performance.now(),
  };

  if (handoff) {
    VIEW.yaw = dest.yaw;
    VIEW.pitch = dest.pitch;
    VIEW.dist = dest.dist;
    VIEW.fov = finalFov;
    VIEW.target = { ...finalTarget };
    VIEW.pivot = null;
    VIEW.transition = meta;
    flight = null;
    finishCameraTransition();
    if (typeof sceneInvalidate === "function") sceneInvalidate();
    return true;
  }

  const pts = P.journey(fromEye, fromTarget, mode, {
    buildingId: ids.buildingId || null,
    floorId: ids.floorId || null,
    roomId: ids.roomId || null,
    prevRoomId,
    explode: EXPLODE.on ? 1 : 0,
  }) || [];
  if (!pts.length) {
    pts.push({ x: finalEye.x, y: finalEye.y, z: finalEye.z, target: finalTarget });
  } else {
    const last = pts[pts.length - 1];
    if (Math.hypot(last.x - finalEye.x, last.y - finalEye.y, last.z - finalEye.z) > 0.001) {
      pts.push({ x: finalEye.x, y: finalEye.y, z: finalEye.z, target: finalTarget });
    } else {
      last.target = finalTarget;
    }
  }

  const eyes = [{ x: fromEye.x, y: fromEye.y, z: fromEye.z }];
  const look = [{ x: fromTarget.x, y: fromTarget.y, z: fromTarget.z }];
  for (const p of pts) {
    eyes.push({ x: p.x, y: p.y, z: p.z });
    look.push({ x: p.target.x, y: p.target.y, z: p.target.z });
  }

  let len = 0;
  for (let i = 1; i < eyes.length; i++) {
    len += Math.hypot(eyes[i].x - eyes[i - 1].x,
      eyes[i].y - eyes[i - 1].y, eyes[i].z - eyes[i - 1].z);
  }
  // Long campus approaches get more time; short floor→room moves stay brisk.
  const dur = Math.max(900, Math.min(2500, 620 + len * 24));

  meta.keyframes = eyes.length;
  VIEW.transition = meta;
  flight = {
    gl: { eyes, look, dur, started: meta.started, fov0: fromFov, fov1: finalFov },
    last: meta.started,
  };
  if (typeof sceneInvalidate === "function") sceneInvalidate();
  return true;
}

function flyToView(view, opts) {
  const prevMode = VIEW.mode;
  VIEW.mode = view && view.mode ? view.mode : "roof";
  if (typeof cameraFlightStarting === "function") cameraFlightStarting();
  // Leaving the building view closes the exploded layout immediately so
  // floor/room targets are never computed against a lifted slab.  With the
  // WebGL renderer the lift eases back down instead; it is a world-space
  // shift there, not a Canvas projection, and snapping it would pop.
  const present = (typeof window !== "undefined") ? window.TWIN3D_PRESENT : null;
  if (VIEW.mode !== "building" && (EXPLODE.on || EXPLODE.t)) {
    EXPLODE.on = false;
    if (!present) EXPLODE.t = 0;
  }
  if (present) {
    const ids = {
      buildingId: (view && view.buildingId) || null,
      floorId: (view && view.floorId) || null,
      roomId: (view && view.roomId) || null,
    };
    if (VIEW.mode === "roof") {
      // The solar-plant roof view is a Canvas module at Canvas scale; the
      // two renderers share no camera units, so hand over on the preset.
      const rt = CAM_PRESETS.roof;
      VIEW.yaw = rt.yaw;
      VIEW.pitch = rt.pitch;
      VIEW.dist = rt.dist;
      VIEW.fov = 52;   // the Canvas roof module's authored lens
      VIEW.target = { ...rt.target };
      VIEW.pivot = null;
      VIEW.home = { ...rt.target };
      VIEW.transition = {
        mode: "roof", kind: "roof",
        buildingId: ids.buildingId, floorId: null, roomId: null,
        keyframes: 0, started: performance.now(),
      };
      flight = null;
      LAST_SEL = { mode: "roof", buildingId: ids.buildingId, floorId: null, roomId: null };
      if (typeof sceneInvalidate === "function") sceneInvalidate();
      return;
    }
    if (flyPresentation(present, VIEW.mode, ids)) {
      return;
    }
  }
  // Any remaining path uses target-relative orbit parameters.
  detachPivot();
  const b = view && BUILD[view.buildingId];
  let t = null;
  if (VIEW.mode === "campus") {
    t = CAM_PRESETS.campus;
  } else if (VIEW.mode === "roof") {
    t = CAM_PRESETS.roof;
  } else if (b) {
    if (VIEW.mode === "building") {
      const spread = EXPLODE.on
        ? b.floors.length * b.fh * EXPLODE.gap : 0;
      t = {
        yaw: -0.58, pitch: 0.58,
        dist: (b.id === "b1" ? 40 : 24) * (1 + Math.min(0.45, spread * 0.22)),
        target: {
          x: b.cx, y: b.cy,
          z: (b.groundZ + b.roofZ) / 2 + spread * 0.55,
        },
      };
    } else {
      const f = b.floors.find(x => x.id === view.floorId) || b.floors[0];
      const fi = b.floors.indexOf(f) + 1;
      const top = floorTop(b, fi);
      if (VIEW.mode === "floor") {
        t = {
          yaw: -0.52, pitch: 1.0,
          dist: b.id === "b1" ? 27 : 19,
          target: { x: b.cx, y: b.cy, z: top - b.fh / 2 },
        };
      } else {
        const r = f.rooms.find(x => x.id === view.roomId) || f.rooms[0];
        const rect = roomRect(b, r);
        t = {
          yaw: -0.55, pitch: 0.92,
          dist: clamp(Math.max(rect.w, rect.d) * 1.75, 11, 16),
          target: { x: rect.cx, y: rect.cy, z: top - b.fh / 2 + 0.12 },
        };
      }
    }
  }
  if (!t) {
    flight = null;
    VIEW.transition = null;
    if (typeof sceneInvalidate === "function") sceneInvalidate();
    return;
  }
  VIEW.home = { ...t.target };  // pan clamp anchor for the new view
  // Keyframed flight: hold/rotate, pull up and out to a safe waypoint above
  // the building envelope, then dive onto the destination. The waypoint's
  // high pitch + pulled-back distance guarantee the camera never clips
  // through walls or floors on the way in.  Destinations use the shortest
  // way round so a user who orbited past 360° never spins back.
  const cur = {
    yaw: VIEW.yaw, pitch: VIEW.pitch, dist: VIEW.dist,
    target: { ...VIEW.target },
    pivot: VIEW.pivot ? { ...VIEW.pivot } : null,
  };
  const yawDelta = shortestAngle(cur.yaw, t.yaw);
  const dest = Object.assign({}, t, {
    yaw: cur.yaw + yawDelta,
    target: { ...t.target },
    pivot: null,
  });
  const way = {
    yaw: cur.yaw + yawDelta * 0.5,
    pitch: Math.max(dest.pitch, 0.80),
    dist: Math.max(cur.dist, dest.dist) * 1.25,
    target: { ...dest.target },
    pivot: null,
  };
  const keys = [{ v: way, dur: 480 }];
  const enteringRoom = VIEW.mode === "room" && !!b
    && (prevMode !== "room" || !!(opts && opts.entry));
  if (enteringRoom) {
    // Room entry uses a deliberate three-key path: safe overhead waypoint,
    // a closer approach above the doorway, then settle inside the room.
    keys.push({
      v: {
        yaw: dest.yaw,
        pitch: Math.min(1.22, Math.max(1.0, dest.pitch + 0.14)),
        dist: Math.max(dest.dist * 1.7, 12),
        target: { ...dest.target },
        pivot: null,
      },
      dur: 340,
    });
  }
  keys.push({ v: dest, dur: enteringRoom ? 480 : 620 });
  VIEW.pivot = null;
  VIEW.transition = {
    mode: VIEW.mode,
    kind: enteringRoom ? "room-entry"
      : VIEW.mode === "room" ? "room-refocus" : VIEW.mode,
    buildingId: view.buildingId || null,
    floorId: view.floorId || null,
    roomId: view.roomId || null,
    keyframes: keys.length,
    started: performance.now(),
  };
  flight = {
    keys,
    i: 0, t: 0,
    from: cur,
    last: performance.now(),
  };
  // the frame scheduler is idle until it is told the camera has somewhere to go
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

/* Toggle the exploded floor layout (building view only). Floors ease apart,
   the roof lifts clear and the camera reframes to keep the stack in view. */
function setExplodedView(on) {
  EXPLODE.on = !!on;
  const btn = document.querySelector(".vnav-pill.explode");
  if (btn) {
    btn.classList.toggle("selected", EXPLODE.on);
    btn.setAttribute("aria-pressed", EXPLODE.on ? "true" : "false");
  }
  if (VIEW.mode === "building" && typeof S !== "undefined" && S.view) {
    flyToView(S.view);
  }
}

function explodeMix() {
  return VIEW.mode === "building" ? EXPLODE.t : 0;
}

/* Raw eased explode value, lift-independent of the current mode.  The
   WebGL renderer reads this so floors settle back down smoothly when the
   camera leaves the building view (explodeMix would snap them). */
function twinExplodeT() {
  return EXPLODE.t;
}

/* Advance camera easing by one frame and report whether anything moved.
   scene.js owns the frame loop now: it keeps requesting frames while this
   returns true and stops as soon as the camera is at rest, instead of the
   old camera loop running forever alongside a second render loop. */
function animateCameraStep(now) {
  let busy = false;

  // buffer mouse/touch orbit and pan, then apply the short follow filter
  if (typeof cameraInputStep === "function" && cameraInputStep(now)) busy = true;

  // smooth wheel / pinch dolly (WebGL presentation camera)
  if (typeof cameraDollyStep === "function" && cameraDollyStep(now)) busy = true;

  // exploded floors ease apart/together
  const explodeGoal = (EXPLODE.on && VIEW.mode === "building") ? 1 : 0;
  if (Math.abs(EXPLODE.t - explodeGoal) > 0.0005) {
    EXPLODE.t += (explodeGoal - EXPLODE.t) * 0.14;
    busy = true;
  } else if (EXPLODE.t !== explodeGoal) {
    EXPLODE.t = explodeGoal;
    busy = true;
  }

  // eased wheel zoom, anchored at the cursor
  if (Math.abs(CAM.zoom - ZOOM.goal) > 0.0004) {
    const old = CAM.zoom;
    CAM.zoom += (ZOOM.goal - CAM.zoom) * 0.22;
    if (ZOOM.anchor) {
      const bx = (ZOOM.anchor.x - CAM.x) / old;
      const by = (ZOOM.anchor.y - CAM.y) / old;
      CAM.x = ZOOM.anchor.x - bx * CAM.zoom;
      CAM.y = ZOOM.anchor.y - by * CAM.zoom;
    }
    clampCam();
    busy = true;
  } else if (CAM.zoom !== ZOOM.goal) {
    CAM.zoom = ZOOM.goal;
    busy = true;
  }

  if (flight && flight.gl) {
    // Presentation-scale cinematic path: one global ease drives a
    // Catmull-Rom eye track and a matching look-target track.  Sampling
    // both by the same eased progress keeps the frame steady while the
    // camera arcs around the tower and passes through the cutaway.
    const P = (typeof window !== "undefined") ? window.TWIN3D_PRESENT : null;
    const g = flight.gl;
    if (!P) {
      flight = null;   // renderer fell back mid-flight; keep the current view
    } else {
      const k = Math.min(1, Math.max(0, (now - g.started) / g.dur));
      const u = smootherstep(k);
      const eye = catmullAt(g.eyes, u);
      const look = catmullAt(g.look, u);
      const orb = P.orbitFromEyeTarget(eye, look);
      VIEW.yaw = orb.yaw;
      VIEW.pitch = orb.pitch;
      VIEW.dist = orb.dist;
      if (Number.isFinite(g.fov0) && Number.isFinite(g.fov1)) {
        VIEW.fov = g.fov0 + (g.fov1 - g.fov0) * u;
      }
      VIEW.target.x = orb.target.x;
      VIEW.target.y = orb.target.y;
      VIEW.target.z = orb.target.z;
      busy = true;
      if (k >= 1) {
        flight = null;
        finishCameraTransition();
      }
    }
  } else if (flight) {
    const dt = Math.min(64, now - flight.last);
    flight.last = now;
    flight.t += dt;
    const seg = flight.keys[flight.i];
    const k = smootherstep(Math.min(1, flight.t / seg.dur));
    VIEW.yaw = lerpAngle(flight.from.yaw, seg.v.yaw, k);
    VIEW.pitch = lerp(flight.from.pitch, seg.v.pitch, k);
    VIEW.dist = lerp(flight.from.dist, seg.v.dist, k);
    VIEW.target.x = lerp(flight.from.target.x, seg.v.target.x, k);
    VIEW.target.y = lerp(flight.from.target.y, seg.v.target.y, k);
    VIEW.target.z = lerp(flight.from.target.z, seg.v.target.z, k);
    if (flight.from.pivot && seg.v.pivot) {
      if (!VIEW.pivot) VIEW.pivot = { x: flight.from.pivot.x, y: flight.from.pivot.y, z: flight.from.pivot.z };
      VIEW.pivot.x = lerp(flight.from.pivot.x, seg.v.pivot.x, k);
      VIEW.pivot.y = lerp(flight.from.pivot.y, seg.v.pivot.y, k);
      VIEW.pivot.z = lerp(flight.from.pivot.z, seg.v.pivot.z, k);
    } else {
      VIEW.pivot = null;
    }
    busy = true;
    if (flight.t >= seg.dur) {
      flight.from = {
        yaw: VIEW.yaw, pitch: VIEW.pitch, dist: VIEW.dist,
        target: { ...VIEW.target },
        pivot: VIEW.pivot ? { ...VIEW.pivot } : null,
      };
      flight.i += 1;
      flight.t = 0;
      if (flight.i >= flight.keys.length) {
        flight = null;
        finishCameraTransition();
        // a queued equipment focus may have started a new flight
        if (flight) busy = true;
      }
    }
  }
  return busy;
}

/* ---------------- geometry helpers ---------------- */

function roomRect(b, r) {
  const x0 = b.x0 + r.fx * b.w, y0 = b.y0 + r.fy * b.d;
  return { x0, y0, x1: x0 + r.fw * b.w, y1: y0 + r.fd * b.d,
           w: r.fw * b.w, d: r.fd * b.d,
           cx: x0 + r.fw * b.w / 2, cy: y0 + r.fd * b.d / 2 };
}

/* Vertical lift of a floor in the exploded view: the ground floor stays put,
   each floor above rises by one gap, and the roof rises n gaps. */
function floorLift(b, fi) {
  return Math.max(0, fi - 1) * b.fh * EXPLODE.gap * explodeMix();
}

function roofLift(b) {
  return b.floors.length * b.fh * EXPLODE.gap * explodeMix();
}

function floorTop(b, fi) {
  return b.groundZ + fi * b.fh + floorLift(b, fi);
}

function esc(s) {
  return (typeof escapeHTML === "function") ? escapeHTML(s) : String(s);
}

function stColor(status) { return ST_COLORS[status] || ST_COLORS.ok; }

/* Pulsing anomaly count badge (feature G). Anomalies are highlighted in
   every view mode; the badge is additive so high consumption alone never
   turns a room red. */
function drawAnomalyBadge(ctx, x, y, count, now) {
  if (!count) return;
  const pulse = 0.7 + 0.3 * Math.sin((now || 0) / 320);
  const r = 7.5 + pulse * 2.0;
  ctx.save();
  ctx.fillStyle = `rgba(224, 70, 70, ${0.12 + 0.14 * pulse})`;
  ctx.beginPath(); ctx.arc(x, y, r + 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(224, 70, 70, 0.96)";
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 9 ? "9+" : String(count), x, y + 0.5);
  ctx.restore();
}

function quadBadgePoint(pts) {
  if (!pts || !pts.length) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.max(...xs) - 10, y: Math.min(...ys) + 10 };
}

/* Extruded box: top face + south (y0) + west (x0) faces, painter-friendly. */
function box3(ctx, x0, y0, z0, w, d, h, topFill, sideFill, opts) {
  const p = (x, y, z) => project(x, y, z);
  const c = {
    sw: p(x0, y0, z0), se: p(x0 + w, y0, z0), ne: p(x0 + w, y0 + d, z0), nw: p(x0, y0 + d, z0),
    SW: p(x0, y0, z0 + h), SE: p(x0 + w, y0, z0 + h), NE: p(x0 + w, y0 + d, z0 + h), NW: p(x0, y0 + d, z0 + h),
  };
  for (const v of Object.values(c)) if (!v) return null;
  if (opts && opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.lw || 1;
    quadPath(ctx, [c.SW, c.SE, c.NE, c.NW]);
    ctx.stroke();
  } else {
    ctx.fillStyle = topFill;
    quadPath(ctx, [c.SW, c.SE, c.NE, c.NW]);
    ctx.fill();
  }
  if (sideFill) {
    ctx.fillStyle = sideFill;
    quadPath(ctx, [c.sw, c.se, c.SE, c.SW]);
    ctx.fill();
    ctx.fillStyle = shade(sideFill, 0.86);
    quadPath(ctx, [c.sw, c.SW, c.NW, c.nw]);
    ctx.fill();
  }
  return { top: [c.SW, c.SE, c.NE, c.NW], c, cx: (c.SW.x + c.NE.x) / 2, cy: (c.SW.y + c.NE.y) / 2 };
}

/* Vertical wall quad (axis-aligned, from z0 to z0+h). */
function wallQ(ctx, ax, ay, bx, by, z0, h, fill) {
  const a = project(ax, ay, z0), b = project(bx, by, z0);
  const A = project(ax, ay, z0 + h), B = project(bx, by, z0 + h);
  if (!a || !b || !A || !B) return null;
  ctx.fillStyle = fill;
  quadPath(ctx, [a, b, B, A]);
  ctx.fill();
  return { pts: [a, b, B, A] };
}

function quad(ctx, pts, fill, stroke, lw) {
  ctx.fillStyle = fill;
  quadPath(ctx, pts);
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw || 1;
    quadPath(ctx, pts);
    ctx.stroke();
  }
}

/* ---------------- hit registry ---------------- */

const HIT = {
  buildings: [], floors: [], rooms: [], devices: [], roofs: [],
  clear() { this.buildings.length = 0; this.floors.length = 0; this.rooms.length = 0; this.devices.length = 0; this.roofs.length = 0; },
};

function register(pts, id) {
  if (!pts || !pts.every(p => p && isFinite(p.x) && isFinite(p.y))) return null;
  const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
  return { id, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), pts };
}

function buildingTwinHit(px, py) {
  const lists = [HIT.devices, HIT.rooms, HIT.roofs, HIT.floors, HIT.buildings];
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      const z = list[i];
      if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) {
        if (z.pts && !pointInQuad(px, py, z.pts)) continue;
        return z.id;
      }
    }
  }
  return null;
}

/* Resolve any twin id (device / building / floor / room / roof) for tips. */
function findTwinThing(id) {
  if (!id || typeof S === "undefined" || !S.snap) return null;
  const dev = findTwinDevice(id);
  if (dev) return { kind: "device", d: dev };
  if (id && id.startsWith("roof-")) {
    const b = (S.snap.buildings || []).find(x => x.id === id.slice(5));
    return b ? { kind: "roof", building: b } : null;
  }
  for (const b of S.snap.buildings || []) {
    if (b.id === id) return { kind: "building", data: b };
    for (const f of b.floors || []) {
      if (f.id === id) return { kind: "floor", data: f, building: b };
      for (const r of f.rooms || []) {
        if (r.id === id) return { kind: "room", data: r, building: b, floor: f };
      }
    }
  }
  return null;
}

function renderTwinTip(thing) {
  const tip = document.getElementById("twin-tip");
  if (!tip || !thing) return;
  tip.classList.remove("hidden");
  if (thing.kind === "roof") {
    tip.innerHTML = `<div class="tip-name">${esc(thing.building.name)} · Rooftop</div>
      <div class="tip-row">Click to open the solar plant view</div>`;
    return;
  }
  const d = thing.data;
  const anom = d.anomalies || 0;
  const sub = thing.kind === "building"
    ? `${(d.floors || []).length} floors · ${(d.equipment || []).length} plant items`
    : thing.kind === "floor"
      ? `${(d.rooms || []).length} rooms · FCU ${d.fcu ? d.fcu.actual.toFixed(1) + " kW" : "—"}`
      : `${d.usage || "room"} · ${d.area} m² · ${(d.devices || []).length} circuits`;
  tip.innerHTML = `<div class="tip-name">${esc(d.name)}</div>
    <div class="tip-row">${(d.actual || 0).toFixed(1)} kW actual · ${(d.expected || 0).toFixed(1)} kW expected</div>
    <div class="tip-row">${esc(sub)}${anom ? ` · <span style="color:${cssVar("--critical")}">${anom} anomaly${anom > 1 ? "ies" : ""}</span>` : ""}</div>`;
}

/* ---------------- ground & atmosphere ---------------- */

function drawGroundPlane(ctx, now, big) {
  const z = BUILD.groundZ;
  const X0 = big ? -85 : -40, X1 = big ? 95 : 60, Y0 = -62, Y1 = big ? 62 : 42;
  const c = [project(X0, Y0, z), project(X1, Y0, z), project(X1, Y1, z), project(X0, Y1, z)];
  if (c.every(Boolean)) {
    const g = perfGradient(ctx, "ground:" + (big ? "big" : "near"),
      c[0].x, c[0].y, c[2].x, c[2].y, [
        [0, "#101216"],
        [0.5, "#0c0e12"],
        [1, "#0a0c10"],
      ]);
    quad(ctx, c, g);
    // subtle grid
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.030)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(X0 / 6) * 6; x <= X1; x += 6) {
      const a = project(x, Y0, z), b = project(x, Y1, z);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
    for (let y = Math.ceil(Y0 / 6) * 6; y <= Y1; y += 6) {
      const a = project(X0, y, z), b = project(X1, y, z);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
    ctx.stroke();
    ctx.restore();
    // a soft walkway between the buildings
    const p0 = project(4, -14, z + 0.01), p1 = project(30, -14, z + 0.01),
          p2 = project(30, -9, z + 0.01), p3 = project(4, -9, z + 0.01);
    if (p0 && p1 && p2 && p3) quad(ctx, [p0, p1, p2, p3], "rgba(255,255,255,0.022)");
  }
  // haze band over the horizon
  const hz = perfGradient(ctx, "ground-haze", 0, 0, 0, TWIN.H * 0.4, [
    [0, "rgba(20, 24, 30, 0.5)"],
    [1, "rgba(20, 24, 30, 0)"],
  ]);
  ctx.fillStyle = hz;
  ctx.fillRect(0, 0, TWIN.W, TWIN.H * 0.4);
}

/* ---------------- facade (glass curtain wall) ---------------- */

function winLit(i, j, seed) {
  const x = Math.sin(i * 12.9898 + j * 78.233 + seed * 45.164) * 43758.5453;
  return x - Math.floor(x);
}

function drawFacade(ctx, b, now, snap) {
  const day = daylight();
  const night = day < 0.25;
  const z0 = b.groundZ, z1 = b.roofZ;
  const glassA = night ? 0.20 : 0.10;
  const floors = b.floors.length;
  const selFloor = (typeof S !== "undefined" && S.view && S.view.floorId) || null;
  const hovFloor = (typeof S !== "undefined" && S.hover) || null;
  const selBuilding = (typeof S !== "undefined" && S.view && S.view.buildingId === b.id);

  const faces = [
    // south face (y = y0): x x0..x1
    { ax: b.x0, ay: b.y0, bx: b.x1, by: b.y0, len: b.w, cols: Math.round(b.w / 2.4), faceId: "s" },
    // west face (x = x0): y y0..y1
    { ax: b.x0, ay: b.y1, bx: b.x0, by: b.y0, len: b.d, cols: Math.round(b.d / 2.4), faceId: "w" },
  ];

  for (const face of faces) {
    const A = project(face.ax, face.ay, z0), B = project(face.bx, face.by, z0);
    const C = project(face.bx, face.by, z1), D = project(face.ax, face.ay, z1);
    if (!A || !B || !C || !D) continue;
    const pts = [A, B, C, D];

    // glass base
    const g = perfGradient(ctx, "facade-glass:" + (night ? "night" : "day") + ":" + face.faceId + ":" + b.id,
      D.x, D.y, B.x, B.y, [
        [0, `rgba(105, 140, 175, ${glassA + 0.06})`],
        [0.5, `rgba(70, 100, 135, ${glassA})`],
        [1, `rgba(45, 65, 95, ${glassA + 0.05})`],
      ]);
    quad(ctx, pts, g);

    // lit windows at night
    if (night) {
      for (let f = 0; f < floors; f++) {
        const zA = z0 + f * b.fh, zB = zA + b.fh;
        const wA = 1.15 + f * b.fh * 0.0;
        for (let cI = 0; cI < face.cols; cI++) {
          const lit = winLit(cI, f, b.id === "b1" ? 3 : 7) < 0.34;
          if (!lit) continue;
          const u0 = cI / face.cols, u1 = (cI + 1) / face.cols;
          const v0 = (zB - zA - b.fh * 0.62) / 2 + 0.02, v1 = v0 + b.fh * 0.62;
          const w0 = bilinear(pts, u0, v0), w1 = bilinear(pts, u1, v0);
          const w2 = bilinear(pts, u1, v1), w3 = bilinear(pts, u0, v1);
          const warm = 0.16 + winLit(cI, f, 5) * 0.14;
          quad(ctx, [w0, w1, w2, w3], `rgba(255, 212, 150, ${warm})`);
        }
      }
    }

    // mullions + floor bands
    ctx.strokeStyle = "rgba(190, 210, 235, 0.13)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let cI = 1; cI < face.cols; cI++) {
      const a = bilinear(pts, cI / face.cols, 0), bq = bilinear(pts, cI / face.cols, 1);
      ctx.moveTo(a.x, a.y); ctx.lineTo(bq.x, bq.y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(205, 225, 245, 0.22)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let f = 1; f < floors; f++) {
      const v = f / floors;
      const a = bilinear(pts, 0, v), bq = bilinear(pts, 1, v);
      ctx.moveTo(a.x, a.y); ctx.lineTo(bq.x, bq.y);
    }
    ctx.stroke();

    // hover / selection highlight on the floor bands
    for (let f = 0; f < floors; f++) {
      const fid = b.floors[f].id;
      const band = [bilinear(pts, 0, f / floors), bilinear(pts, 1, f / floors),
                    bilinear(pts, 1, (f + 1) / floors), bilinear(pts, 0, (f + 1) / floors)];
      if (fid === hovFloor || fid === selFloor) {
        ctx.save();
        ctx.strokeStyle = fid === selFloor ? "rgba(143, 220, 255, 0.9)" : "rgba(255,255,255,0.5)";
        perfShadow(ctx, "rgba(96, 200, 255, 0.8)", 10);
        ctx.lineWidth = 1.6;
        quadPath(ctx, band);
        ctx.stroke();
        ctx.restore();
      }
      // in the campus view the whole facade opens the building; the floor
      // bands become individual click targets once inside the building view
      HIT.floors.push(register(band, VIEW.mode === "campus" ? b.id : fid));
    }
    if (selBuilding) {
      ctx.save();
      ctx.strokeStyle = "rgba(143, 220, 255, 0.35)";
      ctx.lineWidth = 1;
      quadPath(ctx, pts);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/* ---------------- roof (simplified PV + condensers) ---------------- */

function drawSimpleArray(ctx, b, snap, now, roofZ) {
  const baseZ = roofZ == null ? b.roofZ : roofZ;
  const x0 = -15.2, x1 = 15.2, y0 = -3.6, y1 = 3.6, z = baseZ + 0.03;
  const c = [project(x0, y0, z), project(x1, y0, z), project(x1, y1, z), project(x0, y1, z)];
  if (!c.every(Boolean)) return;
  const day = daylight();
  // field slab
  const g = perfGradient(ctx, "array-slab:" + Math.round(day * 50),
    c[0].x, c[0].y, c[2].x, c[2].y, [
      [0, shade("#1b2433", 0.6 + 0.4 * day)],
      [1, shade("#314761", 0.6 + 0.4 * day)],
    ]);
  quad(ctx, c, g);
  ctx.strokeStyle = "rgba(180, 205, 235, 0.25)";
  ctx.lineWidth = 0.8;
  ctx.strokeRect(Math.min(...c.map(p => p.x)), Math.min(...c.map(p => p.y)),
                 Math.max(...c.map(p => p.x)) - Math.min(...c.map(p => p.x)),
                 Math.max(...c.map(p => p.y)) - Math.min(...c.map(p => p.y)));
  // cell grid
  ctx.save();
  ctx.beginPath();
  for (let k = 1; k < 12; k++) {
    const a = bilinear(c, k / 12, 0), bp = bilinear(c, k / 12, 1);
    ctx.moveTo(a.x, a.y); ctx.lineTo(bp.x, bp.y);
  }
  for (let k = 1; k < 4; k++) {
    const a = bilinear(c, 0, k / 4), bp = bilinear(c, 1, k / 4);
    ctx.moveTo(a.x, a.y); ctx.lineTo(bp.x, bp.y);
  }
  ctx.stroke();
  ctx.restore();
  // inverter block
  const ix0 = 2.6, ix1 = 3.8, iy0 = -8.3, iy1 = -7.4;
  const inv = box3(ctx, ix0, iy0, z, ix1 - ix0, iy1 - iy0, 0.5,
                   shade("#2b3b50", 0.7 + 0.3 * day), shade("#1d2734", 0.6 + 0.4 * day));
  // live chip
  const kpis = snap && snap.kpis;
  const kw = kpis ? kpis.solar_kw.toFixed(1) : "—";
  const cen = bilinear(c, 0.5, 0.5);
  drawSceneChip(ctx, cen.x, cen.y - 8, "PV ARRAY", `${kw} kW`, "rgba(240, 178, 94, 0.9)");
}

function drawRoofSlab(ctx, b, snap, now) {
  const day = daylight();
  const z = b.roofZ + roofLift(b);
  const top = box3(ctx, b.x0, b.y0, z, b.w, b.d, 0.16,
                   shade("#242830", 0.62 + 0.38 * day), shade("#1a1d23", 0.55 + 0.45 * day));
  // parapet rim
  ctx.save();
  const rim = [project(b.x0, b.y0, z + 0.16), project(b.x1, b.y0, z + 0.16),
               project(b.x1, b.y1, z + 0.16), project(b.x0, b.y1, z + 0.16)];
  if (rim.every(Boolean)) {
    ctx.strokeStyle = "rgba(230, 240, 250, 0.28)";
    ctx.lineWidth = 1.4;
    quadPath(ctx, rim);
    ctx.stroke();
  }
  ctx.restore();
  if (b.solar) {
    drawSimpleArray(ctx, b, snap, now, z);
  } else {
    // roof condensers + vents
    box3(ctx, b.x0 + 3, b.y0 + 3, z + 0.05, 1.6, 1.2, 0.7,
         shade("#3a4150", 0.65), shade("#252a33", 0.6));
    box3(ctx, b.x0 + 6.5, b.y0 + 3.2, z + 0.05, 1.6, 1.2, 0.7,
         shade("#3a4150", 0.65), shade("#252a33", 0.6));
  }
  // campus: the roof opens the building itself; building view: roof -> PV scene
  if (top) HIT.roofs.push(register(top.top, VIEW.mode === "campus" ? b.id : "roof-" + b.id));
}

/* Faint guide lines between exploded floors: they read as a section cut,
   not as a solid structure, so they never become click targets. */
function drawExplodeGuides(ctx, b) {
  if (explodeMix() <= 0.01) return;
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = `rgba(150, 190, 225, ${0.10 + 0.10 * EXPLODE.t})`;
  ctx.lineWidth = 0.8;
  const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  for (const [x, y] of corners) {
    const a = project(x, y, b.groundZ + 0.16);
    const c = project(x, y, b.roofZ + roofLift(b));
    if (!a || !c) continue;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- elevator ---------------- */

function drawElevator(ctx, b, snap, now, zTop, h) {
  const e = b.elevator;
  if (!e) return null;
  const x0 = b.x0 + e.fx * b.w, y0 = b.y0 + e.fy * b.d;
  const w = e.fw * b.w, d = e.fd * b.d;
  const z0 = zTop - h;
  const day = daylight();
  const dev = snap ? (snap.equipment || []).find(x => x.id === "el-b1") : null;
  const cabFloor = dev && dev.extra ? dev.extra.cab_floor : 1;

  box3(ctx, x0, y0, z0, w, d, h,
       `rgba(140, 170, 200, ${0.16 + 0.10 * day})`, "rgba(90, 110, 135, 0.22)");
  // shaft guides + cab
  const cabZ = z0 + (cabFloor - 1) * b.fh + b.fh * 0.32;
  const cab = box3(ctx, x0 + 0.12, y0 + 0.1, cabZ, w - 0.24, d - 0.2, b.fh * 0.36,
                   "#23272e", "#191c22");
  if (cab) {
    // lit cab interior hint
    const door = wallQ(ctx, x0 + 0.15, y0 + d - 0.12, x0 + w - 0.15, y0 + d - 0.12,
                       cabZ + 0.04, b.fh * 0.3, `rgba(255, 226, 170, ${0.20 + 0.2 * (1 - day)})`);
  }
  const st = dev ? stColor(dev.status) : ST_COLORS.ok;
  // clickable shaft + selection ring
  const shaftTop = [project(x0, y0, z0 + h), project(x0 + w, y0, z0 + h),
                    project(x0 + w, y0 + d, z0 + h), project(x0, y0 + d, z0 + h)];
  if (shaftTop.every(Boolean)) {
    HIT.devices.push(register(shaftTop, "el-b1"));
    if (typeof vizDeviceMarker === "function" && dev) {
      const mp = project(x0 + w / 2, y0 + d / 2, z0 + h + 0.05);
      if (mp) vizDeviceMarker(ctx, mp.x + 8, mp.y - 8, "el-b1", now);
    }
    if (selectedId() === "el-b1") {
      const xs = shaftTop.map(q => q.x), ys = shaftTop.map(q => q.y);
      selectionRing(ctx, (Math.min(...xs) + Math.max(...xs)) / 2,
                    (Math.min(...ys) + Math.max(...ys)) / 2,
                    (Math.max(...xs) - Math.min(...xs)) / 2 + 8,
                    (Math.max(...ys) - Math.min(...ys)) / 2 + 8, now);
    }
  }
  return { dev, st, cx: x0 + w / 2, cy: y0 + d / 2, x0, y0, w, d, z0, h, top: cab ? cab.top : null };
}

/* ---------------- equipment glyphs ---------------- */

/* Selected-object treatment: glowing ring + corner ticks so the current
   selection is unmistakable against walls, floors and fault colours. */
function selectionRing(ctx, cx, cy, rx, ry, now, label) {
  const pulse = 0.72 + 0.18 * Math.sin(now / 260);
  ctx.save();
  ctx.strokeStyle = `rgba(143, 220, 255, ${pulse})`;
  perfShadow(ctx, "rgba(96, 200, 255, 0.95)", 14);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(6, rx), Math.max(6, ry), 0, 0, 7);
  ctx.stroke();
  // four corner ticks
  perfShadow(ctx, "rgba(96, 200, 255, 0.95)", 6);
  ctx.lineWidth = 2;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const ax = cx + sx * rx, ay = cy + sy * ry;
    ctx.beginPath();
    ctx.moveTo(ax - sx * Math.min(7, rx * 0.28), ay);
    ctx.lineTo(ax, ay);
    ctx.lineTo(ax, ay - sy * Math.min(7, ry * 0.28));
    ctx.stroke();
  }
  ctx.restore();
}

function selectedId() {
  return (typeof S !== "undefined" && S.selection) ? S.selection.id : null;
}

function drawLightFixture(ctx, x, y, zC, on, st, now, hitId) {
  const p = project(x, y, zC);
  if (!p) return;
  const r = Math.max(2.2, p.s * 0.075);
  ctx.save();
  if (on) {
    const glow = perfRadial(ctx, "light-glow", p.x, p.y, 1, p.x, p.y, r * 3.2, [
      [0, "rgba(255, 235, 190, 0.20)"],
      [1, "rgba(255, 235, 190, 0)"],
    ]);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.2, 0, 7); ctx.fill();
  }
  ctx.fillStyle = on ? "#ffe9b8" : "#3a3f48";
  ctx.strokeStyle = "rgba(220, 230, 245, 0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
  if (st !== "ok") {
    ctx.strokeStyle = stColor(st);
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.6, 0, 7); ctx.stroke();
  }
  ctx.restore();
  if (hitId === selectedId()) selectionRing(ctx, p.x, p.y, r + 1, r + 1, now);
  if (typeof vizDeviceMarker === "function") vizDeviceMarker(ctx, p.x + r + 4, p.y - r - 2, hitId, now);
  HIT.devices.push(register([{ x: p.x - r - 3, y: p.y - r - 3 }, { x: p.x + r + 3, y: p.y - r - 3 },
                             { x: p.x + r + 3, y: p.y + r + 3 }, { x: p.x + r - 3, y: p.y + r + 3 }], hitId));
}

function drawFcu(ctx, x, y, zTop, dev, now, hitId) {
  const day = daylight();
  const on = dev && dev.actual > 0.15;
  const st = dev ? stColor(dev.status) : ST_COLORS.ok;
  const box = box3(ctx, x - 0.34, y - 0.12, zTop - 0.52, 0.68, 0.24, 0.4,
                   shade("#3b4352", 0.75), shade("#262b35", 0.7));
  if (!box) return;
  // fan grille
  const f = project(x, y - 0.005, zTop - 0.33);
  if (f) {
    ctx.save();
    ctx.strokeStyle = "rgba(200, 215, 235, 0.4)";
    ctx.lineWidth = Math.max(0.8, f.s * 0.02);
    ctx.beginPath(); ctx.arc(f.x, f.y, Math.max(2, f.s * 0.075), 0, 7); ctx.stroke();
    if (on) {
      const a = (now / 90) % (Math.PI * 2);
      ctx.strokeStyle = "rgba(235, 245, 255, 0.75)";
      ctx.lineWidth = Math.max(1, f.s * 0.028);
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(f.x, f.y, Math.max(2, f.s * 0.075) * 0.72, a + k * 2.1, a + k * 2.1 + 0.9);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // status LED
  const led = project(x + 0.26, y - 0.02, zTop - 0.2);
  if (led) {
    ctx.save();
    ctx.fillStyle = on ? st : "#555a63";
    perfShadow(ctx, on ? st : "transparent", 6);
    ctx.beginPath(); ctx.arc(led.x, led.y, Math.max(1.2, led.s * 0.014), 0, 7); ctx.fill();
    ctx.restore();
  }
  if (box) HIT.devices.push(register(box.top, hitId));
  if (hitId === selectedId() && box) {
    const xs = box.top.map(q => q.x), ys = box.top.map(q => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    selectionRing(ctx, cx, cy, (Math.max(...xs) - Math.min(...xs)) / 2 + 6,
                  (Math.max(...ys) - Math.min(...ys)) / 2 + 6, now);
  }
  if (box && typeof vizDeviceMarker === "function") {
    vizDeviceMarker(ctx, box.cx + 10, box.cy - 10, hitId, now);
  }
}

function drawSocket(ctx, x, y, zTop, dev, now, hitId) {
  const day = daylight();
  const on = dev && dev.actual > 0.02;
  const st = dev ? stColor(dev.status) : ST_COLORS.ok;
  const box = box3(ctx, x - 0.06, y - 0.035, zTop - 0.62, 0.12, 0.07, 0.14,
                   shade("#41464f", 0.8), shade("#2a2e35", 0.75));
  if (!box) return;
  if (on) {
    const p = project(x, y, zTop - 0.56);
    if (p) {
      ctx.save();
      ctx.fillStyle = "#9be8c2";
      perfShadow(ctx, "rgba(120, 240, 190, 0.8)", 5);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, p.s * 0.012), 0, 7); ctx.fill();
      ctx.restore();
    }
  }
  HIT.devices.push(register(box.top, hitId));
  if (hitId === selectedId()) {
    const xs = box.top.map(q => q.x), ys = box.top.map(q => q.y);
    selectionRing(ctx, (Math.min(...xs) + Math.max(...xs)) / 2,
                  (Math.min(...ys) + Math.max(...ys)) / 2,
                  (Math.max(...xs) - Math.min(...xs)) / 2 + 5,
                  (Math.max(...ys) - Math.min(...ys)) / 2 + 5, now);
  }
  const mp = project(x, y, zTop - 0.52);
  if (mp && typeof vizDeviceMarker === "function") vizDeviceMarker(ctx, mp.x + 6, mp.y - 6, hitId, now);
}

function drawRacks(ctx, rect, zTop, dev, now, detail, hitId) {
  const day = daylight();
  const st = dev ? stColor(dev.status) : ST_COLORS.ok;
  const rows = 2, per = 2;
  const rw = Math.min(0.62, (rect.w - 1.2) / per);
  const rd = Math.min(0.95, (rect.d - 1.6) / rows);
  for (let rI = 0; rI < rows; rI++) {
    for (let cI = 0; cI < per; cI++) {
      const x0 = rect.x0 + 0.8 + cI * (rw + 0.35);
      const y0 = rect.y0 + 0.8 + rI * (rd + 0.35);
      const rack = box3(ctx, x0, y0, zTop - 0.92, rw, rd, 0.92,
                        shade("#2c3139", 0.85), shade("#1d2127", 0.8));
      if (!rack) continue;
      // each cabinet is its own click target (the room stays clickable)
      HIT.devices.push(register(rack.top, hitId));
      if (hitId === selectedId()) {
        const xs = rack.top.map(q => q.x), ys = rack.top.map(q => q.y);
        selectionRing(ctx, (Math.min(...xs) + Math.max(...xs)) / 2,
                      (Math.min(...ys) + Math.max(...ys)) / 2,
                      (Math.max(...xs) - Math.min(...xs)) / 2 + 4,
                      (Math.max(...ys) - Math.min(...ys)) / 2 + 4, now);
      }
      // front door + LED strip
      const led = wallQ(ctx, x0 + 0.05, y0 + rd - 0.06, x0 + 0.05, y0 + 0.06,
                        zTop - 0.84, 0.6, "rgba(12, 14, 18, 0.6)");
      if (led) {
        ctx.save();
        ctx.strokeStyle = st;
        perfShadow(ctx, st, 6);
        ctx.lineWidth = Math.max(1, led.pts[0].s * 0.02);
        ctx.beginPath();
        ctx.moveTo(led.pts[0].x, led.pts[0].y);
        ctx.lineTo(led.pts[3].x, led.pts[3].y);
        ctx.stroke();
        ctx.restore();
      }
      if (detail) {
        for (let k = 0; k < 3; k++) {
          wallQ(ctx, x0 + 0.06, y0 + rd * (0.22 + k * 0.25), x0 + rw - 0.04, y0 + rd * (0.22 + k * 0.25),
                zTop - 0.8 + k * 0.1, 0.03, "rgba(140, 200, 220, 0.10)");
        }
      }
    }
  }
  const mp = project(rect.cx, rect.cy, zTop + 0.05);
  if (mp && typeof vizDeviceMarker === "function") vizDeviceMarker(ctx, mp.x, mp.y - 10, hitId, now);
}

function drawEvStation(ctx, b, snap, now) {
  if (!b || b.id !== "b1") return;
  const z = BUILD.groundZ;
  const day = daylight();
  const x = b.x0 + 6, y = b.y0 - 2.8;
  const dev = snap ? (snap.equipment || []).find(d => d.id === "ev-b1") : null;
  const charging = dev && dev.extra && dev.extra.session === "charging";
  const st = dev ? stColor(dev.status) : ST_COLORS.ok;
  // pad
  const pad = [project(x - 2, y - 1.8, z + 0.01), project(x + 2, y - 1.8, z + 0.01),
               project(x + 2, y + 1.8, z + 0.01), project(x - 2, y + 1.8, z + 0.01)];
  if (pad.every(Boolean)) {
    quad(ctx, pad, "rgba(255,255,255,0.03)");
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    quadPath(ctx, pad); ctx.stroke();
    ctx.restore();
  }
  // pedestal
  const ped = box3(ctx, x - 0.15, y + 1.2, z, 0.3, 0.24, 1.05,
                   shade("#39414d", 0.8), shade("#242932", 0.75));
  if (ped) {
    const led = project(x, y + 1.32, z + 0.72);
    if (led) {
      ctx.save();
      ctx.fillStyle = st;
      perfShadow(ctx, st, 7);
      ctx.beginPath(); ctx.arc(led.x, led.y, Math.max(1.4, led.s * 0.016), 0, 7); ctx.fill();
      ctx.restore();
    }
    HIT.devices.push(register(ped.top, "ev-b1"));
    if (typeof vizDeviceMarker === "function") {
      vizDeviceMarker(ctx, ped.cx + 8, ped.cy - 8, "ev-b1", now);
    }
    if (selectedId() === "ev-b1") {
      const xs = ped.top.map(q => q.x), ys = ped.top.map(q => q.y);
      selectionRing(ctx, (Math.min(...xs) + Math.max(...xs)) / 2,
                    (Math.min(...ys) + Math.max(...ys)) / 2,
                    (Math.max(...xs) - Math.min(...xs)) / 2 + 5,
                    (Math.max(...ys) - Math.min(...ys)) / 2 + 5, now);
    }
  }
  // car + cable while a session runs
  if (charging) {
    const car = box3(ctx, x - 0.85, y - 1.6, z + 0.02, 1.7, 2.9, 0.5,
                     shade("#4a5260", 0.85), shade("#2e343d", 0.8));
    const p0 = project(x, y + 1.25, z + 0.7), p1 = project(x, y - 0.4, z + 0.45);
    if (p0 && p1) {
      ctx.save();
      ctx.strokeStyle = "rgba(120, 240, 200, 0.75)";
      perfShadow(ctx, "rgba(120, 240, 200, 0.7)", 5);
      ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 9]);
      ctx.lineDashOffset = -(now / 60) % 12;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

function drawWaterHeater(ctx, rect, zTop, dev, now, hitId) {
  const day = daylight();
  const st = dev ? stColor(dev.status) : ST_COLORS.ok;
  const x = rect.x0 + rect.w * 0.75, y = rect.y0 + rect.d * 0.3;
  const body = box3(ctx, x - 0.22, y - 0.22, zTop - 0.95, 0.44, 0.44, 0.85,
                    shade("#8a8f98", 0.8), shade("#4a4f57", 0.8));
  if (!body) return;
  const topP = project(x, y, zTop - 0.10);
  if (topP) {
    ctx.save();
    ctx.fillStyle = shade("#a6acb5", 0.85);
    ctx.beginPath(); ctx.ellipse(topP.x, topP.y, Math.max(2.5, topP.s * 0.09),
                                 Math.max(1.2, topP.s * 0.05), 0, 0, 7); ctx.fill();
    ctx.fillStyle = st;
    perfShadow(ctx, st, 5);
    ctx.beginPath(); ctx.arc(topP.x, topP.y, Math.max(1.2, topP.s * 0.02), 0, 7); ctx.fill();
    ctx.restore();
  }
  HIT.devices.push(register(body.top, hitId));
  if (hitId === selectedId()) {
    const xs = body.top.map(q => q.x), ys = body.top.map(q => q.y);
    selectionRing(ctx, (Math.min(...xs) + Math.max(...xs)) / 2,
                  (Math.min(...ys) + Math.max(...ys)) / 2,
                  (Math.max(...xs) - Math.min(...xs)) / 2 + 5,
                  (Math.max(...ys) - Math.min(...ys)) / 2 + 5, now);
  }
  if (typeof vizDeviceMarker === "function") {
    vizDeviceMarker(ctx, body.cx + 9, body.cy - 9, hitId, now);
  }
}

/* ---------------- furniture ---------------- */

function drawDesks(ctx, rect, zF, detail, now) {
  const cols = Math.max(1, Math.floor((rect.w - 1.2) / 1.75));
  const rows = Math.max(1, Math.floor((rect.d - 1.2) / 1.7));
  const day = daylight();
  const night = day < 0.25;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = rect.x0 + 0.6 + c * (rect.w - 1.2) / cols;
      const y0 = rect.y0 + 0.6 + r * (rect.d - 1.2) / rows;
      const dw = Math.min(1.2, (rect.w - 1.4) / cols);
      const dd = Math.min(0.55, (rect.d - 1.4) / rows);
      box3(ctx, x0, y0, zF, dw, dd, 0.12, shade("#5a4a34", 0.75), shade("#3d3325", 0.7));
      if (detail) {
        // monitors on the desk back edge
        for (const mx of [x0 + 0.18, x0 + dw - 0.42]) {
          const m = box3(ctx, mx, y0 + dd * 0.62, zF + 0.12, 0.24, 0.05, 0.3,
                         shade("#14181f", 0.95), shade("#0c0f14", 0.9));
          if (m && night) {
            wallQ(ctx, mx, y0 + dd * 0.64, mx + 0.24, y0 + dd * 0.64, zF + 0.16, 0.2,
                  `rgba(120, 200, 255, ${0.10 + winLit(c, r, 9) * 0.12})`);
          }
        }
        // chair
        const ch = project(x0 + dw / 2, y0 - 0.28, zF + 0.05);
        if (ch) {
          ctx.save();
          ctx.fillStyle = "rgba(70, 76, 86, 0.8)";
          ctx.beginPath(); ctx.arc(ch.x, ch.y, Math.max(1.5, ch.s * 0.055), 0, 7); ctx.fill();
          ctx.restore();
        }
      }
    }
  }
}

function drawMeeting(ctx, rect, zF, detail) {
  const tw = Math.min(2.4, rect.w * 0.55), td = Math.min(1.0, rect.d * 0.42);
  box3(ctx, rect.cx - tw / 2, rect.cy - td / 2, zF, tw, td, 0.14,
       shade("#4d4636", 0.8), shade("#353022", 0.75));
  if (!detail) return;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const x = rect.cx + Math.cos(a) * (tw / 2 + 0.45);
    const y = rect.cy + Math.sin(a) * (td / 2 + 0.45);
    const ch = project(x, y, zF + 0.06);
    if (ch) {
      ctx.save();
      ctx.fillStyle = "rgba(78, 84, 94, 0.85)";
      ctx.beginPath(); ctx.arc(ch.x, ch.y, Math.max(1.5, ch.s * 0.05), 0, 7); ctx.fill();
      ctx.restore();
    }
  }
}

function drawLobby(ctx, rect, zF, detail) {
  box3(ctx, rect.x0 + 0.4, rect.y0 + rect.d - 0.55, zF, 2.2, 0.5, 0.42,
       shade("#4a4150", 0.8), shade("#322c38", 0.75));
  box3(ctx, rect.x0 + rect.w * 0.55, rect.y0 + 0.6, zF, 1.8, 0.65, 0.3,
       shade("#3c4450", 0.8), shade("#292f38", 0.75));
  if (!detail) return;
  for (const [px, py] of [[rect.x0 + 0.6, rect.y0 + 0.6], [rect.x0 + 2.4, rect.y0 + 1.0]]) {
    const pl = project(px, py, zF + 0.06);
    if (pl) {
      ctx.save();
      ctx.fillStyle = "rgba(90, 140, 105, 0.85)";
      ctx.beginPath(); ctx.arc(pl.x, pl.y, Math.max(1.5, pl.s * 0.06), 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(60, 100, 75, 0.9)";
      ctx.beginPath(); ctx.arc(pl.x, pl.y, Math.max(1, pl.s * 0.03), 0, 7); ctx.fill();
      ctx.restore();
    }
  }
}

function drawServices(ctx, rect, zF, detail) {
  const day = daylight();
  // stalls along the north wall
  const n = 3;
  for (let k = 0; k < n; k++) {
    const x = rect.x0 + 0.4 + k * ((rect.w - 0.8) / n);
    wallQ(ctx, x, rect.y0 + rect.d - 1.5, x, rect.y0 + rect.d - 0.35, zF, 0.9,
          shade("#4a4f58", 0.85));
  }
  box3(ctx, rect.x0 + 0.3, rect.y0 + 0.3, zF, 1.8, 0.5, 0.42,
       shade("#4a5560", 0.8), shade("#313943", 0.75));
  // fridge
  box3(ctx, rect.x1 - 0.9, rect.y0 + 0.3, zF, 0.6, 0.6, 0.95,
       shade("#8f979f", 0.85), shade("#565d66", 0.8));
}

function drawStorage(ctx, rect, zF, detail) {
  for (let k = 0; k < 2; k++) {
    box3(ctx, rect.x0 + 0.4 + k * (rect.w - 1.4) / 2, rect.y0 + 0.4, zF,
         (rect.w - 1.8) / 2, 0.5, 0.95, shade("#5c5244", 0.8), shade("#3e372e", 0.75));
  }
}

function drawFurniture(ctx, b, f, r, rect, zF, detail, now) {
  switch (r.usage) {
    case "office": drawDesks(ctx, rect, zF, detail, now); break;
    case "meeting": drawMeeting(ctx, rect, zF, detail); break;
    case "lobby": drawLobby(ctx, rect, zF, detail); break;
    case "server": break; /* racks are drawn as equipment */
    case "storage": drawStorage(ctx, rect, zF, detail); break;
    default: drawServices(ctx, rect, zF, detail);
  }
}

/* ---------------- room walls ---------------- */

function drawRoomWalls(ctx, b, rect, zF, h, doorDir, detail) {
  const day = daylight();
  const fill = shade("#5d6572", 0.52 + 0.25 * day);
  const fillTop = shade("#7a8391", 0.6 + 0.25 * day);
  const doorW = 0.9;
  const doorAt = (x0, x1) => (x0 + x1) / 2;

  const seg = (ax, ay, bx, by, z0) => wallQ(ctx, ax, ay, bx, by, z0, h, fill);

  // north wall (door if doorDir === "n")
  if (doorDir === "n") {
    seg(rect.x0, rect.y0 + rect.d, doorAt(rect.x0, rect.x1) - doorW / 2, rect.y0 + rect.d, zF);
    seg(doorAt(rect.x0, rect.x1) + doorW / 2, rect.y0 + rect.d, rect.x1, rect.y0 + rect.d, zF);
  } else {
    seg(rect.x0, rect.y0 + rect.d, rect.x1, rect.y0 + rect.d, zF);
  }
  // east wall
  seg(rect.x1, rect.y0, rect.x1, rect.y0 + rect.d, zF);
  // south wall (door if doorDir === "s")
  if (doorDir === "s") {
    seg(rect.x0, rect.y0, doorAt(rect.x0, rect.x1) - doorW / 2, rect.y0, zF);
    seg(doorAt(rect.x0, rect.x1) + doorW / 2, rect.y0, rect.x1, rect.y0, zF);
  } else {
    seg(rect.x0, rect.y0, rect.x1, rect.y0, zF);
  }
  // west wall
  seg(rect.x0, rect.y0, rect.x0, rect.y0 + rect.d, zF);

  // wall tops (readable edges from above)
  ctx.save();
  ctx.strokeStyle = "rgba(225, 235, 245, 0.20)";
  ctx.lineWidth = 1;
  const top = [project(rect.x0, rect.y0, zF + h), project(rect.x1, rect.y0, zF + h),
               project(rect.x1, rect.y0 + rect.d, zF + h), project(rect.x0, rect.y0 + rect.d, zF + h)];
  if (top.every(Boolean)) { quadPath(ctx, top); ctx.stroke(); }
  ctx.restore();
}

/* ---------------- floor content (shared by building & floor views) ---------------- */

function drawFloorContent(ctx, b, f, fi, snap, now, detail) {
  const top = floorTop(b, fi);
  // Closed building: the plan sits at the bottom of the floor volume.  As the
  // exploded view opens, ease the plan up onto the lifted slab so each floor
  // reads as a genuine section rather than a floating tint.
  const mix = typeof explodeMix === "function" ? explodeMix() : 0;
  const zF = top - b.fh + 0.02 + (mix > 0 ? (b.fh - 0.015) * mix : 0);
  const day = daylight();
  const equips = {};
  for (const d of snap.equipment || []) equips[d.id] = d;
  const nightGlow = day < 0.3;

  // Exploded sections need a visible deck under the room tints; without it a
  // night/status view reduces each floor to two thin edges.
  if (mix > 0.02) {
    const deck = [project(b.x0 + 0.2, b.y0 + 0.2, zF), project(b.x1 - 0.2, b.y0 + 0.2, zF),
                  project(b.x1 - 0.2, b.y1 - 0.2, zF), project(b.x0 + 0.2, b.y1 - 0.2, zF)];
    if (deck.every(Boolean)) quad(ctx, deck, `rgba(122, 150, 182, ${0.10 * mix})`);
  }

  for (const r of f.rooms) {
    const rect = roomRect(b, r);
    const rData = findTwinThing(r.id) ? findTwinThing(r.id).data : null;
    const anom = rData ? rData.anomalies || 0 : 0;

    // floor tint: visualization mode color, or the neutral usage tint
    const c = [project(rect.x0, rect.y0, zF + 0.005), project(rect.x1, rect.y0, zF + 0.005),
               project(rect.x1, rect.y1, zF + 0.005), project(rect.x0, rect.y1, zF + 0.005)];
    const vizCol = (typeof vizSpaceColor === "function") ? vizSpaceColor(rData) : null;
    const heat = typeof VIZ !== "undefined" && VIZ.mode === "heatmap";
    if (c.every(Boolean)) {
      quad(ctx, c, vizCol ? rgba(vizCol, heat ? 0.42 : 0.22)
        : (heat ? "rgba(110, 116, 128, 0.10)" : (USAGE_TINT[r.usage] || "rgba(255,255,255,0.04)")));
      if (anom) {
        ctx.save();
        ctx.strokeStyle = `rgba(224, 70, 70, ${0.4 + 0.3 * Math.sin(now / 350)})`;
        perfShadow(ctx, "rgba(224, 70, 70, 0.6)", 8);
        ctx.lineWidth = 1.4;
        quadPath(ctx, c); ctx.stroke();
        ctx.restore();
      }
      const rSel = (typeof S !== "undefined" && S.selection && S.selection.id === r.id);
      if (rSel) {
        ctx.save();
        ctx.strokeStyle = "rgba(143, 220, 255, 0.95)";
        perfShadow(ctx, "rgba(96, 200, 255, 0.95)", 12);
        ctx.lineWidth = 2;
        quadPath(ctx, c); ctx.stroke();
        ctx.restore();
      } else if (r.id === (typeof S !== "undefined" ? S.hover : null)) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.2;
        quadPath(ctx, c); ctx.stroke();
        ctx.restore();
      }
      if (anom) {
        const bp = quadBadgePoint(c);
        if (bp) drawAnomalyBadge(ctx, bp.x, bp.y, anom, now);
      }
      if (detail) HIT.rooms.push(register(c, r.id));
    }

    if (detail) {
      drawRoomWalls(ctx, b, rect, zF, 0.45, r.fy < 0.5 ? "n" : "s", false);
      drawFurniture(ctx, b, f, r, rect, zF, true, now);
    } else {
      drawRoomWalls(ctx, b, rect, zF, 0.22, r.fy < 0.5 ? "n" : "s", false);
    }

    // lights
    const lt = equips[`lt-${r.id}`];
    const on = lt && lt.actual > 0.02;
    const cols = Math.max(1, Math.round(rect.w / 3.4));
    const rows = Math.max(1, Math.round(rect.d / 3.4));
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        const x = rect.x0 + (cc + 0.5) * rect.w / cols;
        const y = rect.y0 + (rr + 0.5) * rect.d / rows;
        drawLightFixture(ctx, x, y, top - 0.09 + 0.2 * mix, on,
                         lt ? lt.status : "ok", now, lt ? lt.id : "?");
      }
    }

    // plugs (on the south wall + one mid-room strip)
    const pl = equips[`pl-${r.id}`];
    drawSocket(ctx, rect.x0 + 0.5, rect.y0 + 0.09, top, pl, now, pl ? pl.id : "?");
    drawSocket(ctx, rect.x1 - 0.5, rect.y0 + 0.09, top, pl, now, pl ? pl.id : "?");

    // server racks
    if (r.usage === "server") {
      drawRacks(ctx, rect, top, equips["ups-b1"], now, detail, "ups-b1");
    }
    // storage: water heater
    if (r.id === "b2f1r3") {
      drawWaterHeater(ctx, rect, top, equips["wh-b2"], now, "wh-b2");
    }
  }

  // floor FCU on the north wall of the hallway (b1) or the north wall (b2)
  const fcu = equips[f.fcu_id || `fc-${f.id}`];
  let fx = b.cx, fy = b.y1 - 0.14;
  if (b.id === "b1") {
    fy = b.y0 + 0.56 * b.d - 0.12;
    fx = b.cx - 1.2;
  }
  if (detail) drawFcu(ctx, fx, fy, top, fcu, now, fcu ? fcu.id : "?");

  // elevator shaft on this floor
  if (b.elevator) {
    const el = drawElevator(ctx, b, snap, now, top, b.fh);
  }

  // warm interior wash at night
  if (nightGlow) {
    const c = [project(b.x0 + 0.2, b.y0 + 0.2, zF + 0.01), project(b.x1 - 0.2, b.y0 + 0.2, zF + 0.01),
               project(b.x1 - 0.2, b.y1 - 0.2, zF + 0.01), project(b.x0 + 0.2, b.y1 - 0.2, zF + 0.01)];
    if (c.every(Boolean)) quad(ctx, c, "rgba(255, 214, 150, 0.035)");
  }
}

/* ---------------- view renderers ---------------- */

function drawCampus(ctx, now, snap) {
  drawGroundPlane(ctx, now, true);
  drawEvStation(ctx, BUILD.b1, snap, now);
  // far building first
  for (const id of ["b2", "b1"]) {
    const b = BUILD[id];
    const bData = (snap.buildings || []).find(x => x.id === id);
    drawRoofSlab(ctx, b, snap, now);
    drawFacade(ctx, b, now, snap);
    // ground plinth shadow
    const sh = [project(b.x0 + 0.7, b.y0 + 1.2, BUILD.groundZ + 0.005),
                project(b.x1 - 0.7, b.y0 + 1.2, BUILD.groundZ + 0.005),
                project(b.x1 - 0.7, b.y1 + 1.5, BUILD.groundZ + 0.005),
                project(b.x0 - 1.2, b.y1 + 1.5, BUILD.groundZ + 0.005)];
    if (sh.every(Boolean)) quad(ctx, sh, "rgba(0,0,0,0.35)");
    // full-box hit
    const hit = [project(b.x0, b.y0, BUILD.groundZ), project(b.x1, b.y0, BUILD.groundZ),
                 project(b.x1, b.y1, b.roofZ), project(b.x0, b.y1, b.roofZ)];
    HIT.buildings.push(register(hit, id));
    // visualization footprint ring
    const vizCol = (typeof vizSpaceColor === "function") ? vizSpaceColor(bData) : null;
    if (vizCol) {
      const ring = [project(b.x0 - 0.8, b.y0 - 0.8, BUILD.groundZ + 0.02),
                    project(b.x1 + 0.8, b.y0 - 0.8, BUILD.groundZ + 0.02),
                    project(b.x1 + 0.8, b.y1 + 0.8, BUILD.groundZ + 0.02),
                    project(b.x0 - 0.8, b.y1 + 0.8, BUILD.groundZ + 0.02)];
      if (ring.every(Boolean)) {
        ctx.save();
        ctx.strokeStyle = rgba(vizCol, 0.75);
        perfShadow(ctx, rgba(vizCol, 0.55), 14);
        ctx.lineWidth = 2;
        quadPath(ctx, ring);
        ctx.stroke();
        ctx.restore();
      }
    }
    // label chip
    const label = project(b.cx, b.cy, b.roofZ + 1.3);
    if (label && bData) {
      const anom = bData.anomalies || 0;
      const vizVal = (typeof vizSpaceChip === "function") ? vizSpaceChip(bData, true) : null;
      drawSceneChip(ctx, label.x, label.y, b.name.toUpperCase(),
                    vizVal || `${bData.actual.toFixed(1)} kW${anom ? ` · ${anom}⚠` : ""}`,
                    vizCol || (anom ? "rgba(239, 106, 69, 0.9)" : "rgba(96, 200, 255, 0.8)"));
      if (anom) drawAnomalyBadge(ctx, label.x + 46, label.y - 7, anom, now);
    }
  }
}

function drawBuilding(ctx, now, snap, b) {
  drawGroundPlane(ctx, now, false);
  drawEvStation(ctx, b.id === "b1" ? b : null, snap, now);
  const bData = (snap.buildings || []).find(x => x.id === b.id);
  const exploded = explodeMix() > 0.01;

  // dashed section guides sit behind the lifted floors
  if (exploded) drawExplodeGuides(ctx, b);

  // floors bottom-up: slab + content (visible through the glass when closed)
  for (let fi = 1; fi <= b.floors.length; fi++) {
    const f = b.floors[fi - 1];
    const top = floorTop(b, fi);
    // slab; its top face is the floor's click target in the exploded view
    const slab = box3(ctx, b.x0 + 0.15, b.y0 + 0.15, top - 0.16, b.w - 0.3, b.d - 0.3, 0.16,
                      shade("#252a33", 0.75), shade("#181b21", 0.7));
    if (slab && exploded) {
      HIT.floors.push(register(slab.top, f.id));
      ctx.save();
      ctx.strokeStyle = "rgba(170, 205, 235, 0.38)";
      ctx.lineWidth = 1;
      quadPath(ctx, slab.top);
      ctx.stroke();
      ctx.restore();
    }
    drawFloorContent(ctx, b, f, fi, snap, now, false);
    // floor chip on the west edge
    const fData = findTwinThing(f.id) ? findTwinThing(f.id).data : null;
    const chip = project(b.x0 - 0.1, b.cy, top - b.fh / 2);
    if (chip && fData) {
      const sel = (typeof S !== "undefined" && S.view && S.view.floorId === f.id);
      const vizVal = (typeof vizSpaceChip === "function") ? vizSpaceChip(fData, true) : null;
      const vizCol = (typeof vizSpaceColor === "function") ? vizSpaceColor(fData) : null;
      drawSceneChip(ctx, chip.x, chip.y, `F${fi}`,
                    vizVal || (fData.anomalies ? `${fData.anomalies}⚠` : `${fData.actual.toFixed(1)} kW`),
                    vizCol || (fData.anomalies ? "rgba(239, 106, 69, 0.9)" : (sel ? "rgba(143, 220, 255, 0.9)" : "rgba(120, 140, 165, 0.7)")));
      if (fData.anomalies) drawAnomalyBadge(ctx, chip.x + 34, chip.y - 7, fData.anomalies, now);
    }
  }

  // full-height elevator and glass only make sense when the building is
  // closed; the exploded view draws a per-floor shaft inside each slab
  if (!exploded && b.elevator) {
    drawElevator(ctx, b, snap, now, b.roofZ, b.roofZ - BUILD.groundZ);
  }
  if (!exploded) drawFacade(ctx, b, now, snap);
  drawRoofSlab(ctx, b, snap, now);

  // building chip, lifted with the roof
  const roofZ = b.roofZ + roofLift(b);
  const label = project(b.cx, b.cy, roofZ + 1.5);
  if (label && bData) {
    const vizVal = (typeof vizSpaceChip === "function") ? vizSpaceChip(bData, true) : null;
    const vizCol = (typeof vizSpaceColor === "function") ? vizSpaceColor(bData) : null;
    drawSceneChip(ctx, label.x, label.y, b.name.toUpperCase(),
                  vizVal || `${bData.actual.toFixed(1)} kW`,
                  vizCol || (bData.anomalies ? "rgba(239, 106, 69, 0.9)" : "rgba(96, 200, 255, 0.8)"));
    if (bData.anomalies) drawAnomalyBadge(ctx, label.x + 48, label.y - 7, bData.anomalies, now);
  }
}

function drawFloor(ctx, now, snap, b) {
  const view = (typeof S !== "undefined" && S.view) || {};
  const f = b.floors.find(x => x.id === view.floorId) || b.floors[0];
  const fi = b.floors.indexOf(f) + 1;
  const top = floorTop(b, fi);

  // cutaway plinth
  const px0 = b.x0 - 3.2, px1 = b.x1 + 3.2, py0 = b.y0 - 3.2, py1 = b.y1 + 3.2;
  box3(ctx, px0, py0, top - 0.5, px1 - px0, py1 - py0, 0.5,
       shade("#1e222a", 0.85), shade("#14171d", 0.8));
  // drop shadow under the plinth
  const sh = [project(px0 + 0.6, py0 + 1.0, top - 0.5), project(px1 - 0.6, py0 + 1.0, top - 0.5),
              project(px1 - 0.6, py1 + 1.2, top - 0.5), project(px0 - 0.8, py1 + 1.2, top - 0.5)];
  if (sh.every(Boolean)) quad(ctx, sh, "rgba(0,0,0,0.4)");

  drawFloorContent(ctx, b, f, fi, snap, now, true);

  // room chips
  for (const r of f.rooms) {
    const rect = roomRect(b, r);
    const rData = findTwinThing(r.id) ? findTwinThing(r.id).data : null;
    if (!rData) continue;
    const chip = project(rect.x0 + 0.5, rect.y0 + 0.35, top + 0.02);
    if (!chip) continue;
    const sel = (typeof S !== "undefined" && S.view && S.view.roomId === r.id);
    const vizVal = (typeof vizSpaceChip === "function") ? vizSpaceChip(rData) : null;
    const vizCol = (typeof vizSpaceColor === "function") ? vizSpaceColor(rData) : null;
    drawSceneChip(ctx, chip.x, chip.y, r.name.toUpperCase(),
                  vizVal || `${rData.actual.toFixed(1)} kW`,
                  vizCol || (rData.anomalies ? "rgba(239, 106, 69, 0.9)" : (sel ? "rgba(143, 220, 255, 0.9)" : "rgba(120, 140, 165, 0.7)")));
  }

  // floor header chip
  const head = project(b.x0 - 0.1, b.cy, top + 1.0);
  if (head) {
    drawSceneChip(ctx, head.x, head.y, `${b.name.toUpperCase()} · ${f.name.toUpperCase()}`, "", "rgba(143, 220, 255, 0.9)");
    const fThing = findTwinThing(f.id);
    const fAnom = fThing && fThing.data ? (fThing.data.anomalies || 0) : 0;
    if (fAnom) drawAnomalyBadge(ctx, head.x + 46, head.y - 7, fAnom, now);
  }
}

function drawRoom(ctx, now, snap, b) {
  const view = (typeof S !== "undefined" && S.view) || {};
  const f = b.floors.find(x => x.id === view.floorId) || b.floors[0];
  const fi = b.floors.indexOf(f) + 1;
  const top = floorTop(b, fi);
  const r = f.rooms.find(x => x.id === view.roomId) || f.rooms[0];
  const rect = roomRect(b, r);
  const zF = top - b.fh + 0.02;
  const equips = {};
  for (const d of snap.equipment || []) equips[d.id] = d;
  const day = daylight();
  const rData = findTwinThing(r.id) ? findTwinThing(r.id).data : null;

  // plinth
  const m = 2.6;
  box3(ctx, rect.x0 - m, rect.y0 - m, top - 0.5, rect.w + m * 2, rect.d + m * 2, 0.5,
       shade("#1e222a", 0.85), shade("#14171d", 0.8));
  // room floor: visualization tint (including the playback heatmap)
  const fc = [project(rect.x0, rect.y0, zF + 0.006), project(rect.x1, rect.y0, zF + 0.006),
              project(rect.x1, rect.y1, zF + 0.006), project(rect.x0, rect.y1, zF + 0.006)];
  const vizCol = (typeof vizSpaceColor === "function") ? vizSpaceColor(rData) : null;
  const heat = typeof VIZ !== "undefined" && VIZ.mode === "heatmap";
  if (fc.every(Boolean)) {
    quad(ctx, fc, vizCol ? rgba(vizCol, heat ? 0.5 : 0.32)
      : (heat ? "rgba(110, 116, 128, 0.12)" : shade("#31363f", 0.75)));
    if (rData && rData.anomalies) {
      const bp = quadBadgePoint(fc);
      if (bp) drawAnomalyBadge(ctx, bp.x, bp.y, rData.anomalies, now);
    }
  }

  // walls: north + west full, east/south low (cutaway toward the camera)
  const wallFill = shade("#6b7482", 0.5 + 0.3 * day);
  wallQ(ctx, rect.x0, rect.y1, rect.x1, rect.y1, zF, 0.95, wallFill);
  wallQ(ctx, rect.x0, rect.y0, rect.x0, rect.y1, zF, 0.95, wallFill);
  wallQ(ctx, rect.x1, rect.y0, rect.x1, rect.y1, zF, 0.26, wallFill);
  // south wall with door gap
  wallQ(ctx, rect.x0, rect.y0, rect.cx - 0.45, rect.y0, zF, 0.22, wallFill);
  wallQ(ctx, rect.cx + 0.45, rect.y0, rect.x1, rect.y0, zF, 0.22, wallFill);
  // window strip on the north wall
  const win = wallQ(ctx, rect.x0 + rect.w * 0.2, rect.y1, rect.x1 - rect.w * 0.2, rect.y1,
                    zF + 0.35, 0.38, `rgba(140, 175, 210, ${0.20 + 0.25 * day})`);
  if (win) {
    ctx.save();
    ctx.strokeStyle = "rgba(225, 235, 245, 0.3)";
    ctx.lineWidth = 1;
    quadPath(ctx, win.pts); ctx.stroke();
    ctx.restore();
  }

  // furniture + devices (full detail)
  drawFurniture(ctx, b, f, r, rect, zF, true, now);
  const lt = equips[`lt-${r.id}`];
  const cols = Math.max(1, Math.round(rect.w / 3.4));
  const rows = Math.max(1, Math.round(rect.d / 3.4));
  for (let rr = 0; rr < rows; rr++) {
    for (let cc = 0; cc < cols; cc++) {
      const x = rect.x0 + (cc + 0.5) * rect.w / cols;
      const y = rect.y0 + (rr + 0.5) * rect.d / rows;
      drawLightFixture(ctx, x, y, top - 0.09, lt && lt.actual > 0.02, lt ? lt.status : "ok", now, lt ? lt.id : "?");
    }
  }
  const pl = equips[`pl-${r.id}`];
  drawSocket(ctx, rect.x0 + 0.5, rect.y0 + 0.1, top, pl, now, pl ? pl.id : "?");
  drawSocket(ctx, rect.x1 - 0.5, rect.y0 + 0.1, top, pl, now, pl ? pl.id : "?");
  if (r.usage === "server") drawRacks(ctx, rect, top, equips["ups-b1"], now, true, "ups-b1");
  if (r.id === "b2f1r3") drawWaterHeater(ctx, rect, top, equips["wh-b2"], now, "wh-b2");
  if (b.elevator) drawElevator(ctx, b, snap, now, top, b.fh);
  if (b.id === "b1" && fi === 1) {
    /* EV charger stays at ground level; not part of the room interior */
  }

  // room background hit
  if (fc.every(Boolean)) HIT.rooms.push(register(fc, r.id));

  // device tags (room view shows every device)
  const tagAt = (x, y, dev, title) => {
    const p = project(x, y, top + 0.15);
    if (!p || !dev) return;
    const vizCol = (typeof vizDeviceColor === "function") ? vizDeviceColor(dev) : null;
    drawSceneChip(ctx, p.x, p.y - 16, title, `${dev.actual.toFixed(2)} kW`,
                  vizCol || stColor(dev.status));
  };
  tagAt(rect.x0 + rect.w * 0.5, rect.y0 + rect.d * 0.5, lt, "LIGHTING");
  tagAt(rect.x0 + 0.7, rect.y0 + 0.5, pl, "PLUGS");
  if (r.usage === "server") tagAt(rect.x0 + 1.2, rect.y0 + 1.2, equips["ups-b1"], "SERVER UPS");
  if (r.id === "b2f1r3") tagAt(rect.x0 + 1.2, rect.y0 + 1.2, equips["wh-b2"], "WATER HEATER");
  const fcu = equips[f.fcu_id || `fc-${f.id}`];
  tagAt(b.cx, b.y1 - 0.4, fcu, "FLOOR FCU");

  // room header chip
  const head = project(rect.cx, rect.y1 + 0.4, top + 0.4);
  if (head) {
    const vizVal = (typeof vizSpaceChip === "function" && rData)
      ? vizSpaceChip(rData) : null;
    drawSceneChip(ctx, head.x, head.y, r.name.toUpperCase(),
                  vizVal || (rData ? `${rData.actual.toFixed(1)} kW · ${r.area} m²` : ""),
                  vizCol || (rData && rData.anomalies ? "rgba(239, 106, 69, 0.9)" : "rgba(143, 220, 255, 0.9)"));
    if (rData && rData.anomalies) {
      drawAnomalyBadge(ctx, head.x + 48, head.y - 7, rData.anomalies, now);
    }
  }
}

function drawBuildingView(ctx, now, snap) {
  HIT.clear();
  if (VIEW.mode === "campus") {
    drawCampus(ctx, now, snap);
    return;
  }
  const view = (typeof S !== "undefined" && S.view) || {};
  const b = BUILD[view.buildingId] || BUILD.b1;
  if (!b) { drawCampus(ctx, now, snap); return; }
  if (VIEW.mode === "building") drawBuilding(ctx, now, snap, b);
  else if (VIEW.mode === "floor") drawFloor(ctx, now, snap, b);
  else drawRoom(ctx, now, snap, b);
}

/* ---------------- inspection helpers (used by the UI / test harness) ---------------- */

/* Spaces with active anomalies, across the whole hierarchy. */
function anomalyHighlights() {
  const out = [];
  if (typeof S === "undefined" || !S.snap) return out;
  for (const b of S.snap.buildings || []) {
    if (b.anomalies) out.push({ id: b.id, kind: "building", name: b.name, count: b.anomalies });
    for (const f of b.floors || []) {
      if (f.anomalies) out.push({ id: f.id, kind: "floor", name: f.name, count: f.anomalies });
      for (const r of f.rooms || []) {
        if (r.anomalies) out.push({ id: r.id, kind: "room", name: r.name, count: r.anomalies });
      }
    }
  }
  return out;
}

/* Current exploded state plus absolute floor tops, for the harness and for
   any panel that wants to describe the layout. */
function explodeLayout(buildingId) {
  const b = BUILD[buildingId || (typeof S !== "undefined" && S.view && S.view.buildingId) || "b1"];
  if (!b) return null;
  return {
    on: EXPLODE.on,
    t: EXPLODE.t,
    gap: EXPLODE.gap,
    floors: b.floors.map((f, i) => ({
      id: f.id,
      name: f.name,
      top: floorTop(b, i + 1),
      lift: floorLift(b, i + 1),
    })),
    roofLift: roofLift(b),
  };
}

/* ---------------- boot ---------------- */

VIEW.home = { ...CAM_PRESETS.roof.target };
