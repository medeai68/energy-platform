/* ============================================================
   TWIN3D — presentation layout (WebGL prototype)
   ------------------------------------------------------------
   The Canvas renderer authors the building in compact, arbitrary
   "BUILD" units so the whole campus fits on one screen.  The WebGL
   prototype instead uses a metre-scale architectural model: real
   façade proportions, realistic storey heights and camera paths.

   IMPORTANT
   ---------
   This is a PRESENTATION scale.  Every room rectangle below is
   derived from the room's real floor area in the system data (the
   sum of the four rooms on a Tower A storey matches the data:
   252 / 204 / 204 m²).  Equipment ids, room ids, energy formulas,
   alarms and simulated measurements are untouched; the renderer
   only changes how large the architecture is drawn.  The running
   application discloses this in the scene.

   No three.js import here — this module is plain data + camera math
   so it can also be unit-checked from Node.
   ============================================================ */

"use strict";

function R(x0, y0, x1, y1) {
  const w = x1 - x0, d = y1 - y0;
  return {
    x0, y0, x1, y1, w, d,
    cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    area: w * d,
  };
}

function room(id, rect, opts) {
  return Object.assign({
    id, rect,
    door: "S",          // interior door wall (N/S/E/W)
    entry: "S",         // exterior façade used by the cinematic entry
    eye: null, target: null,
  }, opts || {});
}

/* ---------------- Tower A ----------------
   Three instrumented floors.  Each logical floor is one 19.2 m
   architectural storey group: a 9.6 m occupied band (fit-out, services,
   the cutaway) capped by a quiet 9.6 m dark-glass band.  That keeps the
   data floors and their 3.5–8.6 m rooms exactly as measured while the
   tower reads as a slender high-rise rather than a three-storey block.
   A single service core sits on the east side of every floor (lift +
   fire stair), so the shaft is continuous through the cutaway.  Rooms
   touch exterior glass wherever the plan allows — that is what makes
   the cutaway worth looking at. */
const B1_FLOORS = [
  {
    id: "b1f1", label: "Floor 1", base: 0, height: 19.2, ceil: 8.8,
    bounds: R(-9.8, -8.2, 9.8, 8.2),
    rooms: [
      /* Lobby 96 m² — 12.0 × 8.0 */
      room("b1f1r1", R(-9.8, -8.2, 2.2, -0.2), {
        door: "N", entry: "S",
        eye: [-4.4, -7.0, 1.70], target: [0.8, -0.8, 2.30],
      }),
      /* Open Office 1 — 84 m² — 12.0 × 7.0 */
      room("b1f1r2", R(-9.8, 0.8, 2.2, 7.8), {
        door: "S", entry: "W",
        eye: [1.4, 1.7, 1.65], target: [-7.2, 7.2, 1.45],
      }),
      /* Meeting Room — 42 m² — 6.0 × 7.0 */
      room("b1f1r3", R(3.8, 0.8, 9.8, 7.8), {
        door: "S", entry: "E",
        eye: [4.5, 1.5, 1.65], target: [9.2, 7.5, 1.55],
      }),
      /* Restrooms — 30 m² — 5.0 × 6.0 */
      room("b1f1r4", R(4.8, -8.2, 9.8, -2.2), {
        door: "N", entry: "S",
        eye: [5.3, -7.6, 1.65], target: [9.0, -3.1, 1.35],
      }),
    ],
  },
  {
    id: "b1f2", label: "Floor 2", base: 19.2, height: 19.2, ceil: 4.8,
    bounds: R(-9.0, -7.6, 9.0, 7.6),
    rooms: [
      /* Open Office 2 — 84 m² — 12.0 × 7.0 */
      room("b1f2r1", R(-9.0, 0.6, 3.0, 7.6), {
        door: "S", entry: "W",
        eye: [2.2, 1.1, 1.65], target: [-8.2, 7.4, 1.45],
      }),
      /* Server Room — 48 m² — 8.0 × 6.0 (featured room) */
      room("b1f2r2", R(-9.0, -7.6, -1.0, -1.6), {
        door: "N", entry: "W",
        eye: [-8.1, -4.35, 1.65], target: [-1.55, -4.25, 1.40],
      }),
      /* Meeting Room — 42 m² — 6.0 × 7.0 */
      room("b1f2r3", R(3.0, 0.6, 9.0, 7.6), {
        door: "S", entry: "E",
        eye: [8.35, 1.35, 1.62], target: [4.4, 4.7, 1.22],
      }),
      /* Pantry — 30 m² — 6.0 × 5.0 */
      room("b1f2r4", R(3.0, -7.6, 9.0, -2.6), {
        door: "N", entry: "S",
        eye: [8.3, -3.3, 1.65], target: [3.5, -6.7, 1.25],
      }),
    ],
  },
  {
    id: "b1f3", label: "Floor 3", base: 38.4, height: 19.2, ceil: 4.8,
    bounds: R(-8.6, -7.2, 8.6, 7.2),
    rooms: [
      /* Executive Suite — 72 m² — 11.2 × 6.43 */
      room("b1f3r1", R(-8.6, 0.7714, 2.6, 7.2), {
        door: "S", entry: "W",
        eye: [1.8, 1.4, 1.65], target: [-7.9, 6.8, 1.45],
      }),
      /* Open Office 3 — 60 m² — 10.0 × 6.0 */
      room("b1f3r2", R(-8.6, -7.2, 1.4, -1.2), {
        door: "N", entry: "W",
        eye: [0.8, -1.7, 1.65], target: [-8.0, -6.6, 1.45],
      }),
      /* Meeting Room — 42 m² — 6.0 × 7.0 */
      room("b1f3r3", R(2.6, 0.2, 8.6, 7.2), {
        door: "S", entry: "E",
        eye: [3.4, 1.0, 1.65], target: [8.1, 6.6, 1.55],
      }),
      /* Restrooms — 30 m² — 6.0 × 5.0 */
      room("b1f3r4", R(2.6, -7.2, 8.6, -2.2), {
        door: "N", entry: "S",
        eye: [7.9, -6.9, 1.65], target: [3.2, -3.0, 1.35],
      }),
    ],
  },
];

