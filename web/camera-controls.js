/* ============================================================
   CAMERA CONTROL — professional orbit / dolly / presets
   ------------------------------------------------------------
   The Canvas renderer keeps its original compact orbit model.  When the
   opt-in WebGL presentation renderer is active this module adds the
   controls an architectural viewer expects:

     - full 360° yaw with no wrapped dead end
     - collision-aware pitch limits (ground / roof / room ceiling)
     - critically damped dolly zoom with mode-aware distance limits
     - frame-buffered orbit with a short follow filter and quick release
     - right / shift drag panning with per-space bounds
     - smooth Front / Back / Left / Right / Top / Isometric presets
     - Home (frame current view), Focus selection, Reset camera
     - one-finger orbit and two-finger pinch dolly
     - optional keyboard camera controls (Shift+arrows, H, + / -)

   Room inspection is a special case.  After the cinematic entry settles the
   eye orbits the ROOM CENTRE while looking at the authored focal target.
   Selecting or focusing a device biases that pivot toward the device, so
   mouse orbit circles the selected equipment with the room as context, while
   the wall/ceiling collision limits keep the eye inside the room.
   ============================================================ */

"use strict";

const CAMCTL = {
  distGoal: null,
  preset: null,
  pendingFocus: null,
  lastAction: "",
  // Input smoothing / motion state.  Orbit input accumulates into a target
  // angle and the rendered angle follows it with a short time constant; the
  // dolly uses a critically damped spring so it accelerates and decelerates
  // without overshoot.
  gesture: null,          // orbit | pan | pinch | null
  orbitTarget: null,      // { yaw, pitch }
  pendingOrbit: { dx: 0, dy: 0 },
  pendingPan: { dx: 0, dy: 0 },
  dollyVel: 0,
  lastInputT: 0,
  lastDollyT: 0,
  inspectId: null,        // device used as the selected inspection target
};

const CAM_ORBIT_SENS = 0.005;        // radians per CSS pixel
const CAM_PITCH_SENS = 0.004;
const CAM_ORBIT_TAU = 0.04;          // s; short, perceptually instant follow
const CAM_ORBIT_SETTLE_TAU = 0.018;  // s; quick, predictable stop after release
const CAM_DOLLY_OMEGA = 22;          // 1/s; critically damped, ~0.25 s settle
const CAM_MIN_PITCH = 0.015;         // ~1°, stays above the target plane
const CAM_MAX_PITCH = 1.52;          // ~87°, never reaches the up-vector pole
const CAM_CANVAS_PITCH = { min: 0.18, max: 1.45 };
const CAM_ROOM_MARGIN = 0.42;