/* Service core used by every Tower A storey.  `shaft` is the lift;
   `stair` is the fire stair, visible through the cutaway. */
const B1_CORE = {
  shaft: R(6.6, -1.9, 8.6, 0.1),
  stair: R(3.9, -1.95, 5.7, 0.35),
};

/* ---------------- Annex B ----------------
   Kept deliberately simpler: a low two-storey annex that gives the
   campus composition context.  It keeps every Annex B room, device,
   label and pick target, but the detailed fit-out work is Tower A's. */
const B2_FLOORS = [
  {
    id: "b2f1", label: "Floor 1", base: 0, height: 7.2, ceil: 6.4,
    bounds: R(26, -7, 43, 8),
    rooms: [
      room("b2f1r1", R(26, -7, 34, 0.5), { door: "E", entry: "S",
        eye: [26.9, -6.1, 1.65], target: [33.4, -1.2, 1.55] }),
      room("b2f1r2", R(34, -7, 43, 1), { door: "S", entry: "W",
        eye: [42.1, -6.1, 1.65], target: [35.2, 0.3, 1.45] }),
      room("b2f1r3", R(34, 1, 40, 7), { door: "W", entry: "S",
        eye: [34.7, 2.0, 1.65], target: [39.3, 6.2, 1.45] }),
    ],
  },
  {
    id: "b2f2", label: "Floor 2", base: 7.2, height: 7.2, ceil: 6.4,
    bounds: R(26, -7, 43, 8),
    rooms: [
      room("b2f2r1", R(26, -7, 35, 1), { door: "E", entry: "S",
        eye: [27.0, -6.0, 1.65], target: [34.2, -0.6, 1.55] }),
      room("b2f2r2", R(35, -7, 41, 1), { door: "E", entry: "S",
        eye: [35.9, -6.0, 1.65], target: [40.3, -0.6, 1.55] }),
      room("b2f2r3", R(35, 1, 41, 5), { door: "W", entry: "N",
        eye: [36.0, 4.2, 1.65], target: [40.2, 1.7, 1.45] }),
    ],
  },
];