function camAngDiff(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function camIs3D() {
  return typeof TWIN3D !== "undefined" && TWIN3D && TWIN3D.isActive()
    && typeof VIEW !== "undefined" && VIEW.mode !== "roof";
}

function camPresent() {
  return (typeof window !== "undefined") ? window.TWIN3D_PRESENT || null : null;
}

function camViewState() {
  return (typeof S !== "undefined" && S.view) ? S.view : { mode: VIEW.mode };
}

function camCurrentRoomId() {
  const v = camViewState();
  if (v.roomId) return v.roomId;
  if (VIEW.mode === "room" && v.roomId) return v.roomId;
  return null;
}

function camCurrentFloorId() {
  const v = camViewState();
  if (v.floorId) return v.floorId;
  const roomId = camCurrentRoomId();
  const P = camPresent();
  if (roomId && P && P.rooms[roomId]) return P.rooms[roomId].floorId;
  return null;
}

function camCurrentBuildingId() {
  const v = camViewState();
  if (v.buildingId) return v.buildingId;
  const floorId = camCurrentFloorId();
  const P = camPresent();
  if (floorId && P && P.floors[floorId]) return P.floors[floorId].towerId;
  return "b1";
}

function camRoomInfo() {
  if (!camIs3D()) return null;
  const roomId = camCurrentRoomId();
  if (!roomId) return null;
  try { return TWIN3D.roomInfo(roomId); } catch (_) { return null; }
}

function camEye() {
  const p = VIEW.pivot || VIEW.target;
  const cosP = Math.cos(VIEW.pitch), sinP = Math.sin(VIEW.pitch);
  return {
    x: p.x + Math.sin(VIEW.yaw) * VIEW.dist * cosP,
    y: p.y - Math.cos(VIEW.yaw) * VIEW.dist * cosP,
    z: p.z + VIEW.dist * sinP,
  };
}

function camFloorSpec() {
  const P = camPresent();
  const floorId = camCurrentFloorId();
  if (!P || !floorId || !P.floors[floorId]) return null;
  const f = P.floors[floorId];
  const t = P.towers[f.towerId];
  if (!t) return null;
  return { floor: f, tower: t };
}

function camFloorClearRadius() {
  const spec = camFloorSpec();
  if (!spec) return 16;
  const b = spec.floor.bounds;
  // A generous horizontal stand-off (not just the footprint) keeps a high
  // orbit an architectural overview instead of a close-up of the mullions.
  return Math.hypot(b.w, b.d) / 2 + 5.5;
}

function camTowerClearRadius(towerId) {
  const P = camPresent();
  const t = P && P.towers[towerId || "b1"];
  if (!t) return 15;
  const b = t.floors[0].bounds;
  return Math.hypot(b.w, b.d) / 2 + 2.5;
}

function camRoomMaxDist(room, yaw, pitch, pivot) {
  if (!room) return 14;
  const cosP = Math.max(0.0001, Math.cos(pitch));
  const dir = { x: Math.sin(yaw), y: -Math.cos(yaw) };
  const r = room.rect;
  const m = CAM_ROOM_MARGIN;
  const axis = (origin, d, lo, hi) => {
    if (Math.abs(d) < 1e-6) return Infinity;
    const t = d > 0 ? (hi - m - origin) / d : (lo + m - origin) / d;
    return t > 0 ? t : 0.2;
  };
  const tx = axis(pivot.x, dir.x, r.x0, r.x1);
  const ty = axis(pivot.y, dir.y, r.y0, r.y1);
  const byWalls = Math.min(tx, ty) / cosP;
  let byCeiling = Infinity;
  if (Math.sin(pitch) > 1e-4) {
    byCeiling = (room.ceiling - 0.28 - pivot.z) / Math.sin(pitch);
  }
  return Math.max(0.7, Math.min(byWalls, byCeiling));
}

function camDistanceLimits() {
  if (!camIs3D()) return null;
  const mode = VIEW.mode;
  if (mode === "room") {
    const room = camRoomInfo();
    if (!room) return { min: 0.9, max: 14 };
    const pivot = VIEW.pivot || room.center;
    const max = camRoomMaxDist(room, VIEW.yaw, VIEW.pitch, pivot);
    return { min: 0.9, max: Math.max(1.2, max) };
  }
  if (mode === "floor") {
    const spec = camFloorSpec();
    const radius = camFloorClearRadius();
    const towerId = spec ? spec.tower.id : "b1";
    return { min: radius + 1.6, max: towerId === "b1" ? 75 : 55 };
  }
  if (mode === "building") {
    const P = camPresent();
    const t = P && P.towers[camCurrentBuildingId()];
    if (t && t.id === "b2") return { min: 16, max: 150 };
    // Close enough that the wheel alone can approach the façade, while the
    // dynamic pitch clamp still keeps the eye outside the tower.
    return { min: 26, max: 220 };
  }
  if (mode === "campus") return { min: 32, max: 260 };
  return { min: 0.9, max: 260 };
}

function camPitchLimits(dist, pivotOverride) {
  if (!camIs3D()) return { min: CAM_CANVAS_PITCH.min, max: CAM_CANVAS_PITCH.max };
  const d = Math.max(0.2, dist || VIEW.dist);
  let min = CAM_MIN_PITCH;
  let max = CAM_MAX_PITCH;
  if (VIEW.mode === "floor") {
    const radius = camFloorClearRadius();
    // Stay outside the tower footprint and above the section's slab edge;
    // a floor cutaway is read from a low/medium angle, not from overhead.
    max = Math.min(max, 0.55,
      Math.acos(Math.max(-1, Math.min(1, radius / d))));
  } else if (VIEW.mode === "campus" || VIEW.mode === "building") {
    // Tilt is capped by the angle at which the eye would cross the tower
    // footprint.  This is continuous as the wheel changes distance, so a
    // close approach never triggers a sudden pitch snap; at normal
    // overview distances the cap is a near-overhead ~85°.
    const clearance = camTowerClearRadius(camCurrentBuildingId());
    max = Math.min(max, Math.acos(Math.max(-1, Math.min(1, clearance / d))));
  } else if (VIEW.mode === "room") {
    const room = camRoomInfo();
    if (room) {
      const pivot = pivotOverride || VIEW.pivot || room.center;
      const vertical = (room.ceiling - 0.28 - pivot.z) / Math.max(0.001, d);
      max = Math.min(max, Math.asin(Math.max(-1, Math.min(1, vertical))));
      // A person inspecting a cabinet can look slightly upward (eye below
      // the room-centre pivot) as long as the eye stays above the floor.
      const floorArc = Math.asin(Math.max(-1, Math.min(1,
        (room.base + 0.45 - pivot.z) / d)));
      min = Math.max(-0.35, floorArc);
      if (min > max) min = Math.max(-0.35, max - 0.02);
    }
  }
  return { min, max: Math.max(min + 0.02, max) };
}

function camClampPitch() {
  const lim = camPitchLimits(VIEW.dist);
  VIEW.pitch = Math.max(lim.min, Math.min(lim.max, VIEW.pitch));
}

/* Arm the room pivot without moving the eye: recompute the orbit values
   around the room centre while keeping the current camera position and
   look target. */
function camEnsureRoomPivot() {
  if (!camIs3D() || VIEW.mode !== "room") return false;
  const room = camRoomInfo();
  if (!room) return false;
  const eye = camEye();
  const c = camPivotForCurrentRoom(room) || room.center;
  VIEW.pivot = { x: c.x, y: c.y, z: c.z };
  const dx = eye.x - c.x, dy = eye.y - c.y, dz = eye.z - c.z;
  const d = Math.max(0.2, Math.hypot(dx, dy, dz));
  VIEW.yaw = Math.atan2(dx, -dy);
  VIEW.pitch = Math.asin(Math.max(-1, Math.min(1, dz / d)));
  VIEW.dist = d;
  camClampRoomRig();
  camSyncOrbitTarget();
  return true;
}

function camClampRoomTarget() {
  const room = camRoomInfo();
  if (!room) return;
  const r = room.rect;
  const t = VIEW.target;
  t.x = Math.max(r.x0 + 0.3, Math.min(r.x1 - 0.3, t.x));
  t.y = Math.max(r.y0 + 0.3, Math.min(r.y1 - 0.3, t.y));
  t.z = Math.max(room.base + 0.35, Math.min(room.ceiling - 0.35, t.z));
}

function camClampRoomRig() {
  const room = camRoomInfo();
  if (!room || !VIEW.pivot) return;
  camClampRoomTarget();
  camClampPitch();
  const max = camRoomMaxDist(room, VIEW.yaw, VIEW.pitch, VIEW.pivot);
  VIEW.dist = Math.max(0.9, Math.min(VIEW.dist, Math.max(1.2, max)));
}

/* When a device is the selected inspection target, bias the room orbit
   pivot toward it (but not onto a wall) so dragging feels like circling
   the equipment, while the full 360° path still stays inside the room. */
function camInspectPivot(room, deviceId) {
  if (!room || !deviceId) return room ? { ...room.center } : null;
  let info = null;
  try { info = TWIN3D.focusInfo(deviceId); } catch (_) { info = null; }
  if (!info || info.roomId !== room.id) return { ...room.center };
  const c = room.center, d = info.center;
  const dx = d.x - c.x, dy = d.y - c.y;
  const r = room.rect;
  const margin = 1.05;
  let t = 0.55;
  if (dx > 1e-4) t = Math.min(t, (r.x1 - margin - c.x) / dx);
  else if (dx < -1e-4) t = Math.min(t, (r.x0 + margin - c.x) / dx);
  if (dy > 1e-4) t = Math.min(t, (r.y1 - margin - c.y) / dy);
  else if (dy < -1e-4) t = Math.min(t, (r.y0 + margin - c.y) / dy);
  t = Math.max(0.12, Math.min(0.55, t));
  return { x: c.x + dx * t, y: c.y + dy * t, z: c.z };
}

function camPivotForCurrentRoom(room) {
  if (!room) return null;
  if (CAMCTL.inspectId) {
    const id = CAMCTL.inspectId;
    try {
      const info = TWIN3D.focusInfo(id);
      if (info && info.roomId === room.id) return camInspectPivot(room, id);
    } catch (_) { /* fall through */ }
    CAMCTL.inspectId = null;
  }
  return { ...room.center };
}

/* Change the orbit pivot without moving the eye.  The target and rendered
   camera position stay put; only future orbit input changes around the new
   point.  Used when selection moves between room and equipment. */
function camSetRoomPivot(pivot) {
  const room = camRoomInfo();
  if (!room || !pivot) return false;
  const eye = camEye();
  VIEW.pivot = { x: pivot.x, y: pivot.y, z: pivot.z };
  const dx = eye.x - pivot.x, dy = eye.y - pivot.y, dz = eye.z - pivot.z;
  const dist = Math.max(0.2, Math.hypot(dx, dy, dz));
  VIEW.yaw = Math.atan2(dx, -dy);
  VIEW.pitch = Math.asin(Math.max(-1, Math.min(1, dz / dist)));
  VIEW.dist = dist;
  camClampRoomRig();
  camSyncOrbitTarget();
  return true;
}

function camRefreshInspectionPivot() {
  if (!camIs3D() || VIEW.mode !== "room") return false;
  const room = camRoomInfo();
  if (!room) return false;
  if (CAMCTL.inspectId) {
    let info = null;
    try { info = TWIN3D.focusInfo(CAMCTL.inspectId); } catch (_) { info = null; }
    if (!info || info.roomId !== room.id) CAMCTL.inspectId = null;
  }
  const pivot = camPivotForCurrentRoom(room);
  return camSetRoomPivot(pivot);
}

/* Selection changes bias the roving pivot without moving the camera.  If a
   device is selected in the current room, orbit input circles near it; a
   room/level selection returns the pivot to the room centre. */
function cameraSelectionChanged() {
  if (!camIs3D() || VIEW.mode !== "room") {
    CAMCTL.inspectId = null;
    return;
  }
  const sel = (typeof S !== "undefined" && S.selection) || null;
  if (sel && sel.kind === "device") {
    let info = null;
    try { info = TWIN3D.focusInfo(sel.id); } catch (_) { info = null; }
    if (info && info.roomId === camCurrentRoomId()) {
      CAMCTL.inspectId = sel.id;
      if (!(typeof cameraFlightActive === "function" && cameraFlightActive())) {
        camRefreshInspectionPivot();
      }
      return;
    }
  }
  if (CAMCTL.inspectId) {
    CAMCTL.inspectId = null;
    if (!(typeof cameraFlightActive === "function" && cameraFlightActive())) {
      camRefreshInspectionPivot();
    }
  }
}

function camSyncOrbitTarget() {
  CAMCTL.orbitTarget = { yaw: VIEW.yaw, pitch: VIEW.pitch };
  CAMCTL.pendingOrbit.dx = 0;
  CAMCTL.pendingOrbit.dy = 0;
  CAMCTL.lastInputT = 0;
}

function camCancelInputMotion() {
  CAMCTL.gesture = null;
  CAMCTL.orbitTarget = null;
  CAMCTL.pendingOrbit.dx = 0;
  CAMCTL.pendingOrbit.dy = 0;
  CAMCTL.pendingPan.dx = 0;
  CAMCTL.pendingPan.dy = 0;
  CAMCTL.dollyVel = 0;
  CAMCTL.distGoal = null;
  CAMCTL.lastInputT = 0;
  CAMCTL.lastDollyT = 0;
}

/* --------------- input handlers (called by scene.js) --------------- */

/* Direct orbit used by keyboard aliases and scripted tests: feed the same
   smoothed target the mouse uses, so every input path has one feel. */
function cameraOrbitBy(dx, dy) {
  if (!camIs3D()) {
    VIEW.yaw -= dx * CAM_ORBIT_SENS;
    VIEW.pitch = clamp(VIEW.pitch - dy * CAM_PITCH_SENS,
      CAM_CANVAS_PITCH.min, CAM_CANVAS_PITCH.max);
    return;
  }
  if (typeof cancelFlight === "function") cancelFlight();
  CAMCTL.distGoal = null;
  CAMCTL.dollyVel = 0;
  if (!CAMCTL.orbitTarget) {
    CAMCTL.orbitTarget = { yaw: VIEW.yaw, pitch: VIEW.pitch };
  }
  CAMCTL.orbitTarget.yaw -= dx * CAM_ORBIT_SENS;
  const lim = camPitchLimits(VIEW.dist);
  CAMCTL.orbitTarget.pitch = clamp(CAMCTL.orbitTarget.pitch - dy * CAM_PITCH_SENS,
    lim.min, lim.max);
  CAMCTL.preset = null;
  camUpdateUI();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

/* Mouse/touch orbit input is accumulated and consumed on the next frame.
   That removes event-rate jitter from the rendered camera and lets the
   short follow filter provide a natural start/stop without visible lag. */
function cameraInputOrbit(dx, dy) {
  if (!camIs3D()) {
    VIEW.yaw -= dx * CAM_ORBIT_SENS;
    VIEW.pitch = clamp(VIEW.pitch - dy * CAM_PITCH_SENS,
      CAM_CANVAS_PITCH.min, CAM_CANVAS_PITCH.max);
    return;
  }
  if (CAMCTL.gesture !== "orbit") CAMCTL.gesture = "orbit";
  CAMCTL.pendingOrbit.dx += dx;
  CAMCTL.pendingOrbit.dy += dy;
  CAMCTL.preset = null;
}

function cameraInputPan(dx, dy) {
  if (!camIs3D()) {
    panCamera(dx, dy);
    return;
  }
  CAMCTL.pendingPan.dx += dx;
  CAMCTL.pendingPan.dy += dy;
  CAMCTL.preset = null;
}

/* Called by building.js every camera frame, before dolly and flights. */
function cameraInputStep(now) {
  if (!camIs3D()) {
    CAMCTL.pendingOrbit.dx = CAMCTL.pendingOrbit.dy = 0;
    CAMCTL.pendingPan.dx = CAMCTL.pendingPan.dy = 0;
    return false;
  }
  if (typeof cameraFlightActive === "function" && cameraFlightActive()) {
    CAMCTL.pendingOrbit.dx = CAMCTL.pendingOrbit.dy = 0;
    CAMCTL.pendingPan.dx = CAMCTL.pendingPan.dy = 0;
    CAMCTL.orbitTarget = null;
    return false;
  }
  const dt = CAMCTL.lastInputT
    ? clamp((now - CAMCTL.lastInputT) / 1000, 0.001, 0.05) : 1 / 60;
  CAMCTL.lastInputT = now;
  let busy = false;

  if (CAMCTL.pendingPan.dx || CAMCTL.pendingPan.dy) {
    panCamera(CAMCTL.pendingPan.dx, CAMCTL.pendingPan.dy);
    CAMCTL.pendingPan.dx = CAMCTL.pendingPan.dy = 0;
    busy = true;
  }

  if (CAMCTL.pendingOrbit.dx || CAMCTL.pendingOrbit.dy) {
    if (!CAMCTL.orbitTarget) {
      CAMCTL.orbitTarget = { yaw: VIEW.yaw, pitch: VIEW.pitch };
    }
    CAMCTL.orbitTarget.yaw -= CAMCTL.pendingOrbit.dx * CAM_ORBIT_SENS;
    const lim = camPitchLimits(VIEW.dist);
    CAMCTL.orbitTarget.pitch = clamp(
      CAMCTL.orbitTarget.pitch - CAMCTL.pendingOrbit.dy * CAM_PITCH_SENS,
      lim.min, lim.max);
    CAMCTL.pendingOrbit.dx = CAMCTL.pendingOrbit.dy = 0;
    busy = true;
  }

  if (CAMCTL.orbitTarget) {
    const t = CAMCTL.orbitTarget;
    const dy = t.yaw - VIEW.yaw;
    const dp = t.pitch - VIEW.pitch;
    const tiny = Math.abs(dy) < 1e-4 && Math.abs(dp) < 1e-4;
    if (tiny && !CAMCTL.gesture) {
      VIEW.yaw = t.yaw;
      VIEW.pitch = t.pitch;
      CAMCTL.orbitTarget = null;
    } else {
      const tau = CAMCTL.gesture === "orbit" ? CAM_ORBIT_TAU : CAM_ORBIT_SETTLE_TAU;
      const alpha = 1 - Math.exp(-dt / tau);
      VIEW.yaw += dy * alpha;
      VIEW.pitch += dp * alpha;
      if (VIEW.mode === "room" && VIEW.pivot) camClampRoomRig();
      else camClampPitch();
      busy = true;
      if (!CAMCTL.gesture
          && Math.abs(t.yaw - VIEW.yaw) < 5e-5
          && Math.abs(t.pitch - VIEW.pitch) < 5e-5) {
        VIEW.yaw = t.yaw;
        VIEW.pitch = t.pitch;
        CAMCTL.orbitTarget = null;
      }
    }
  }
  return busy;
}

function cameraGestureStart(which) {
  if (!camIs3D()) return;
  const mode = which || "orbit";
  CAMCTL.gesture = mode;
  CAMCTL.distGoal = null;
  CAMCTL.dollyVel = 0;
  CAMCTL.pendingOrbit.dx = CAMCTL.pendingOrbit.dy = 0;
  CAMCTL.pendingPan.dx = CAMCTL.pendingPan.dy = 0;
  CAMCTL.lastInputT = 0;
  CAMCTL.lastDollyT = 0;
  if (mode === "orbit") {
    CAMCTL.orbitTarget = { yaw: VIEW.yaw, pitch: VIEW.pitch };
  } else {
    CAMCTL.orbitTarget = null;
  }
}

function cameraGestureEnd() {
  CAMCTL.gesture = null;
  CAMCTL.lastInputT = 0;
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

function camSetDistance(goal) {
  if (!camIs3D()) return false;
  if (typeof cancelFlight === "function") cancelFlight();
  // Wheel input takes over from any residual orbit smoothing without
  // discarding the current dolly velocity, so successive notches blend.
  CAMCTL.orbitTarget = null;
  CAMCTL.pendingOrbit.dx = CAMCTL.pendingOrbit.dy = 0;
  CAMCTL.distGoal = goal;
  CAMCTL.preset = null;
  camUpdateUI();
  return true;
}

function cameraWheel(deltaY, anchor) {
  if (camIs3D()) {
    if (!deltaY) return true;
    const base = CAMCTL.distGoal == null ? VIEW.dist : CAMCTL.distGoal;
    const goal = base * Math.exp(deltaY * 0.0012);
    camSetDistance(goal);
    camClampDistanceGoal();
    if (typeof sceneInvalidate === "function") sceneInvalidate();
    return true;
  }
  if (typeof ZOOM !== "undefined") {
    if (typeof cancelFlight === "function") cancelFlight();
    ZOOM.anchor = anchor || null;
    ZOOM.goal = clamp(ZOOM.goal * Math.exp(-deltaY * 0.0012),
      typeof CAM_MIN === "number" ? CAM_MIN : 1,
      typeof CAM_MAX === "number" ? CAM_MAX : 5);
  }
  return true;
}

function cameraZoomBy(factor) {
  if (!camIs3D()) return false;
  const base = CAMCTL.distGoal == null ? VIEW.dist : CAMCTL.distGoal;
  camSetDistance(base / Math.max(0.05, factor));
  camClampDistanceGoal();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
  return true;
}

function cameraPinchZoom(ratio, anchor) {
  if (camIs3D()) {
    if (!ratio || Math.abs(ratio - 1) < 1e-4) return true;
    const base = CAMCTL.distGoal == null ? VIEW.dist : CAMCTL.distGoal;
    camSetDistance(base / ratio);
    camClampDistanceGoal();
    if (typeof sceneInvalidate === "function") sceneInvalidate();
    return true;
  }
  if (typeof ZOOM !== "undefined") {
    if (typeof cancelFlight === "function") cancelFlight();
    ZOOM.anchor = anchor || null;
    ZOOM.goal = clamp(ZOOM.goal * ratio,
      typeof CAM_MIN === "number" ? CAM_MIN : 1,
      typeof CAM_MAX === "number" ? CAM_MAX : 5);
  }
  return true;
}

function camClampDistanceGoal() {
  if (!camIs3D() || CAMCTL.distGoal == null) return;
  const lim = camDistanceLimits();
  if (!lim) return;
  let goal = clamp(CAMCTL.distGoal, lim.min, lim.max);
  if (VIEW.mode === "room" && VIEW.pivot) {
    const room = camRoomInfo();
    if (room) {
      // Evaluate the ceiling at the goal distance as well, so pinch-in
      // cannot push the eye through the suspended ceiling.
      const pl = camPitchLimits(goal);
      const pitch = clamp(VIEW.pitch, pl.min, pl.max);
      goal = Math.min(goal, camRoomMaxDist(room, VIEW.yaw, pitch, VIEW.pivot));
    }
  }
  CAMCTL.distGoal = Math.max(lim.min, goal);
}

/* Critically damped dolly, advanced by building.js animateCameraStep.
   The exact solution of x'' + 2ωx' + ω²(x-goal)=0 reaches the target with
   zero velocity and no overshoot; successive wheel events simply move the
   goal, so the camera accelerates and decelerates continuously. */
function cameraDollyStep(now) {
  if (!camIs3D() || CAMCTL.distGoal == null) {
    CAMCTL.dollyVel = 0;
    return false;
  }
  if (typeof cameraFlightActive === "function" && cameraFlightActive()) {
    CAMCTL.distGoal = null;
    CAMCTL.dollyVel = 0;
    return false;
  }
  camClampDistanceGoal();
  const goal = CAMCTL.distGoal;
  if (goal == null) return false;
  const dt = CAMCTL.lastDollyT
    ? clamp((now - CAMCTL.lastDollyT) / 1000, 0.001, 0.05) : 1 / 60;
  CAMCTL.lastDollyT = now;
  const w = CAM_DOLLY_OMEGA;
  // Scale the top speed with distance so a far overview notch covers many
  // metres without turning into a single-frame jump on a slow GPU.
  const vCap = Math.max(8, Math.abs(goal) * 0.85);
  const d0 = VIEW.dist - goal;
  const v0 = clamp(CAMCTL.dollyVel, -vCap, vCap);
  const e = Math.exp(-w * dt);
  let d = (d0 + (v0 + w * d0) * dt) * e;
  let v = (v0 - w * (v0 + w * d0) * dt) * e;
  v = clamp(v, -vCap, vCap);
  VIEW.dist = goal + d;
  CAMCTL.dollyVel = v;

  const lim = camDistanceLimits();
  if (lim) {
    const before = VIEW.dist;
    VIEW.dist = clamp(VIEW.dist, lim.min, lim.max);
    if (VIEW.dist !== before) CAMCTL.dollyVel = 0;
  }
  const beforeClamp = VIEW.dist;
  if (VIEW.mode === "room" && VIEW.pivot) camClampRoomRig();
  else camClampPitch();
  if (VIEW.dist !== beforeClamp) CAMCTL.dollyVel = 0;

  if (Math.abs(goal - VIEW.dist) < 0.001 && Math.abs(CAMCTL.dollyVel) < 0.01) {
    VIEW.dist = goal;
    CAMCTL.distGoal = null;
    CAMCTL.dollyVel = 0;
    CAMCTL.lastDollyT = 0;
    if (VIEW.mode === "room" && VIEW.pivot) camClampRoomRig();
    else camClampPitch();
  }
  return true;
}

/* Pan bounds for the WebGL camera.  Returns null when the Canvas renderer
   should use its original pan clamp. */
function cameraPanClamp(p) {
  if (!camIs3D()) return null;
  const out = { x: p.x, y: p.y, z: p.z };
  if (VIEW.mode === "room") {
    const room = camRoomInfo();
    if (room) {
      const r = room.rect;
      out.x = clamp(out.x, r.x0 + 0.35, r.x1 - 0.35);
      out.y = clamp(out.y, r.y0 + 0.35, r.y1 - 0.35);
      out.z = clamp(out.z, room.base + 0.4, room.ceiling - 0.4);
    }
    return out;
  }
  if (VIEW.mode === "floor") {
    const spec = camFloorSpec();
    if (spec) {
      const b = spec.floor.bounds;
      out.x = clamp(out.x, b.x0 + 0.6, b.x1 - 0.6);
      out.y = clamp(out.y, b.y0 + 0.6, b.y1 - 0.6);
      out.z = clamp(out.z, spec.floor.base + 0.8,
        spec.floor.base + spec.floor.height - 0.8);
    }
    return out;
  }
  if (VIEW.mode === "building") {
    const P = camPresent();
    const t = P && P.towers[camCurrentBuildingId()];
    if (t) {
      const b = t.floors[0].bounds;
      out.x = clamp(out.x, b.x0 - 10, b.x1 + 10);
      out.y = clamp(out.y, b.y0 - 10, b.y1 + 10);
      out.z = clamp(out.z, 2, t.mast + 8);
    }
    return out;
  }
  if (VIEW.mode === "campus") {
    out.x = clamp(out.x, -45, 70);
    out.y = clamp(out.y, -45, 35);
    out.z = clamp(out.z, 1, 95);
  }
  return out;
}

/* ---------------- lifecycle hooks from building.js ---------------- */

function cameraGestureStart() {
  CAMCTL.distGoal = null;
  CAMCTL.pendingFocus = null;
  CAMCTL.preset = null;
  camUpdateUI();
}

function cameraFlightStarting() {
  camCancelInputMotion();
}

function cameraFlightInterrupted() {
  camCancelInputMotion();
  CAMCTL.pendingFocus = null;
  if (camIs3D() && VIEW.mode === "room") {
    const room = camRoomInfo();
    if (room) {
      const eye = camEye();
      const r = room.rect;
      const inside = eye.x > r.x0 && eye.x < r.x1
        && eye.y > r.y0 && eye.y < r.y1
        && eye.z > room.base && eye.z < room.ceiling;
      if (inside) camEnsureRoomPivot();
    }
  }
  camSyncOrbitTarget();
  camUpdateUI();
}

function cameraTransitionComplete(meta) {
  if (camIs3D()) {
    if (VIEW.mode === "room") camEnsureRoomPivot();
    else { VIEW.pivot = null; CAMCTL.inspectId = null; }
  }
  camSyncOrbitTarget();
  if (CAMCTL.pendingFocus) {
    const id = CAMCTL.pendingFocus;
    CAMCTL.pendingFocus = null;
    camFocusEquipment(id);
  }
  camUpdateUI();
}

/* ---------------- reset / home / focus ---------------- */

function cameraResetExtras() {
  camCancelInputMotion();
  CAMCTL.pendingFocus = null;
  CAMCTL.preset = null;
  CAMCTL.inspectId = null;
  camUpdateUI();
}

function cameraHome() {
  if (typeof cancelFlight === "function") cancelFlight();
  CAMCTL.distGoal = null;
  CAMCTL.pendingFocus = null;
  CAMCTL.preset = null;
  CAMCTL.inspectId = null;
  if (typeof S !== "undefined" && S.view && typeof flyToView === "function") {
    flyToView(S.view);
  } else if (typeof resetCamera === "function") {
    resetCamera();
  }
  camAnnounce("Camera framed on the current view.");
  camUpdateUI();
}

function camFocusEquipment(id) {
  if (!camIs3D() || VIEW.mode !== "room") return false;
  const info = TWIN3D.focusInfo(id);
  if (!info || !info.roomId) return false;
  if (camCurrentRoomId() !== info.roomId) return false;
  const room = TWIN3D.roomInfo(info.roomId);
  if (!room) return false;
  if (!VIEW.pivot) camEnsureRoomPivot();
  const c = room.center;
  const d = info.center;
  const r = room.rect;
  const size = Math.max(info.size.x, info.size.y, info.size.z);
  const wantDist = clamp(1.9 + size * 0.55, 1.9, 2.8);
  // Human-height inspection, not a steep overhead shot of the cabinet.
  const eyeZ = clamp(d.z + 0.2, room.base + 0.9, room.ceiling - 0.4);
  const currentEye = camEye();
  const startAng = Math.atan2(currentEye.x - d.x, -(currentEye.y - d.y));
  let best = null;
  const candidates = [];

  /* The room's authored viewpoint was composed to read its fit-out.  If a
     device is visible from there, approach it along that same direction:
     the inspection keeps the device's front face and the room context
     instead of swinging behind a cabinet. */
  const P = camPresent();
  const authored = P && P.roomView ? P.roomView(info.roomId) : null;
  if (authored && authored.eye) {
    const adx = authored.eye.x - d.x, ady = authored.eye.y - d.y;
    const alen = Math.hypot(adx, ady);
    if (alen > 0.4) {
      const ex = d.x + adx / alen * wantDist;
      const ey = d.y + ady / alen * wantDist;
      if (!(ex < r.x0 + 0.35 || ex > r.x1 - 0.35
          || ey < r.y0 + 0.35 || ey > r.y1 - 0.35)) {
        const eye = { x: ex, y: ey, z: eyeZ };
        const ox = ex - c.x, oy = ey - c.y, oz = eyeZ - c.z;
        const dist = Math.max(0.25, Math.hypot(ox, oy, oz));
        const yaw = Math.atan2(ox, -oy);
        const pitch = Math.asin(Math.max(-1, Math.min(1, oz / dist)));
        const lim = camPitchLimits(dist);
        let visible = true;
        try {
          visible = !TWIN3D.occludedBetween(eye, d, id)
            && !TWIN3D.occludedBetween(d, eye, id);
        } catch (_) { visible = true; }
        if (visible && pitch >= lim.min - 0.001 && pitch <= lim.max + 0.001) {
          best = { score: 200 - camAngDiff(yaw, VIEW.yaw) * 2, yaw, pitch, dist, eye };
          candidates.push({ eye, yaw, pitch, dist, visible, authored: true });
        }
      }
    }
  }

  /* Otherwise sample a ring of eye positions around the equipment, nearest
     to the current yaw first.  A candidate must stay inside the room and
     pass an opaque-geometry line-of-sight test, so wall-mounted or corner
     devices are inspected from the open side rather than through a rack. */
  for (let i = 0; i < 24; i++) {
    const k = (i % 2 === 0) ? i / 2 : -(i + 1) / 2;
    const ang = startAng + k * (Math.PI * 2 / 24);
    const ex = d.x + Math.sin(ang) * wantDist;
    const ey = d.y - Math.cos(ang) * wantDist;
    const inRoom = !(ex < r.x0 + 0.35 || ex > r.x1 - 0.35
        || ey < r.y0 + 0.35 || ey > r.y1 - 0.35);
    if (!inRoom) continue;
    const eye = { x: ex, y: ey, z: eyeZ };
    const ox = ex - c.x, oy = ey - c.y, oz = eyeZ - c.z;
    const dist = Math.max(0.25, Math.hypot(ox, oy, oz));
    const yaw = Math.atan2(ox, -oy);
    const pitch = Math.asin(Math.max(-1, Math.min(1, oz / dist)));
    const lim = camPitchLimits(dist);
    const pitchOk = !(pitch < lim.min - 0.001 || pitch > lim.max + 0.001);
    if (!pitchOk) continue;
    let visible = true;
    try {
      visible = !TWIN3D.occludedBetween(eye, d, id)
        && !TWIN3D.occludedBetween(d, eye, id);
    } catch (_) { visible = true; }
    candidates.push({ eye, yaw, pitch, dist, visible });
    if (!visible) continue;
    // Prefer a natural standing distance from the room pivot and a gentle
    // downward gaze; the shortest rotation is only a tie-breaker.
    const score = 100 - camAngDiff(yaw, VIEW.yaw) * 6
      - Math.max(0, 1.7 - dist) * 45 - Math.abs(pitch - 0.18) * 12;
    if (!best || score > best.score) best = { score, yaw, pitch, dist, eye };
  }

  if (!best) {
    // No unobstructed eye ring (very small or unusually furnished room):
    // keep the previous target-facing fallback, still inside the room.
    let dx = c.x - d.x, dy = c.y - d.y;
    let len = Math.hypot(dx, dy);
    if (len < 0.2) { dx = Math.sin(VIEW.yaw); dy = -Math.cos(VIEW.yaw); len = 1; }
    const yaw = Math.atan2(dx / len, -dy / len);
    const eye = { x: c.x + dx / len * wantDist, y: c.y + dy / len * wantDist, z: eyeZ };
    const ox = eye.x - c.x, oy = eye.y - c.y, oz = eye.z - c.z;
    const dist = Math.hypot(ox, oy, oz);
    best = {
      yaw, dist, eye,
      pitch: Math.asin(Math.max(-1, Math.min(1, oz / dist))),
    };
  }

  CAMCTL.lastFocus = { id, fallback: !best, best, candidates };
  // The eye was chosen in room-centre coordinates; re-express the final
  // pose around the blended inspection pivot so subsequent drags circle the
  // selected equipment rather than the whole room.
  const pivot = camInspectPivot(room, id);
  const eye = best.eye || {
    x: c.x + Math.sin(best.yaw) * best.dist * Math.cos(best.pitch),
    y: c.y - Math.cos(best.yaw) * best.dist * Math.cos(best.pitch),
    z: c.z + best.dist * Math.sin(best.pitch),
  };
  const ox = eye.x - pivot.x, oy = eye.y - pivot.y, oz = eye.z - pivot.z;
  let dist = Math.max(0.3, Math.hypot(ox, oy, oz));
  let yaw = Math.atan2(ox, -oy);
  let pitch = Math.asin(Math.max(-1, Math.min(1, oz / dist)));
  const pl = camPitchLimits(dist, pivot);
  pitch = clamp(pitch, pl.min, pl.max);
  dist = Math.min(dist, camRoomMaxDist(room, yaw, pitch, pivot));
  CAMCTL.inspectId = id;
  startOrbitFlight({
    yaw, pitch, dist,
    target: { x: d.x, y: d.y, z: d.z },
    pivot,
  }, { keepPivot: false, kind: "equipment-focus", dur: 820 });
  camAnnounce("Equipment focus: " + id + ".");
  camUpdateUI();
  return true;
}

function cameraFocusSelected() {
  if (!camIs3D()) return false;
  if (typeof S === "undefined" || !S.selection) return false;
  const thing = (typeof findTwinThing === "function") ? findTwinThing(S.selection.id) : null;
  if (!thing || thing.kind !== "device") return false;
  const ctx = (typeof deviceContext === "function") ? deviceContext(S.selection.id) : null;
  if (!ctx || !ctx.room) return false;
  if (VIEW.mode === "room" && camCurrentRoomId() === ctx.room.id) {
    return camFocusEquipment(S.selection.id);
  }
  CAMCTL.pendingFocus = S.selection.id;
  if (typeof setView === "function") {
    setView("room", {
      buildingId: ctx.building.id,
      floorId: ctx.floor.id,
      roomId: ctx.room.id,
    });
  }
  if (!(typeof cameraFlightActive === "function" && cameraFlightActive())
      && CAMCTL.pendingFocus) {
    const id = CAMCTL.pendingFocus;
    CAMCTL.pendingFocus = null;
    camFocusEquipment(id);
  }
  return true;
}

/* ---------------- view presets ---------------- */

const CAM_PRESET_DEFS = {
  front: { yaw: 0, pitch: 0.22, label: "Front" },
  back: { yaw: Math.PI, pitch: 0.22, label: "Back" },
  left: { yaw: -Math.PI / 2, pitch: 0.22, label: "Left" },
  right: { yaw: Math.PI / 2, pitch: 0.22, label: "Right" },
  top: { yaw: null, pitch: 1.52, label: "Top" },
  iso: { yaw: -Math.PI / 4, pitch: 0.55, label: "Isometric" },
};

function camPresetAllowed(name) {
  if (VIEW.mode === "roof") return false;
  if (name === "top" && (VIEW.mode === "floor" || VIEW.mode === "room")) return false;
  return !!CAM_PRESET_DEFS[name];
}

function cameraApplyPreset(name) {
  if (!camPresetAllowed(name)) return false;
  const def = CAM_PRESET_DEFS[name];
  if (typeof cancelFlight === "function") cancelFlight();
  CAMCTL.distGoal = null;
  CAMCTL.pendingFocus = null;
  if (camIs3D()) {
    if (VIEW.mode === "room") camEnsureRoomPivot();
    const lim = camDistanceLimits();
    let dist = clamp(VIEW.dist, lim.min, lim.max);
    let yaw = def.yaw == null ? VIEW.yaw : def.yaw;
    let pitch = def.pitch;
    if (name === "top" && (VIEW.mode === "campus" || VIEW.mode === "building")) {
      // An overhead view is only legible from enough stand-off; close in,
      // "Top" glides out instead of looking at the underside of a slab.
      const minTop = camCurrentBuildingId() === "b2" ? 60 : 110;
      dist = clamp(Math.max(dist, minTop), lim.min, lim.max);
    }
    if (VIEW.mode === "room" && VIEW.pivot) {
      let pl = camPitchLimits(dist);
      pitch = clamp(pitch, pl.min, pl.max);
      const room = camRoomInfo();
      if (room) {
        dist = Math.min(dist, camRoomMaxDist(room, yaw, pitch, VIEW.pivot));
        pl = camPitchLimits(dist);
        pitch = clamp(pitch, pl.min, pl.max);
      }
    } else {
      // Floor, campus and building all have distance-dependent tilt limits.
      const pl = camPitchLimits(dist);
      pitch = clamp(pitch, pl.min, pl.max);
    }
    startOrbitFlight({
      yaw, pitch, dist,
      target: { x: VIEW.target.x, y: VIEW.target.y, z: VIEW.target.z },
      pivot: VIEW.mode === "room" && VIEW.pivot
        ? { x: VIEW.pivot.x, y: VIEW.pivot.y, z: VIEW.pivot.z } : null,
    }, {
      keepPivot: VIEW.mode === "room" && !!VIEW.pivot,
      kind: "camera-preset",
      dur: 640,
    });
  } else {
    startOrbitFlight({
      yaw: def.yaw == null ? VIEW.yaw : def.yaw,
      pitch: def.pitch,
      dist: VIEW.dist,
      target: { x: VIEW.target.x, y: VIEW.target.y, z: VIEW.target.z },
      pivot: null,
    }, { keepPivot: false, kind: "camera-preset", dur: 640 });
  }
  CAMCTL.preset = name;
  camUpdateUI();
  camAnnounce((def.label || name) + " camera view.");
  return true;
}

/* ---------------- keyboard + UI ---------------- */

function cameraKeyboardOrbit(dx, dy) {
  cameraOrbitBy(dx, dy);
  if (typeof sceneInteract === "function") sceneInteract();
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

function camAnnounce(text) {
  if (typeof kbAnnounce === "function") { kbAnnounce(text); return; }
  const live = document.getElementById("sr-status");
  if (live) live.textContent = text;
}

function camSyncView() {
  CAMCTL.preset = null;
  if (VIEW.mode !== "room") CAMCTL.inspectId = null;
  if (!(typeof cameraFlightActive === "function" && cameraFlightActive())) {
    camSyncOrbitTarget();
  }
  camUpdateUI();
}

function camUpdateUI() {
  const top = document.querySelector('[data-cam-preset="top"]');
  if (top) {
    const allowed = camPresetAllowed("top");
    top.disabled = !allowed;
    top.setAttribute("aria-disabled", allowed ? "false" : "true");
    top.title = allowed ? "Top view" : "Top view is available in campus and building views";
  }
  const focus = document.getElementById("twin-cam-focus");
  if (focus) {
    const has = typeof S !== "undefined" && !!S.selection;
    focus.disabled = !has;
    focus.setAttribute("aria-disabled", has ? "false" : "true");
  }
  document.querySelectorAll("[data-cam-preset]").forEach((btn) => {
    btn.classList.toggle("selected", CAMCTL.preset === btn.dataset.camPreset);
  });
}

function initCameraControls() {
  document.querySelectorAll("[data-cam-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      cameraApplyPreset(btn.dataset.camPreset);
    });
  });
  const home = document.getElementById("twin-cam-home");
  if (home) home.addEventListener("click", cameraHome);
  const focus = document.getElementById("twin-cam-focus");
  if (focus) focus.addEventListener("click", () => {
    if (typeof cameraFocusSelected === "function" && cameraFocusSelected()) return;
    if (typeof focusSelection === "function") focusSelection();
  });

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    const tag = (t && t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea"
        || (t && t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typeof KB !== "undefined" && KB.helpOpen) return;

    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      cameraHome();
      return;
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      if (!cameraZoomBy(1.25) && typeof zoomTwin === "function") { zoomTwin(1.25); sceneInvalidate(); }
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      if (!cameraZoomBy(1 / 1.25) && typeof zoomTwin === "function") { zoomTwin(1 / 1.25); sceneInvalidate(); }
      return;
    }
    if (e.shiftKey && /^Digit[1-6]$/.test(e.code || "")) {
      const names = ["front", "back", "left", "right", "top", "iso"];
      const name = names[Number(e.code.slice(5)) - 1];
      if (cameraApplyPreset(name)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });
  camUpdateUI();
}