export const PRESENT = (() => {
  const towers = {
    b1: {
      id: "b1", name: "Tower A", floors: B1_FLOORS, core: B1_CORE,
      roof: 57.6, crown: 69.5, mast: 80.0, defaultCut: "b1f2",
      podium: true,
    },
    b2: {
      id: "b2", name: "Annex B", floors: B2_FLOORS, core: null,
      roof: 14.4, crown: 15.6, mast: 0, defaultCut: "b2f1",
      podium: false,
    },
  };

  const floorById = {};
  const roomById = {};
  for (const t of Object.values(towers)) {
    for (const f of t.floors) {
      floorById[f.id] = Object.assign({ towerId: t.id }, f);
      for (const r of f.rooms) {
        roomById[r.id] = Object.assign({ floorId: f.id, towerId: t.id }, r);
      }
    }
  }

  const CENTER = { x: 0, y: 0 };

  function eyeFromOrbit(o) {
    // `pivot` is optional: WebGL room views orbit the room centre while
    // looking at the selected target. Without it the target is the pivot.
    const t = o.pivot || o.target;
    const cosP = Math.cos(o.pitch), sinP = Math.sin(o.pitch);
    return {
      x: t.x + Math.sin(o.yaw) * o.dist * cosP,
      y: t.y - Math.cos(o.yaw) * o.dist * cosP,
      z: t.z + o.dist * sinP,
    };
  }

  function orbitFromEyeTarget(eye, target) {
    const dx = eye.x - target.x;
    const dy = eye.y - target.y;
    const dz = eye.z - target.z;
    const dist = Math.max(0.05, Math.hypot(dx, dy, dz));
    return {
      yaw: Math.atan2(dx, -dy),
      pitch: Math.asin(Math.max(-1, Math.min(1, dz / dist))),
      dist,
      target: { x: target.x, y: target.y, z: target.z },
    };
  }

  function floorOf(id) { return floorById[id] || null; }
  function roomOf(id) { return roomById[id] || null; }

  function roomView(roomId) {
    const r = roomById[roomId];
    if (!r) return null;
    const f = floorById[r.floorId];
    const eye = { x: r.eye[0], y: r.eye[1], z: f.base + r.eye[2] };
    const target = { x: r.target[0], y: r.target[1], z: f.base + r.target[2] };
    // a normal indoor lens; wide enough to read the room, tight enough
    // that the far wall does not balloon into a fisheye
    return Object.assign(orbitFromEyeTarget(eye, target), { fov: 50 });
  }

  /* Room camera positions are authored in metres relative to the
     storey base, so an exploded floor simply adds its lift. */
  function floorView(floorId, explodeT) {
    const f = floorById[floorId];
    if (!f) return null;
    const t = towers[f.towerId];
    const lift = t.id === "b1"
      ? (f.base / 19.2) * 3.1 * (explodeT || 0) : 0;
    const b = f.bounds;
    const target = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: f.base + 1.7 + lift };
    /* The eye sits inside the opened 9.6 m band, below the divider slab,
       well outside the facade, looking down into the section at ~17°.
       Only the near glass and its frame fade, so the far facade stays as
       a real backdrop instead of a lattice across the foreground. */
    const horiz = 21.5;
    const dz = t.id === "b1" ? 6.6 : Math.min(7.4, f.height * 0.72);
    const yaw = -0.68;
    const dist = Math.hypot(horiz, dz);
    const pitch = Math.asin(dz / dist);
    return {
      yaw, pitch, dist, target, fov: t.id === "b1" ? 44 : 42,
      eye: {
        x: target.x + Math.sin(yaw) * horiz,
        y: target.y - Math.cos(yaw) * horiz,
        z: target.z + dz,
      },
    };
  }

  function buildingView(buildingId, floorId, explodeT) {
    const t = towers[buildingId];
    if (!t) return null;
    const e = explodeT || 0;
    if (t.id === "b1") {
      const f = floorId ? floorById[floorId] : null;
      const gap = 3.1;
      const lift = f ? (f.base / 19.2) * gap * e : (t.floors.length * gap * e) * 0.45;
      /* Full-tower establishing view: the whole 70 m silhouette, crown
         and plaza included, with the selected storey cut open in
         context.  The same framing serves every floor, so reverse
         navigation always reveals the complete tower. */
      const tz = 30.5 + lift;
      const eyeZ = tz + 14.0;
      const horiz = 118.0;
      const dz = eyeZ - tz;
      const dist = Math.hypot(horiz, dz);
      const yaw = -0.64;
      const target = { x: 0, y: 0, z: tz };
      return {
        yaw, pitch: Math.asin(dz / dist), dist, target, fov: 47,
        eye: {
          x: target.x + Math.sin(yaw) * horiz,
          y: target.y - Math.cos(yaw) * horiz,
          z: eyeZ,
        },
      };
    }
    /* Annex B: a slightly higher, quieter establishing view. */
    const horiz = 27.0, dz = 7.0;
    const dist = Math.hypot(horiz, dz);
    const yaw = -0.72;
    const target = { x: 34.5, y: 0.5, z: 7.0 };
    return {
      yaw, pitch: Math.asin(dz / dist), dist, target, fov: 42,
      eye: {
        x: target.x + Math.sin(yaw) * horiz,
        y: target.y - Math.cos(yaw) * horiz,
        z: target.z + dz,
      },
    };
  }

  function campusView() {
    const target = { x: 6.5, y: 0.5, z: 30.0 };
    const horiz = 145.0, dz = 16.0;
    const dist = Math.hypot(horiz, dz);
    const yaw = -0.70;
    return {
      yaw, pitch: Math.asin(dz / dist), dist, target, fov: 44,
      eye: {
        x: target.x + Math.sin(yaw) * horiz,
        y: target.y - Math.cos(yaw) * horiz,
        z: target.z + dz,
      },
    };
  }

  function viewFor(mode, o) {
    const opts = o || {};
    if (mode === "campus") return campusView();
    if (mode === "building") return buildingView(opts.buildingId || "b1",
      opts.floorId || null, opts.explode || 0);
    if (mode === "floor") return floorView(opts.floorId, opts.explode || 0);
    if (mode === "room") return roomView(opts.roomId);
    return null;
  }

  /* ---------------- cinematic room journeys ----------------
     The camera always enters through an exterior façade (never through
     an interior partition) and eases out the same way.  Far-away rooms
     are reached with an arc around the tower, so the path never cuts
     through the mass. */

  const NORMALS = {
    S: { x: 0, y: -1, tx: 1, ty: 0 },
    N: { x: 0, y: 1, tx: 1, ty: 0 },
    W: { x: -1, y: 0, tx: 0, ty: 1 },
    E: { x: 1, y: 0, tx: 0, ty: 1 },
  };

  function facadePoint(r, side) {
    if (side === "S") return { x: r.rect.cx, y: r.rect.y0 };
    if (side === "N") return { x: r.rect.cx, y: r.rect.y1 };
    if (side === "W") return { x: r.rect.x0, y: r.rect.cy };
    return { x: r.rect.x1, y: r.rect.cy };
  }

  function roomExitPoints(roomId) {
    const r = roomById[roomId];
    if (!r) return [];
    const f = floorById[r.floorId];
    const side = r.entry;
    const n = NORMALS[side];
    const fp = facadePoint(r, side);
    const near = {
      x: fp.x + n.x * 2.3, y: fp.y + n.y * 2.3, z: f.base + 2.25,
      target: { x: r.rect.cx, y: r.rect.cy, z: f.base + 1.7 },
    };
    const far = {
      x: fp.x + n.x * 12.0 + n.tx * 0.8,
      y: fp.y + n.y * 12.0 + n.ty * 0.8,
      z: f.base + 6.4,
      target: { x: r.rect.cx, y: r.rect.cy, z: f.base + 2.6 },
    };
    return { near, far };
  }

  function insideTower(p, t, pad) {
    const b = t.floors[0].bounds;
    const m = pad == null ? 2.0 : pad;
    return p.x > b.x0 - m && p.x < b.x1 + m
      && p.y > b.y0 - m && p.y < b.y1 + m
      && p.z < t.mast + 2;
  }

  function blocked(a, b, t) {
    if (!t) return false;
    const steps = 10;
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      const p = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
      if (insideTower(p, t, 1.2)) return true;
    }
    return false;
  }

  /* Arc points around the tower, used only when a straight hop would
     cross the mass.  Radius is capped so long campus hops still move
     decisively toward the destination. */
  function arcBetween(from, to, t, targetZ) {
    if (!t || !blocked(from, to, t)) return [];
    const b = t.floors[0].bounds;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    let a0 = Math.atan2(from.y - cy, from.x - cx);
    let a1 = Math.atan2(to.y - cy, to.x - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const r0 = Math.hypot(from.x - cx, from.y - cy);
    const r1 = Math.hypot(to.x - cx, to.y - cy);
    const R = Math.max(24, Math.min(40, Math.max(r0, r1) + 2));
    const steps = Math.max(2, Math.ceil(Math.abs(da) / 0.55));
    const out = [];
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      const a = a0 + da * k;
      out.push({
        x: cx + Math.cos(a) * R,
        y: cy + Math.sin(a) * R,
        z: from.z + (to.z - from.z) * k,
        target: { x: cx, y: cy, z: targetZ },
      });
    }
    return out;
  }

  function enterPath(roomId, fromEye, fromTarget, prevRoomId) {
    const r = roomById[roomId];
    if (!r) return [];
    const f = floorById[r.floorId];
    const t = towers[r.towerId];
    const final = roomView(roomId);
    const finalEye = eyeFromOrbit(final);
    const finalTarget = { ...final.target };
    const ex = roomExitPoints(roomId);
    const pts = [];
    let start = fromEye;

    if (prevRoomId) {
      const prev = roomExitPoints(prevRoomId);
      pts.push(prev.near);
      pts.push(prev.far);
      start = prev.far;
    }

    const arc = arcBetween(start, ex.far, t, f.base + 3.0);
    for (const p of arc) pts.push(p);
    pts.push(ex.far);
    pts.push(ex.near);

    /* The final settle: from just outside the glass to the authored
       inside viewpoint.  It is one move so it never feels like a
       teleport through the window. */
    pts.push({
      x: finalEye.x, y: finalEye.y, z: finalEye.z,
      target: finalTarget,
    });
    return pts;
  }

  function exitPath(roomId) {
    const r = roomById[roomId];
    if (!r) return [];
    const ex = roomExitPoints(roomId);
    return [ex.near, ex.far];
  }

  function frameDestination(fromEye, mode, o) {
    const v = viewFor(mode, o);
    if (!v) return { eye: fromEye, target: { x: 0, y: 0, z: 10 } };
    return { eye: eyeFromOrbit(v), target: { ...v.target }, view: v };
  }

  /* Build the full eye-key polyline for a transition.  `from` is the
     current camera state; the returned array ends at the destination. */
  function journey(fromEye, fromTarget, mode, o) {
    const opts = o || {};
    const dest = frameDestination(fromEye, mode, opts);
    const t = opts.buildingId ? towers[opts.buildingId] : null;
    const floor = opts.floorId ? floorById[opts.floorId] : null;
    const targetZ = floor ? floor.base + 3.0 : 12.0;
    const pts = [];

    if (opts.prevRoomId) {
      for (const p of exitPath(opts.prevRoomId)) pts.push(p);
    }

    if (mode === "room" && opts.roomId) {
      /* enterPath handles the previous-room exit prefix itself. */
      return enterPath(opts.roomId, fromEye, fromTarget, opts.prevRoomId);
    }

    let last = fromEye;
    if (pts.length) last = pts[pts.length - 1];
    for (const p of arcBetween(last, dest.eye, t, targetZ)) pts.push(p);
    pts.push({ x: dest.eye.x, y: dest.eye.y, z: dest.eye.z, target: dest.target });
    return pts;
  }

  return {
    towers, floors: floorById, rooms: roomById, CENTER,
    scaleNote: "Presentation scale — architectural model with storey heights raised for legibility. Room areas, equipment IDs and simulated readings are unchanged system data.",
    eyeFromOrbit, orbitFromEyeTarget, viewFor, roomView,
    floorView, buildingView, campusView,
    floorOf, roomOf,
    enterPath, exitPath, journey,
    floorLift(floorId, t) {
      const f = floorById[floorId];
      if (!f) return 0;
      const tw = towers[f.towerId];
      if (tw.id !== "b1") return 0;
      return (f.base / 19.2) * 3.1 * (t || 0);
    },
    roofLift(towerId, t) {
      const tw = towers[towerId];
      if (!tw || tw.id !== "b1") return 0;
      return tw.floors.length * 3.1 * (t || 0);
    },
    cutFloorFor(view, mode) {
      if (!view || !view.buildingId) return null;
      if (mode !== "building" && mode !== "floor" && mode !== "room") return null;
      const tw = towers[view.buildingId];
      if (!tw) return null;
      return view.floorId || tw.defaultCut;
    },
    towerBounds(towerId) {
      const tw = towers[towerId];
      if (!tw) return null;
      return Object.assign({ ground: 0, roof: tw.roof }, tw.floors[0].bounds);
    },
  };
})();

/* The renderer publishes this only while WebGL is alive.  building.js
   keeps its original Canvas camera presets when it is absent. */
export default PRESENT;
