/* ============================================================
   TWIN3D ARCHITECTURE — presentation-scale digital twin world
   ------------------------------------------------------------
   Builds the premium architectural model used by the opt-in WebGL
   renderer (?render=gl).  Coordinates are the documented presentation
   metres from twin3d-presentation.js (Z-up).  Room areas, device ids
   and every simulated reading stay connected to the data model; the
   scale is presentation-only and is disclosed in the UI.

   Contracts consumed by twin3d.js:
     world = { env, root, site, materials,
               towers, rooms, devices, labels, picks, cutaway,
               setExplode(t) }
   Each tower = { id, name, group, roofGroup, floors, roofZ, crownZ,
                  mastZ, roofLift }
   Each floor = { id, group, slab, base, height, bounds, glassMats,
                  ceilingGroup, roomCeilings, servicesGroup, lift }
   ============================================================ */

"use strict";

import * as THREE from "./vendor/three.module.js";
import { PRESENT } from "./twin3d-presentation.js";
import {
  Batcher, box, plane, cylinder, pipe, tagPick, addDevice,
  registerStatusMat,
} from "./twin3d-kit.js";
import { furnishRoom, buildFloorServices } from "./twin3d-interiors.js";

const PI = Math.PI;
const TAU = PI * 2;

/* ---------------- small helpers ---------------- */

function group(parent, name) {
  const g = new THREE.Group();
  if (name) g.name = name;
  if (parent) parent.add(g);
  return g;
}

function lp(cx, cy, ry, lx, ly) {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [cx + lx * c - ly * s, cy + lx * s + ly * c];
}

function roomMeta(env) {
  const map = new Map();
  const BUILD = (env && env.BUILD) || {};
  for (const b of Object.values(BUILD)) {
    if (!b || !b.floors) continue;
    for (const f of b.floors) {
      for (const r of f.rooms || []) {
        map.set(r.id, { name: r.name, usage: r.usage, floorId: f.id, buildingId: b.id });
      }
    }
  }
  return map;
}

function twoSegments(a, b, c, gap) {
  return [[a, c - gap / 2], [c + gap / 2, b]];
}

function expandBounds(b, e) {
  const x0 = b.x0 - (e.w || 0), y0 = b.y0 - (e.s || 0);
  const x1 = b.x1 + (e.e || 0), y1 = b.y1 + (e.n || 0);
  const w = x1 - x0, d = y1 - y0;
  return { x0, y0, x1, y1, w, d, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, area: w * d };
}

/* Deep cantilevered terrace plates are what turn the old stacked-box
   silhouette into a designed high-rise.  Each plate projects past the
   storey below by roughly a storey's worth of shadow, then steps back
   for the volume above, so the skyline reads wide-narrow-wide-narrow
   rather than as one continuous extrusion.  Room rectangles, floor
   areas and cutaway positions never change — only the slab rim grows. */
const B1_TERRACE = {
  1: { w: 1.05, s: 1.20, e: 0.85, n: 0.85 },
  2: { w: 1.20, s: 1.35, e: 1.00, n: 1.00 },
};

/* ============================================================
   ENTRY
   ============================================================ */

export function buildWorld(env, M) {
  const world = {
    env,
    root: new THREE.Group(),
    materials: M,
    towers: {},
    rooms: new Map(),
    devices: new Map(),
    labels: { buildings: [], floors: [], rooms: [], devices: [] },
    picks: { devices: [], rooms: [], roofs: [], floors: [], buildings: [] },
    cutaway: { buildingId: "b1", floorId: "b1f2" },
    explode: 0,
  };
  world.root.name = "twin3d-world";

  buildSite(world, env, M);
  buildTowerA(world, env, M);
  buildAnnexB(world, env, M);
  buildSkyline(world, M);

  // remember authored positions so the exploded view can lift everything
  for (const dev of world.devices.values()) dev.baseAnchor = dev.anchor.clone();
  for (const list of [world.labels.rooms, world.labels.floors, world.labels.devices]) {
    for (const lab of list) lab.basePos = lab.pos.clone();
  }
  for (const lab of world.labels.buildings) lab.basePos = lab.pos.clone();

  world.setExplode = (t) => {
    const k = Math.max(0, Math.min(1, t || 0));
    world.explode = k;
    for (const twId of Object.keys(world.towers)) {
      const tw = world.towers[twId];
      for (const f of tw.floors) {
        const lift = PRESENT.floorLift(f.id, k);
        f.lift = lift;
        f.group.position.z = lift;
      }
      tw.roofLift = PRESENT.roofLift(twId, k);
      tw.roofGroup.position.z = tw.roofLift;
    }
    for (const lab of world.labels.rooms) {
      lab.pos.z = lab.basePos.z + PRESENT.floorLift(lab.floorId, k);
    }
    for (const lab of world.labels.floors) {
      lab.pos.z = lab.basePos.z + PRESENT.floorLift(lab.floorId, k);
    }
    for (const lab of world.labels.devices) {
      const dev = world.devices.get(lab.id);
      lab.pos.z = lab.basePos.z + PRESENT.floorLift(dev && dev.floorId, k);
    }
    for (const dev of world.devices.values()) {
      dev.anchor.copy(dev.baseAnchor);
      dev.anchor.z += PRESENT.floorLift(dev.floorId, k);
    }
    for (const lab of world.labels.buildings) {
      lab.pos.z = lab.basePos.z + PRESENT.roofLift(lab.towerId, k);
    }
  };
  world.setExplode(0);
  return world;
}

/* ============================================================
   SITE — plaza, landscaping, parking, EV, distant city
   ============================================================ */

const TREES = [
  [-19.2, -22.4, 1.05], [-17.0, -25.2, 0.85], [-14.2, -11.4, 0.9],
  [-19.4, -5.4, 1.0], [-19.0, 3.0, 0.9], [-17.6, 11.8, 1.05],
  [11.8, -23.2, 1.0], [17.8, -22.0, 0.85], [18.4, -11.0, 1.1],
  [17.2, -5.6, 0.95], [14.0, 1.2, 0.9], [17.8, 8.0, 1.05],
  [5.4, -26.4, 0.95], [-2.0, -26.8, 0.85], [23.4, -11.6, 0.9],
  [25.4, -13.6, 0.8], [24.2, 10.6, 1.0], [30.0, -11.0, 0.95],
  [38.4, -11.4, 1.0], [46.2, -9.4, 0.9], [47.0, 4.4, 1.05],
  [45.0, 10.0, 0.9], [-29.4, -30.6, 1.0], [-12.0, -36.8, 0.95],
  [6.0, -36.4, 1.05], [24.0, -36.8, 0.95], [42.0, -35.8, 1.0],
  [55.0, -8.0, 1.0], [54.0, 12.0, 0.95],
];

function buildSite(world, env, M) {
  const g = group(world.root, "site");
  world.site = g;
  const b = new Batcher();

  const ground = plane(M.grass, 700, 700, 6, 0, -0.5);
  ground.receiveShadow = true;
  g.add(ground);

  /* access road + drive */
  b.box(M.asphalt, 6, -31, -0.5, 130, 8, 0.12);
  b.box(M.asphalt, -27.2, -21.5, -0.5, 7.6, 15.5, 0.12);
  for (let x = -46; x <= 60; x += 2.6) {
    if (Math.abs(x + 27) < 6) continue;
    b.box(M.stoneLight, x, -31, -0.435, 1.3, 0.12, 0.02, { cast: false });
  }

  /* entrance plaza */
  b.box(M.paving, -1, -16.2, -0.32, 40, 16.6, 0.36);
  b.box(M.stoneLight, -3.8, -17.0, -0.305, 2.9, 17.8, 0.03, { cast: false });
  b.box(M.stone, -1, -24.55, -0.2, 40.6, 0.5, 0.34);

  /* annex forecourt + path */
  b.box(M.paving, 33.0, -10.0, -0.32, 22.0, 6.6, 0.36);
  b.box(M.stoneLight, 22.2, -8.3, -0.305, 7.0, 2.4, 0.03, { cast: false });

  /* parking edging */
  b.box(M.stoneLight, -22.9, -21.5, -0.44, 0.3, 15.4, 0.16);
  b.box(M.stoneLight, -27.2, -13.5, -0.44, 7.4, 0.22, 0.14, { cast: false });
  b.box(M.stoneLight, -27.2, -16.2, -0.44, 7.4, 0.22, 0.14, { cast: false });
  b.box(M.stoneLight, -27.2, -19.0, -0.44, 7.4, 0.22, 0.14, { cast: false });
  b.box(M.stoneLight, -27.2, -21.8, -0.44, 7.4, 0.22, 0.14, { cast: false });
  b.box(M.stoneLight, -27.2, -24.6, -0.44, 7.4, 0.22, 0.14, { cast: false });

  /* entrance steps (plaza -0.14 -> floor 0), widened to the canopy */
  b.box(M.stoneLight, -3.8, -8.75, -0.1, 10.4, 1.5, 0.16);
  b.box(M.stoneLight, -3.8, -9.55, -0.22, 11.2, 1.2, 0.14);
  b.box(M.bronzeLight, -3.8, -9.49, -0.015, 10.4, 0.06, 0.03, { cast: false });
  b.box(M.bronzeLight, -3.8, -10.13, -0.145, 11.2, 0.06, 0.03, { cast: false });

  /* reflecting pool */
  const wx0 = 9.2, wx1 = 17.4, wy0 = -21.2, wy1 = -14.0;
  b.box(M.stone, (wx0 + wx1) / 2, wy0, -0.3, wx1 - wx0 + 0.7, 0.34, 0.5);
  b.box(M.stone, (wx0 + wx1) / 2, wy1, -0.3, wx1 - wx0 + 0.7, 0.34, 0.5);
  b.box(M.stone, wx0, (wy0 + wy1) / 2, -0.3, 0.34, wy1 - wy0, 0.5);
  b.box(M.stone, wx1, (wy0 + wy1) / 2, -0.3, 0.34, wy1 - wy0, 0.5);
  const water = new THREE.MeshPhysicalMaterial({
    color: 0x1c2b31, roughness: 0.045, metalness: 0.18,
    transparent: true, opacity: 0.94, envMapIntensity: 2.4,
  });
  const waterMesh = plane(water, wx1 - wx0 - 0.12, wy1 - wy0 - 0.12,
    (wx0 + wx1) / 2, (wy0 + wy1) / 2, -0.055);
  waterMesh.receiveShadow = true;
  g.add(waterMesh);

  /* hedges */
  const hedges = [
    [-19.6, -16.4, 0.9, 15.0],
    [-9.2, -18.6, 2.6, 8.8],
    [1.4, -18.6, 2.6, 8.8],
    [-1.0, -25.9, 10.2, 0.9],
    [8.2, -25.9, 8.4, 0.9],
    [22.0, -13.2, 6.4, 0.9],
    [44.6, -13.2, 6.4, 0.9],
    [25.0, 8.8, 16.0, 0.8],
  ];
  for (const [x, y, w, d] of hedges) {
    b.box(M.hedge, x, y, 0.34, w, d, 0.72, { cast: true });
    b.box(M.soil, x, y, 0.06, w + 0.2, d + 0.2, 0.16, { cast: false });
  }

  /* trees */
  for (const [x, y, s] of TREES) {
    b.cyl(M.trunk, x, y, 1.15 * s, 0.13 * s, 2.3 * s);
    b.sphere(M.leaf, x, y, 3.15 * s, 1.35 * s);
    b.sphere(M.leafDark, x - 0.65 * s, y + 0.35 * s, 2.75 * s, 0.95 * s);
    b.sphere(M.leafLight, x + 0.6 * s, y - 0.3 * s, 3.0 * s, 0.85 * s);
    b.sphere(M.leaf, x + 0.1 * s, y + 0.55 * s, 3.6 * s, 0.75 * s);
  }

  /* benches facing the walkway */
  const bench = (x, y, ry) => {
    for (let i = 0; i < 4; i++) {
      const [lx, ly] = lp(x, y, ry, 0, -0.24 + i * 0.16);
      b.box(M.wood, lx, ly, 0.48, 1.9, 0.12, 0.07, { rz: ry });
    }
    const [lx1, ly1] = lp(x, y, ry, -0.75, 0);
    const [lx2, ly2] = lp(x, y, ry, 0.75, 0);
    b.box(M.darkMetal, lx1, ly1, 0.24, 0.1, 0.5, 0.48, { rz: ry });
    b.box(M.darkMetal, lx2, ly2, 0.24, 0.1, 0.5, 0.48, { rz: ry });
  };
  bench(-6.6, -14.4, 0);
  bench(2.4, -20.8, PI);
  bench(15.4, -12.4, PI / 2);

  /* planter drums */
  for (const [x, y, r] of [[-11.6, -11.6, 1.0], [-11.6, -21.0, 0.9],
    [4.2, -22.6, 0.95], [19.4, -18.6, 0.85], [30.4, -12.0, 0.8]]) {
    b.cyl(M.stone, x, y, 0.34, r, 0.68);
    b.cyl(M.soil, x, y, 0.66, r - 0.08, 0.06, { cast: false });
    b.sphere(M.leafDark, x, y, 1.15, r * 0.72);
    b.sphere(M.leaf, x + r * 0.4, y - r * 0.25, 1.0, r * 0.5);
  }

  /* bollards along the plaza south edge */
  for (let x = -8.2; x <= 5.0; x += 1.85) {
    b.cyl(M.metal, x, -25.4, 0.46, 0.065, 0.92);
    b.cyl(M.glowSoft, x, -25.4, 0.94, 0.05, 0.05, { cast: false });
  }

  /* light poles */
  const lampPosts = [[-9.4, -23.6], [4.2, -23.6], [-9.4, -11.8],
    [4.2, -11.8], [-18.2, -17.2], [19.8, -23.0], [26.4, -11.0], [41.8, -11.0]];
  for (const [x, y] of lampPosts) {
    b.cyl(M.darkMetal, x, y, 2.55, 0.06, 5.1);
    b.cyl(M.darkMetal, x, y, 0.12, 0.16, 0.24);
    b.box(M.darkMetal, x, y, 5.08, 0.34, 0.9, 0.08);
    b.box(M.glowSoft, x, y - 0.28, 5.0, 0.5, 0.26, 0.05, { cast: false });
  }

  /* low entrance monument with a warm sign line */
  b.box(M.stone, -11.6, -9.9, 0.55, 2.3, 0.7, 1.1);
  b.box(M.glowWarm, -11.6, -10.27, 0.78, 1.55, 0.03, 0.16, { cast: false });

  /* parked cars (visual only) */
  const car = (x, y, ry, bodyMat) => {
    b.box(bodyMat, ...(() => { const [cx, cy] = lp(x, y, ry, 0, 0); return [cx, cy]; })(),
      0.68, 1.78, 4.5, 0.62, { rz: ry });
    const [ccx, ccy] = lp(x, y, ry, 0, 0.15);
    b.box(M.carGlass, ccx, ccy, 1.26, 1.55, 2.3, 0.52, { rz: ry });
    const [rfx, rfy] = lp(x, y, ry, 0, 0.15);
    b.box(bodyMat, rfx, rfy, 1.55, 1.45, 2.1, 0.09, { rz: ry });
    for (const [lx, ly] of [[-0.82, -1.42], [0.82, -1.42], [-0.82, 1.42], [0.82, 1.42]]) {
      const [wx, wy] = lp(x, y, ry, lx, ly);
      b.cyl(M.tire, wx, wy, 0.35, 0.35, 0.24, { rx: 0, rz: PI / 2 + ry });
    }
  };
  car(-27.0, -25.2, PI / 2, M.carBody);
  car(-27.0, -19.8, PI / 2, M.steel);
  car(-27.0, -17.0, PI / 2, M.carBody);

  b.flush(g);

  /* EV bay + charger (existing device id ev-b1) */
  buildEvBay(world, M, g);

  /* EV car, visual only, next to the charger */
  const eb = new Batcher();
  carVisual(eb, M, -26.4, -13.5, PI / 2);
  eb.flush(g);
}

function carVisual(b, M, x, y, ry) {
  const [cx, cy] = lp(x, y, ry, 0, 0);
  b.box(M.carBody, cx, cy, 0.68, 1.78, 4.5, 0.62, { rz: ry });
  const [ccx, ccy] = lp(x, y, ry, 0, 0.15);
  b.box(M.carGlass, ccx, ccy, 1.26, 1.55, 2.3, 0.52, { rz: ry });
  for (const [lx, ly] of [[-0.82, -1.42], [0.82, -1.42], [-0.82, 1.42], [0.82, 1.42]]) {
    const [wx, wy] = lp(x, y, ry, lx, ly);
    b.cyl(M.tire, wx, wy, 0.35, 0.35, 0.24, { rx: 0, rz: PI / 2 + ry });
  }
}

function buildEvBay(world, M, parent) {
  const g = group(parent, "ev-bay");
  const x = -23.2, y = -13.5;
  const pad = box(M.asphalt, 4.6, 3.4, 0.06, x - 1.0, y, -0.41, { cast: false });
  g.add(pad);
  for (const [w, d, px, py] of [[4.2, 0.06, x - 1.0, y - 1.55],
    [4.2, 0.06, x - 1.0, y + 1.55]]) {
    g.add(box(M.stoneLight, w, d, 0.02, px, py, -0.37, { cast: false }));
  }
  const body = box(M.metal, 0.4, 0.3, 1.45, x, y, 0.725);
  g.add(body);
  const head = box(M.darkMetal, 0.44, 0.34, 0.42, x, y, 1.56);
  g.add(head);
  const screen = box(M.screen, 0.025, 0.24, 0.2, x - 0.22, y, 1.48, { cast: false });
  g.add(screen);
  const ledMat = M.glowCool.clone();
  const led = box(ledMat, 0.05, 0.02, 0.04, x - 0.21, y, 1.72, { cast: false, receive: false });
  g.add(led);
  const cable = pipe(M.darkMetal, x - 0.18, y, 1.2, x - 0.18, y - 0.9, 0.32, 0.025, 8);
  if (cable) g.add(cable);

  const dev = addDevice(world, "ev-b1", g,
    new THREE.Vector3(x, y, 1.95), null, null, "EV CHARGER");
  registerStatusMat(dev, ledMat);
  tagPick(world, body, "devices", "ev-b1", "device", ["campus", "building"], {});
  tagPick(world, head, "devices", "ev-b1", "device", ["campus", "building"], {});
}

/* Distant skyline, pushed well back so it frames the campus instead of
   crowding it.  Windows are a sparse grid of dim, fogged panels; the old
   full-width emissive bands read as gold stripes floating in the sky. */
const CITY = [
  [-96, -66, 20, 12, 24], [-70, -90, 26, 16, 34], [-42, -108, 18, 14, 42],
  [-9, -120, 22, 18, 29], [24, -111, 20, 12, 47], [57, -99, 24, 16, 26],
  [87, -78, 18, 14, 36], [111, -45, 26, 18, 20], [-114, -27, 18, 14, 19],
  [120, 6, 22, 16, 32], [-123, 15, 24, 18, 26], [-99, 51, 18, 14, 20],
  [93, 66, 24, 16, 40], [57, 90, 20, 14, 24], [9, 102, 26, 18, 30],
  [-39, 96, 18, 12, 20],
];

function buildSkyline(world, M) {
  const g = group(world.root, "skyline");
  world.skyline = g;
  const b = new Batcher();
  /* The campus camera now stands ~145 m out, so the old ring would have
     sat in front of it.  Push the whole skyline back and grow it a
     little so it still reads as a city beyond the site. */
  for (const [px, py, pw, pd, ph] of CITY) {
    const x = px * 1.7, y = py * 1.7, w = pw * 1.18, d = pd * 1.18, h = ph * 1.08;
    b.box(M.cityWall, x, y, h / 2 - 0.5, w, d, h, { cast: false, receive: false });
    b.box(M.mullion, x, y, h + 0.22, w + 0.3, d + 0.3, 0.44, { cast: false, receive: false });
    const rows = Math.max(3, Math.min(7, Math.round(h / 6.5)));
    const cols = Math.max(4, Math.min(8, Math.round(w / 3.0)));
    const ww = Math.min(1.15, ((w - 1.6) / cols) * 0.62);
    const wh = Math.min(0.62, ((h - 3.2) / rows) * 0.5);
    for (let r = 0; r < rows; r++) {
      const z = 2.0 + (h - 3.2) * ((r + 0.5) / rows);
      for (let c = 0; c < cols; c++) {
        const wx = x - w / 2 + (w / cols) * (c + 0.5);
        const warm = (r * 7 + c * 3 + Math.round(x)) % 5 < 3;
        if ((r * 11 + c * 5 + Math.round(y)) % 9 >= 4) continue;
        const win = warm ? M.cityWarm : M.cityCool;
        b.box(win, wx, y - d / 2 - 0.03, z, ww, 0.02, wh, { cast: false, receive: false });
        if ((r + c) % 3 === 0) {
          b.box(win, wx, y + d / 2 + 0.03, z, ww, 0.02, wh, { cast: false, receive: false });
        }
      }
    }
    if (h > 32) {
      b.box(M.darkMetal, x + w * 0.18, y + d * 0.1, h + 1.4, 0.22, 0.22, 2.8,
        { cast: false, receive: false });
      b.box(M.cityWall, x - w * 0.18, y, h + 0.75, w * 0.26, d * 0.36, 1.5,
        { cast: false, receive: false });
    }
  }
  b.flush(g, { cast: false });
}

/* ============================================================
   TOWER A
   ============================================================ */

function buildTowerA(world, env, M) {
  const data = PRESENT.towers.b1;
  const meta = roomMeta(env);
  const g = group(world.root, "tower-b1");
  const roofGroup = group(g, "roof-b1");
  const tower = {
    id: "b1", name: data.name, group: g, roofGroup,
    floors: [], roofZ: data.roof, crownZ: data.crown, mastZ: data.mast,
    roofLift: 0,
  };
  world.towers.b1 = tower;

  let prevBounds = null;
  for (let i = 0; i < data.floors.length; i++) {
    const fd = data.floors[i];
    const f = buildStorey(world, env, M, tower, fd, i, prevBounds, meta, {
      podium: i === 0, detailed: true, buildingId: "b1",
    });
    tower.floors.push(f);
    prevBounds = fd.bounds;
  }
  buildRoofTowerA(world, M, tower, data);

  // campus building pick: the whole mass, including the crown
  const pb = data.floors[0].bounds;
  const pick = box(M.darkMetal, pb.w + 0.4, pb.d + 0.4, data.mast,
    pb.cx, pb.cy, data.mast / 2, { cast: false, receive: false });
  pick.visible = false;
  g.add(pick);
  tagPick(world, pick, "buildings", "b1", "building", ["campus"], {});

  world.labels.buildings.push({
    id: "b1", name: data.name, towerId: "b1",
    /* anchor the chip below the parapet so the camera rail never covers it */
    pos: new THREE.Vector3(pb.cx, pb.cy, data.roof - 6.5),
  });
  return tower;
}

function buildAnnexB(world, env, M) {
  const data = PRESENT.towers.b2;
  const meta = roomMeta(env);
  const g = group(world.root, "tower-b2");
  const roofGroup = group(g, "roof-b2");
  const tower = {
    id: "b2", name: data.name, group: g, roofGroup,
    floors: [], roofZ: data.roof, crownZ: data.crown, mastZ: data.mast,
    roofLift: 0,
  };
  world.towers.b2 = tower;

  let prevBounds = null;
  for (let i = 0; i < data.floors.length; i++) {
    const fd = data.floors[i];
    const f = buildStorey(world, env, M, tower, fd, i, prevBounds, meta, {
      podium: i === 0, detailed: false, buildingId: "b2",
    });
    tower.floors.push(f);
    prevBounds = fd.bounds;
  }
  buildRoofAnnex(world, M, tower, data);

  const pb = data.floors[0].bounds;
  const pick = box(M.darkMetal, pb.w + 0.4, pb.d + 0.4, data.crown,
    pb.cx, pb.cy, data.crown / 2, { cast: false, receive: false });
  pick.visible = false;
  g.add(pick);
  tagPick(world, pick, "buildings", "b2", "building", ["campus"], {});

  world.labels.buildings.push({
    id: "b2", name: data.name, towerId: "b2",
    pos: new THREE.Vector3(pb.cx, pb.cy, data.roof + 1.6),
  });
  return tower;
}

/* ---------------- one storey ---------------- */

function buildStorey(world, env, M, tower, fd, index, prevBounds, meta, opts) {
  const b = fd.bounds;
  const base = fd.base;
  const fg = group(tower.group, "floor-" + fd.id);
  const floorBatch = new Batcher();
  const glassMats = [];
  const buildingId = opts.buildingId;

  /* structural slab, extended over the lower storey's footprint so the
     setback reads as a planted terrace instead of an open plenum.
     Tower A grows a deep cantilevered plate at each setback; the other
     buildings keep the original close-fitting terrace. */
  const terraceEx = buildingId === "b1" && index > 0 && prevBounds
    ? B1_TERRACE[index] : null;
  const outer = terraceEx
    ? expandBounds(prevBounds, terraceEx)
    : (index > 0 && prevBounds ? prevBounds : b);
  const slab = box(M.concrete, outer.w + 0.26, outer.d + 0.26, 0.56,
    outer.cx, outer.cy, base - 0.28);
  slab.receiveShadow = true;
  fg.add(slab);
  /* a dark metal fascia covers the raw slab edge, so each storey reads
     as a clean shadow band instead of a bright concrete plate; the warm
     bronze lip underneath gives the cantilever a lit, crafted edge */
  const fo = 0.16;
  floorBatch.box(M.darkMetal, outer.cx, outer.y0 - fo, base - 0.28,
    outer.w + 0.34, 0.07, 0.6, { cast: false });
  floorBatch.box(M.darkMetal, outer.cx, outer.y1 + fo, base - 0.28,
    outer.w + 0.34, 0.07, 0.6, { cast: false });
  floorBatch.box(M.darkMetal, outer.x0 - fo, outer.cy, base - 0.28,
    0.07, outer.d + 0.34, 0.6, { cast: false });
  floorBatch.box(M.darkMetal, outer.x1 + fo, outer.cy, base - 0.28,
    0.07, outer.d + 0.34, 0.6, { cast: false });
  if (terraceEx) {
    floorBatch.box(M.bronzeLight, outer.cx, outer.y0 - 0.02, base - 0.55,
      outer.w + 0.5, 0.1, 0.07, { cast: false });
    floorBatch.box(M.bronzeLight, outer.cx, outer.y1 + 0.02, base - 0.55,
      outer.w + 0.5, 0.1, 0.07, { cast: false });
    floorBatch.box(M.bronzeLight, outer.x0 - 0.02, outer.cy, base - 0.55,
      0.1, outer.d + 0.5, 0.07, { cast: false });
    floorBatch.box(M.bronzeLight, outer.x1 + 0.02, outer.cy, base - 0.55,
      0.1, outer.d + 0.5, 0.07, { cast: false });
  }
  if (index > 0 && prevBounds) {
    buildTerrace(M, floorBatch, outer, b, base,
      { planted: buildingId === "b1" });
  }

  /* Tower A: each logical floor is a 19.2 m group of two 9.6 m bands.
     A real intermediate slab separates the occupied band (rooms,
     services, cutaway) from the quiet dark-glass band above, so the
     section has a clean soffit and the tower reads as a high-rise. */
  const grouped = buildingId === "b1" && fd.height > 12;
  const bandH = grouped ? 9.6 : fd.height;
  if (grouped) {
    const mz = base + bandH;
    const mid = box(M.concrete, b.w + 0.2, b.d + 0.2, 0.5, b.cx, b.cy, mz);
    mid.receiveShadow = true;
    fg.add(mid);
    const mf = 0.15;
    floorBatch.box(M.darkMetal, b.cx, b.y0 - mf, mz, b.w + 0.34, 0.07, 0.44, { cast: false });
    floorBatch.box(M.darkMetal, b.cx, b.y1 + mf, mz, b.w + 0.34, 0.07, 0.44, { cast: false });
    floorBatch.box(M.darkMetal, b.x0 - mf, b.cy, mz, 0.07, b.d + 0.34, 0.44, { cast: false });
    floorBatch.box(M.darkMetal, b.x1 + mf, b.cy, mz, 0.07, b.d + 0.34, 0.44, { cast: false });
  }

  fg.add(box(M.concrete, b.w - 0.14, b.d - 0.14, 0.022,
    b.cx, b.cy, base + 0.011, { cast: false }));

  const ceilingGroup = group(fg, "ceilings-" + fd.id);
  const servicesGroup = group(fg, "services-" + fd.id);
  const roomCeilings = [];
  const wallSeen = new Set();

  /* rooms: interior fit-out + shell + tint + labels */
  for (const rd of fd.rooms) {
    const info = meta.get(rd.id) || { name: rd.id, usage: "office" };
    const rg = group(fg, "room-" + rd.id);
    const ceilG = group(ceilingGroup, "room-ceil-" + rd.id);

    const tintMat = new THREE.MeshStandardMaterial({
      color: M.usage[info.usage] || 0x6b7480, roughness: 0.7, metalness: 0.04,
      transparent: true, opacity: 0.12, emissive: 0x000000, depthWrite: false,
    });
    const ltMat = M.glowWarm.clone();
    const plMat = M.glowWarm.clone();
    const ceilingMat = M.ceiling.clone();
    ceilingMat.transparent = true;
    ceilingMat.opacity = 1;
    const coveMat = M.cove.clone();
    coveMat.transparent = true;
    coveMat.opacity = 1;

    const roomObj = {
      id: rd.id, name: info.name, usage: info.usage,
      towerId: buildingId, floorId: fd.id, floorHeight: fd.height,
      rect: rd.rect, base, door: rd.door, entry: rd.entry,
      group: rg, ceilGroup: ceilG, ltMat, plMat,
      ceilingMat, coveMat, M, batch: floorBatch,
      addDevice: (id, grp, anchor, floorId, roomId, title) =>
        addDevice(world, id, grp, anchor, floorId, roomId, title),
      registerStatusMat,
      tagPick: (obj, layer, id, kind, modes, extra) =>
        tagPick(world, obj, layer, id, kind, modes, extra),
    };
    furnishRoom(roomObj, roomObj);
    finishRoomShell(M, floorBatch, fd, rd, roomObj, wallSeen);

    /* usage tint doubles as the room pick target */
    const tint = plane(tintMat, rd.rect.w - 0.14, rd.rect.d - 0.14,
      rd.rect.cx, rd.rect.cy, base + 0.052);
    tint.renderOrder = 2;
    rg.add(tint);
    tagPick(world, tint, "rooms", rd.id, "room", ["floor", "room"],
      { floorId: fd.id, buildingId });

    const labelPos = new THREE.Vector3(rd.rect.x0 + 0.55, rd.rect.y0 + 0.5, base + 1.0);
    world.rooms.set(rd.id, {
      id: rd.id, name: info.name, usage: info.usage,
      buildingId, floorId: fd.id, group: rg, tintMat,
      rect: rd.rect, surface: base, labelPos,
      // The interiors module authors a per-room ceiling height; the camera
      // uses it to keep interior orbits under the ceiling and above the floor.
      ceilingH: roomObj.ceilingH || base + fd.ceil,
      ceilingMats: [ceilingMat, coveMat],
      ceilGroup: ceilG,
    });
    world.labels.rooms.push({
      id: rd.id, name: info.name, floorId: fd.id, buildingId,
      pos: labelPos.clone(),
    });
    roomCeilings.push(ceilG);
  }

  buildCore(world, M, floorBatch, fd, fg, opts.detailed);
  const cutBands = buildEnvelope(M, floorBatch, fg, fd, glassMats, opts);
  floorBatch.flush(fg);

  /* ground-floor architecture: the double-height portal frame lives in
     the cuttable façade, while the canopy, columns and planters are
     static pieces of the podium */
  if (fd.id === "b1f1") buildEntranceCanopy(M, fg, fd);

  /* exposed plenum services + the floor FCU (existing device ids) */
  const servicesBatch = new Batcher();
  const layout = fd.id === "b1f1"
    ? {
      zDuct: base + 8.35, zBranch: base + 7.25,
      ducts: [{ y: 2.2, len: 15.0, depth: 0.55, h: 0.34 },
        { y: 6.4, len: 14.0, depth: 0.45, h: 0.28 }],
      centers: [[-4.4, 2.6], [-4.4, 6.4], [6.4, 2.6], [6.4, 6.4]],
      trays: [[-7.6, 2.2, 1.2], [-3.0, 2.0, 7.4]],
      sprinklerY: 4.2, sprinklerLen: 15.0, beamLen: 11.8,
      fcu: { x: 3.4, y: 6.6 }, fcuZ: base + 7.65,
    }
    : (buildingId === "b2"
      ? { minimal: true, fcu: { x: 34.5, y: 0.5 }, fcuZ: base + fd.height - 0.85 }
      : null);
  buildFloorServices({
    M,
    floor: { id: fd.id, base, bounds: b, height: fd.height },
    batch: servicesBatch,
    servicesGroup,
    fcuGroup: fg,
    layout,
    addDevice: (id, grp, anchor, floorId, roomId, title) =>
      addDevice(world, id, grp, anchor, floorId, roomId, title),
    registerStatusMat,
    tagPick: (obj, layer, id, kind, modes, extra) =>
      tagPick(world, obj, layer, id, kind, modes, extra),
  });
  servicesBatch.flush(servicesGroup);

  /* floor pick (building view) */
  const floorPick = box(M.darkMetal, b.w - 0.2, b.d - 0.2, fd.height - 0.3,
    b.cx, b.cy, base + fd.height / 2 - 0.05, { cast: false, receive: false });
  floorPick.visible = false;
  fg.add(floorPick);
  tagPick(world, floorPick, "floors", fd.id, "floor", ["building"],
    { floorId: fd.id, buildingId });

  world.labels.floors.push({
    id: fd.id, name: fd.label, floorId: fd.id, buildingId,
    pos: new THREE.Vector3(b.x0 - 1.1, b.cy,
      buildingId === "b1" ? base + 4.6 : base + fd.height * 0.5),
  });

  return {
    id: fd.id, name: fd.label, group: fg, slab, base,
    height: fd.height, bandH, bounds: b, top: base + fd.height,
    glassMats, ceilingGroup, roomCeilings, servicesGroup, cutBands,
    floorPick, lift: 0, surface: base,
  };
}

/* setback terrace ring + glass balustrade */
function buildTerrace(M, b, outer, inner, z, opts) {
  const strips = [
    [outer.cx, (outer.y0 + inner.y0) / 2, outer.w + 0.1, Math.max(0.1, inner.y0 - outer.y0)],
    [outer.cx, (inner.y1 + outer.y1) / 2, outer.w + 0.1, Math.max(0.1, outer.y1 - inner.y1)],
    [(outer.x0 + inner.x0) / 2, inner.cy, Math.max(0.1, inner.x0 - outer.x0), inner.d],
    [(inner.x1 + outer.x1) / 2, inner.cy, Math.max(0.1, outer.x1 - inner.x1), inner.d],
  ];
  for (const [x, y, w, d] of strips) {
    b.box(M.concrete, x, y, z - 0.24, w, d, 0.48);
    b.box(M.paving, x, y, z + 0.035, Math.max(0.08, w - 0.12), Math.max(0.08, d - 0.12), 0.05, { cast: false });
  }
  /* glass balustrade around the outer edge */
  const railZ = z + 0.55;
  const sides = [
    [outer.cx, outer.y0 + 0.06, outer.w, 0.03],
    [outer.cx, outer.y1 - 0.06, outer.w, 0.03],
    [outer.x0 + 0.06, outer.cy, 0.03, outer.d],
    [outer.x1 - 0.06, outer.cy, 0.03, outer.d],
  ];
  for (const [x, y, w, d] of sides) {
    b.box(M.glassClear, x, y, railZ, w, d, 0.95, { cast: false });
    b.box(M.bronze, x, y, railZ + 0.5, w + 0.04, d + 0.04, 0.05);
    b.box(M.mullion, x, y, z + 0.52, w + 0.03, d + 0.03, 0.05, { cast: false });
  }
  for (let x = outer.x0; x <= outer.x1 + 0.01; x += 2.6) {
    b.box(M.mullion, x, outer.y0 + 0.06, railZ, 0.04, 0.05, 1.02);
    b.box(M.mullion, x, outer.y1 - 0.06, railZ, 0.04, 0.05, 1.02);
  }
  for (let y = outer.y0; y <= outer.y1 + 0.01; y += 2.6) {
    b.box(M.mullion, outer.x0 + 0.06, y, railZ, 0.05, 0.04, 1.02);
    b.box(M.mullion, outer.x1 - 0.06, y, railZ, 0.05, 0.04, 1.02);
  }

  /* planted pockets on the deepest edges: a green line at every setback
     is what makes the terraces read as usable outdoor rooms */
  if (opts && opts.planted) {
    const plant = (x, y, w, d) => {
      b.box(M.planter, x, y, z + 0.28, w, d, 0.52);
      b.box(M.soil, x, y, z + 0.55, Math.max(0.1, w - 0.12), Math.max(0.1, d - 0.12), 0.06, { cast: false });
      b.box(M.hedge, x, y, z + 0.76, Math.max(0.1, w - 0.2), Math.max(0.1, d - 0.2), 0.38);
    };
    plant(outer.x0 + 2.0, outer.y0 + 0.95, 2.6, 0.85);
    plant(outer.x1 - 2.0, outer.y0 + 0.95, 2.6, 0.85);
    plant(outer.x0 + 0.95, inner.cy, 0.85, 2.6);
  }
}

/* ---------------- room shell ---------------- */

function finishRoomShell(M, batch, fd, rd, room, seen) {
  const r = rd.rect;
  const base = fd.base;
  const top = room.ceilingH || base + 4.6;
  const h = Math.max(2.4, top - base - 0.06);
  const z = base + h / 2 + 0.02;
  const t = 0.14;
  const gap = 1.15;
  const b = fd.bounds;
  const bounded = (a, c) => Math.abs(a - c) > 0.08;

  const wall = (side, fixed, u0, u1, door) => {
    const segs = door ? twoSegments(u0, u1, side === "S" || side === "N" ? r.cx : r.cy, gap) : [[u0, u1]];
    for (const [s0, s1] of segs) {
      const len = s1 - s0;
      if (len < 0.06) continue;
      const key = side + "|" + fixed.toFixed(2) + "|" + s0.toFixed(2) + "|" + s1.toFixed(2);
      if (seen.has(key)) continue;
      seen.add(key);
      if (side === "S" || side === "N") batch.box(M.wall, (s0 + s1) / 2, fixed, z, len, t, h);
      else batch.box(M.wall, fixed, (s0 + s1) / 2, z, t, len, h);
    }
  };

  if (bounded(r.y0, b.y0)) wall("S", r.y0, r.x0, r.x1, rd.door === "S");
  if (bounded(r.y1, b.y1)) wall("N", r.y1, r.x0, r.x1, rd.door === "N");
  if (bounded(r.x0, b.x0)) wall("W", r.x0, r.y0, r.y1, rd.door === "W");
  if (bounded(r.x1, b.x1)) wall("E", r.x1, r.y0, r.y1, rd.door === "E");

  addDoor(M, batch, rd, room);
}

function addDoor(M, batch, rd, room) {
  const r = rd.rect, base = room.base;
  const side = rd.door;
  if (!side) return;
  const gap = 1.15, dh = 2.35;
  const alongX = side === "S" || side === "N";
  const c = alongX ? r.cx : r.cy;
  const fixed = side === "S" ? r.y0 : side === "N" ? r.y1 : side === "W" ? r.x0 : r.x1;

  /* jambs + lintel */
  if (alongX) {
    batch.box(M.bronze, c - gap / 2 - 0.035, fixed, base + dh / 2, 0.07, 0.17, dh);
    batch.box(M.bronze, c + gap / 2 + 0.035, fixed, base + dh / 2, 0.07, 0.17, dh);
    batch.box(M.bronze, c, fixed, base + dh + 0.06, gap + 0.14, 0.17, 0.12);
  } else {
    batch.box(M.bronze, fixed, c - gap / 2 - 0.035, base + dh / 2, 0.17, 0.07, dh);
    batch.box(M.bronze, fixed, c + gap / 2 + 0.035, base + dh / 2, 0.17, 0.07, dh);
    batch.box(M.bronze, fixed, c, base + dh + 0.06, 0.17, gap + 0.14, 0.12);
  }

  /* leaf, hinged at the low-coordinate jamb and ajar into the room */
  const theta = (side === "S" || side === "E") ? 0.42 : -0.42;
  let hingeX, hingeY;
  if (alongX) { hingeX = c - gap / 2 + 0.02; hingeY = fixed; }
  else { hingeX = fixed; hingeY = c - gap / 2 + 0.02; }
  let lx, ly, w, d;
  if (alongX) {
    lx = hingeX + 0.5 * Math.cos(theta);
    ly = hingeY + 0.5 * Math.sin(theta);
    w = 0.98; d = 0.045;
  } else {
    lx = hingeX - 0.5 * Math.sin(theta);
    ly = hingeY + 0.5 * Math.cos(theta);
    w = 0.045; d = 0.98;
  }
  batch.box(M.glassRail, lx, ly, base + 1.14, w, d, 2.24, { rz: theta, cast: false });
  const hx = hingeX + (alongX ? Math.cos(theta) : -Math.sin(theta)) * 0.86;
  const hy = hingeY + (alongX ? Math.sin(theta) : Math.cos(theta)) * 0.86;
  batch.box(M.bronze, hx, hy, base + 1.05, 0.05, 0.05, 0.24, { rz: theta });

  /* room number sign on the corridor side */
  const signSide = side === "S" ? -1 : side === "N" ? 1 : 0;
  const sx = alongX ? c : fixed + (side === "W" ? -0.1 : 0.1);
  const sy = alongX ? fixed + (signSide === -1 ? -0.1 : 0.1) : c;
  batch.box(M.glowSoft, sx, sy, base + 2.56, alongX ? 0.44 : 0.03, alongX ? 0.03 : 0.44, 0.1, { cast: false });
}

/* ---------------- lifts + fire stair ---------------- */

function buildCore(world, M, batch, fd, fg, detailed) {
  const core = PRESENT.towers.b1.core;
  if (!core || fd.id.indexOf("b1") !== 0) return;
  const base = fd.base, h = fd.height - 0.1, z = base + h / 2;
  const t = 0.22;
  const sh = core.shaft, st = core.stair;

  /* shaft walls */
  batch.box(M.wallWarm, sh.cx, sh.y1, z, sh.w + t, t, h);
  batch.box(M.wallWarm, sh.x0, sh.cy, z, t, sh.d, h);
  batch.box(M.wallWarm, sh.x1, sh.cy, z, t, sh.d, h);
  batch.box(M.wallWarm, sh.cx, sh.y0, z, sh.w + t, t, h);
  /* stair enclosure */
  batch.box(M.wall, st.cx, st.y0, z, st.w + t, t, h);
  batch.box(M.wall, st.x0, st.cy, z, t, st.d, h);
  batch.box(M.wall, (st.x1 + sh.x0) / 2, st.cy, z, Math.max(0.08, sh.x0 - st.x1), t, h);
  batch.box(M.wall, st.cx, st.y1, z, st.w + t, t, h);

  /* lift doors on the south face of the shaft */
  const dz = base + 1.12;
  const cx = sh.cx, dy = sh.y0 - 0.02;
  batch.box(M.bronze, cx, dy, dz + 1.2, 1.9, 0.14, 0.12);
  for (const s of [-1, 1]) {
    batch.box(M.bronze, cx + s * 1.0, dy, dz + 1.15, 0.1, 0.14, 2.42);
    batch.box(M.metal, cx + s * 0.47, dy - 0.015, dz, 0.86, 0.06, 2.2);
  }
  const seamMat = M.glowCool.clone();
  batch.box(seamMat, cx, dy - 0.02, dz + 1.1, 0.022, 0.02, 1.9, { cast: false });
  batch.box(M.darkMetal, cx + 1.28, dy - 0.03, dz + 1.55, 0.16, 0.04, 0.34);

  /* fire stair: two flights with a half landing.  On a grouped Tower A
     storey the two flights serve the occupied 9.6 m band only; the
     shaft walls continue through the dark band above. */
  const stairH = Math.min(fd.height, 9.6);
  const steps = 10, rise = stairH / (steps * 2), run = st.d / steps - 0.04;
  for (let i = 0; i < steps; i++) {
    const zz = base + (i + 1) * rise;
    const yy = st.y0 + 0.18 + i * run;
    batch.box(M.concrete, st.x0 + st.w * 0.28, yy, zz - rise / 2,
      st.w * 0.42, run, rise);
  }
  batch.box(M.concrete, st.cx, st.y1 - 0.28, base + stairH / 2, st.w, 0.5, 0.18);
  for (let i = 0; i < steps; i++) {
    const zz = base + stairH / 2 + (i + 1) * rise;
    const yy = st.y1 - 0.42 - i * run;
    batch.box(M.concrete, st.x0 + st.w * 0.72, yy, zz - rise / 2,
      st.w * 0.42, run, rise);
  }
  const rail = (x, y0, z0, y1, z1) => {
    const p = pipe(M.handrail, x, y0, z0, x, y1, z1, 0.022, 6);
    if (p) fg.add(p);
  };
  rail(st.x0 + st.w * 0.05, st.y0 + 0.2, base + 0.9 / 2 + 0.6,
    st.y1 - 0.3, base + stairH / 2 + 0.6);
  rail(st.x1 - st.w * 0.05, st.y1 - 0.3, base + stairH / 2 + 0.9,
    st.y0 + 0.2, base + stairH + 0.2);

  /* the lift itself is one logical device (el-b1) with a panel per floor */
  const elGroup = group(fg, "elevator-" + fd.id);
  const seam = box(seamMat, 0.024, 0.024, 1.9, cx, dy - 0.045, dz + 1.1,
    { cast: false, receive: false });
  elGroup.add(seam);
  const elDev = world.devices.get("el-b1") ||
    addDevice(world, "el-b1", elGroup,
      new THREE.Vector3(cx, dy, base + 1.9), fd.id, null, "ELEVATOR");
  registerStatusMat(elDev, seamMat);
  for (const side of [-1, 1]) {
    const panel = box(M.metal, 0.86, 0.06, 2.2, cx + side * 0.47, dy - 0.015, dz,
      { cast: false, receive: false });
    elGroup.add(panel);
    tagPick(world, panel, "devices", "el-b1", "device",
      ["building", "floor", "room"], { floorId: fd.id });
  }
}

/* ---------------- curtain wall ---------------- */

function buildEnvelope(M, batch, fg, fd, glassMats, opts) {
  if (opts.buildingId === "b1") {
    return buildEnvelopeTower(M, batch, fg, fd, glassMats, opts);
  }
  return buildEnvelopeSimple(M, batch, fg, fd, glassMats, opts);
}

/* Annex B keeps the original single-band curtain wall. */
function buildEnvelopeSimple(M, batch, fg, fd, glassMats, opts) {
  const b = fd.bounds, base = fd.base;
  const podium = !!opts.podium;
  const zone0 = base + (podium ? 1.0 : 0.5);
  const zone1 = base + fd.height - 0.3;
  const detailed = !!opts.detailed;
  const isB1 = opts.buildingId === "b1";

  const sides = [
    { id: "S", x: b.cx, y: b.y0, len: b.w, alongX: true },
    { id: "N", x: b.cx, y: b.y1, len: b.w, alongX: true },
    { id: "W", x: b.x0, y: b.cy, len: b.d, alongX: false },
    { id: "E", x: b.x1, y: b.cy, len: b.d, alongX: false },
  ];

  const pane = (side, along, len, z0, z1) => {
    if (len < 0.08 || z1 - z0 < 0.08) return;
    const mat = M.glass.clone();
    mat.opacity = 0.3;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, z1 - z0), mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    const z = (z0 + z1) / 2;
    if (side.alongX) {
      mesh.position.set(along, side.y, z);
      mesh.rotation.x = side.id === "S" ? PI / 2 : -PI / 2;
    } else {
      mesh.position.set(side.x, along, z);
      mesh.rotation.set(PI / 2, side.id === "W" ? -PI / 2 : PI / 2, 0);
    }
    fg.add(mesh);
    glassMats.push({ side: side.id, mat, mesh });
  };

  const doorSplit = (id) => {
    if (isB1 && podium && id === "S") return { x0: -5.95, x1: -1.65, top: 4.72 };
    if (!isB1 && fd.id === "b2f1" && id === "S") return { x0: 28.2, x1: 31.8, top: 3.7 };
    return null;
  };

  for (const side of sides) {
    const split = doorSplit(side.id);
    const a0 = (side.alongX ? b.x0 : b.y0) + 0.18;
    const a1 = (side.alongX ? b.x1 : b.y1) - 0.18;
    if (split) {
      pane(side, (a0 + split.x0) / 2, split.x0 - a0, zone0, zone1);
      pane(side, (split.x1 + a1) / 2, a1 - split.x1, zone0, zone1);
      pane(side, (split.x0 + split.x1) / 2, split.x1 - split.x0, split.top + 0.28, zone1);
    } else {
      pane(side, (a0 + a1) / 2, a1 - a0, zone0, zone1);
    }

    /* spandrel / plinth */
    const outerOff = 0.03;
    if (podium) {
      const plinthH = 1.08;
      if (split) {
        const segs = twoSegments(a0, a1, (split.x0 + split.x1) / 2, split.x1 - split.x0);
        for (const [s0, s1] of segs) {
          if (s1 - s0 < 0.1) continue;
          batch.box(M.stone, (s0 + s1) / 2, side.y + (side.id === "S" ? -outerOff : outerOff),
            base + plinthH / 2, s1 - s0, 0.24, plinthH);
        }
      } else {
        batch.box(M.stone, side.x, side.y + (side.id === "S" ? -outerOff : outerOff),
          base + plinthH / 2, side.len, 0.24, plinthH);
      }
    } else {
      batch.box(M.mullion, side.x, side.y, base + 0.28, side.len, 0.16, 0.56);
      batch.box(M.stone, side.x, side.y, base + 0.04, side.len + 0.1, 0.22, 0.1, { cast: false });
    }

    /* vertical mullions */
    const spacing = detailed ? 1.55 : 2.2;
    const n = Math.max(2, Math.round(side.len / spacing));
    for (let i = 0; i <= n; i++) {
      const a = (side.alongX ? b.x0 : b.y0) + (side.len * i) / n;
      if (split && a > split.x0 - 0.25 && a < split.x1 + 0.25) continue;
      if (side.alongX) {
        batch.box(M.mullion, a, side.y, base + fd.height / 2, 0.075, 0.16, fd.height - 0.12);
      } else {
        batch.box(M.mullion, side.x, a, base + fd.height / 2, 0.16, 0.075, fd.height - 0.12);
      }
    }

    /* head, sill and mid transoms */
    const headZ = zone1 + 0.16;
    const midZ = zone0 + (zone1 - zone0) * (podium ? 0.52 : 0.55);
    if (side.alongX) {
      batch.box(M.mullion, side.x, side.y, headZ, side.len, 0.22, 0.22);
      batch.box(M.mullion, side.x, side.y, zone0 - 0.05, side.len, 0.18, 0.12);
      batch.box(M.mullion, side.x, side.y, midZ, side.len, 0.12, 0.06, { cast: false });
    } else {
      batch.box(M.mullion, side.x, side.y, headZ, 0.22, side.len, 0.22);
      batch.box(M.mullion, side.x, side.y, zone0 - 0.05, 0.18, side.len, 0.12);
      batch.box(M.mullion, side.x, side.y, midZ, 0.12, side.len, 0.06, { cast: false });
    }

    /* deep bronze fins give the tower its vertical rhythm */
    if (detailed) {
      const finH = zone1 - zone0 + 0.9;
      for (let a = (side.alongX ? b.x0 : b.y0) + 1.55; a < (side.alongX ? b.x1 : b.y1) - 0.5; a += 3.1) {
        if (split && a > split.x0 - 0.4 && a < split.x1 + 0.4) continue;
        if (side.alongX) {
          const yy = side.y + (side.id === "S" ? -0.2 : 0.2);
          batch.box(M.darkMetal, a, yy, zone0 + finH / 2 - 0.35, 0.11, 0.38, finH);
        } else {
          const xx = side.x + (side.id === "W" ? -0.2 : 0.2);
          batch.box(M.darkMetal, xx, a, zone0 + finH / 2 - 0.35, 0.38, 0.11, finH);
        }
      }
    }
  }

  /* corner columns */
  const col = detailed ? 0.38 : 0.34;
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
    batch.box(detailed ? M.mullion : M.stone, x, y, base + fd.height / 2,
      col, col, fd.height + 0.1);
  }

  if (podium) buildEntrance(M, batch, fg, fd, isB1);
}

/* Tower A curtain wall: two 9.6 m bands per logical floor, now with real
   façade depth.  Glass is recessed 26 cm behind the mullion plane, deep
   bronze fins and sandstone corner piers throw a changing shadow
   pattern, and a warm bronze belt marks every band.  The lower band is
   the operational storey — its four walls are built as separate groups
   with cloned materials so the section can lift the camera-facing wall
   away cleanly (glass, mullions, transoms, fins and spandrel).  The
   upper band is a quiet dark-glass storey that stays closed in every
   mode, which gives the tower its layered high-rise façade. */
function buildEnvelopeTower(M, batch, fg, fd, glassMats, opts) {
  const b = fd.bounds, base = fd.base;
  const podium = !!opts.podium;
  const bandH = 9.6;
  const REC = 0.26;

  const sides = [
    { id: "S", x: b.cx, y: b.y0, len: b.w, alongX: true, nx: 0, ny: -1 },
    { id: "N", x: b.cx, y: b.y1, len: b.w, alongX: true, nx: 0, ny: 1 },
    { id: "W", x: b.x0, y: b.cy, len: b.d, alongX: false, nx: -1, ny: 0 },
    { id: "E", x: b.x1, y: b.cy, len: b.d, alongX: false, nx: 1, ny: 0 },
  ];

  /* Cloned, transparent materials for one operable band side.  Fading a
     single material fades the whole instanced batch of its side. */
  const cutMats = () => {
    const out = {};
    for (const key of ["glass", "mullion", "bronze", "bronzeLight", "darkMetal",
      "stone", "stoneWarm", "stoneLight", "metal", "glowWarm", "glassRail", "carpetDark"]) {
      const src = M[key];
      if (!src) continue;
      const c = src.clone();
      c.transparent = true;
      c.userData.baseOpacity = src.opacity == null ? 1 : src.opacity;
      out[key] = c;
    }
    out.glass.opacity = podium ? 0.2 : 0.3;
    return out;
  };

  /* glass sits behind the structural plane, so every frame, fin and
     transom reads in depth rather than lying flat on the skin */
  const pane = (parent, mat, side, along, len, z0, z1, push) => {
    if (len < 0.08 || z1 - z0 < 0.08) return;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, z1 - z0), mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    const z = (z0 + z1) / 2;
    if (side.alongX) {
      mesh.position.set(along, side.y - side.ny * REC, z);
      mesh.rotation.x = side.id === "S" ? PI / 2 : -PI / 2;
    } else {
      mesh.position.set(side.x - side.nx * REC, along, z);
      mesh.rotation.set(PI / 2, side.id === "W" ? -PI / 2 : PI / 2, 0);
    }
    parent.add(mesh);
    if (push) glassMats.push({ side: side.id, mat, mesh });
  };

  const bar = (side, batcher, m, z, h, out, thick, key) => {
    const mat = m[key] || m.darkMetal;
    if (side.alongX) batcher.box(mat, side.x, side.y + side.ny * out, z, side.len, thick, h);
    else batcher.box(mat, side.x + side.nx * out, side.y, z, thick, side.len, h);
  };

  const post = (side, batcher, m, key, a, z0, z1, w, depth, out) => {
    const mat = m[key] || m.darkMetal;
    const z = (z0 + z1) / 2, h = z1 - z0;
    if (h < 0.04) return;
    if (side.alongX) batcher.box(mat, a, side.y + side.ny * out, z, w, depth, h);
    else batcher.box(mat, side.x + side.nx * out, a, z, depth, w, h);
  };

  const band = (side, o) => {
    const m = o.m, batcher = o.batch, parent = o.parent;
    const z0 = o.z0, z1 = o.z1;
    const alongX = side.alongX;
    const a0 = (alongX ? b.x0 : b.y0) + 0.18;
    const a1 = (alongX ? b.x1 : b.y1) - 0.18;
    const split = o.split;
    const gz0 = o.glassZ0, gz1 = o.glassZ1;

    if (split) {
      pane(parent, m.glass, side, (a0 + split.x0) / 2, split.x0 - a0, gz0, gz1, o.glassPush);
      pane(parent, m.glass, side, (split.x1 + a1) / 2, a1 - split.x1, gz0, gz1, o.glassPush);
      pane(parent, m.glass, side, (split.x0 + split.x1) / 2, split.x1 - split.x0,
        split.top + 0.28, gz1, o.glassPush);
    } else {
      pane(parent, m.glass, side, (a0 + a1) / 2, a1 - a0, gz0, gz1, o.glassPush);
    }

    /* spandrel / plinth */
    if (o.upper) {
      bar(side, batcher, m, z0 + 0.25, 0.5, 0.12, 0.3, "stoneWarm");
      bar(side, batcher, m, z0 + 0.53, 0.07, 0.20, 0.34, "bronze");
      bar(side, batcher, m, z1 - 0.24, 0.42, 0.26, 0.38, "bronzeLight");
    } else if (podium) {
      const plinthH = 1.45;
      if (split) {
        const segs = twoSegments(a0, a1, (split.x0 + split.x1) / 2, split.x1 - split.x0);
        for (const [s0, s1] of segs) {
          if (s1 - s0 < 0.1) continue;
          const c = (s0 + s1) / 2, len = s1 - s0;
          if (alongX) {
            batcher.box(m.stoneWarm, c, side.y + side.ny * 0.10,
              base + plinthH / 2, len, 0.34, plinthH);
          } else {
            batcher.box(m.stoneWarm, side.x + side.nx * 0.10, c,
              base + plinthH / 2, 0.34, len, plinthH);
          }
        }
      } else {
        bar(side, batcher, m, base + plinthH / 2, plinthH, 0.10, 0.34, "stoneWarm");
      }
      bar(side, batcher, m, base + plinthH + 0.05, 0.1, 0.20, 0.38, "bronze");
      bar(side, batcher, m, z1 - 0.24, 0.44, 0.30, 0.38, "bronzeLight");
    } else {
      bar(side, batcher, m, z0 + 0.28, 0.56, 0.02, 0.18, "mullion");
      bar(side, batcher, m, z0 + 0.05, 0.1, 0.05, 0.24, "stone");
      bar(side, batcher, m, z1 - 0.24, 0.4, 0.28, 0.36, "bronzeLight");
    }

    /* vertical mullions */
    const spacing = 1.55;
    const n = Math.max(2, Math.round(side.len / spacing));
    for (let i = 0; i <= n; i++) {
      const a = (alongX ? b.x0 : b.y0) + (side.len * i) / n;
      if (split && a > split.x0 - 0.25 && a < split.x1 + 0.25) continue;
      post(side, batcher, m, "mullion", a, z0 + 0.03, z1 - 0.02, 0.085, 0.26, 0);
    }

    /* head, sill and window rows; shallow sunshades give the rows relief */
    const headZ = gz1 + 0.16;
    const rows = o.upper ? [0.33, 0.66] : (podium ? [0.62] : [0.33, 0.66]);
    bar(side, batcher, m, headZ, 0.22, 0.16, 0.3, "mullion");
    bar(side, batcher, m, gz0 - 0.05, 0.12, 0.10, 0.28, "mullion");
    for (const f of rows) {
      const tz = gz0 + (gz1 - gz0) * f;
      bar(side, batcher, m, tz, 0.07, 0.16, 0.24, "mullion");
      bar(side, batcher, m, tz - 0.10, 0.06, 0.36, 0.12, "bronze");
    }

    /* fins: a real shadow rhythm, not a flat grid */
    const step = o.upper ? 3.1 : 2.45;
    for (let a = (alongX ? b.x0 : b.y0) + 1.55; a < (alongX ? b.x1 : b.y1) - 0.5; a += step) {
      if (split && a > split.x0 - 0.4 && a < split.x1 + 0.4) continue;
      if (o.upper) {
        post(side, batcher, m, "bronze", a, gz0 - 0.1, gz1 + 0.25, 0.1, 0.34, 0.12);
      } else {
        post(side, batcher, m, "bronze", a, gz0 - 0.1, gz1 + 0.2, 0.09, 0.5, 0.16);
      }
    }
    if (o.upper) {
      for (let a = (alongX ? b.x0 : b.y0) + 1.6; a < (alongX ? b.x1 : b.y1) - 0.6; a += 6.2) {
        post(side, batcher, m, "bronzeLight", a, gz0 - 0.15, gz1 + 0.32, 0.17, 0.72, 0.24);
      }
    }

    /* ground-floor colonnade: sandstone piers carry a double-height
       lobby and give the base its own architectural scale */
    if (podium && !o.upper) {
      const nP = Math.max(2, Math.round(side.len / 4.9));
      for (let i = 1; i < nP; i++) {
        const a = (alongX ? b.x0 : b.y0) + (side.len * i) / nP;
        if (split && a > split.x0 - 0.55 && a < split.x1 + 0.55) continue;
        post(side, batcher, m, "stoneWarm", a, base, base + bandH - 0.32, 0.62, 0.38, 0.12);
        post(side, batcher, m, "bronze", a, base + bandH - 0.32, base + bandH - 0.18,
          0.74, 0.46, 0.15);
      }
    }
  };

  /* ---- operational (lower) band: one cuttable group per side ---- */
  const cutBands = [];
  for (const side of sides) {
    const m = cutMats();
    const g = group(fg, "wall-" + fd.id + "-" + side.id);
    const sb = new Batcher();
    const split = side.id === "S" && podium
      ? { x0: -7.2, x1: -0.4, top: 4.72 } : null;
    band(side, {
      m, batch: sb, parent: g,
      z0: base + 0.02, z1: base + bandH - 0.02,
      glassZ0: base + (podium ? 1.0 : 0.5),
      glassZ1: base + bandH - 0.3,
      split, glassPush: true,
    });
    if (split) buildEntrance(m, sb, g, fd, true);
    sb.flush(g);
    cutBands.push({
      side: side.id, group: g, glass: m.glass,
      mats: Object.keys(m).filter(k => k !== "glass").map(k => m[k]),
    });
  }

  /* ---- quiet upper band: shared materials, always closed ---- */
  const upperM = Object.create(M);
  upperM.glass = M.glassUpper;
  const u0 = base + bandH + 0.2;
  const u1 = base + fd.height;
  for (const side of sides) {
    band(side, {
      m: upperM, batch, parent: fg,
      z0: u0, z1: u1 - 0.02,
      glassZ0: u0 + 0.55, glassZ1: u1 - 0.3,
      split: null, glassPush: false, upper: true,
    });
  }

  /* sandstone corner piers, one per band, capped in bronze.  The
     lower-band piers sit between two cuttable sides, so each gets its
     own fade materials and disappears with the section instead of
     leaving a post in the foreground. */
  const cornerGeo = new THREE.BoxGeometry(0.62, 0.62, bandH - 0.05);
  const capGeo = new THREE.BoxGeometry(0.78, 0.78, 0.34);
  for (const [x, y, s1, s2] of [
    [b.x0, b.y0, "S", "W"], [b.x1, b.y0, "S", "E"],
    [b.x0, b.y1, "N", "W"], [b.x1, b.y1, "N", "E"],
  ]) {
    const cm = M.stoneWarm.clone();
    cm.transparent = true;
    cm.userData.baseOpacity = 1;
    const bm = M.bronze.clone();
    bm.transparent = true;
    bm.userData.baseOpacity = 1;
    const cg = group(fg, "corner-" + fd.id + "-" + s1 + s2);
    const col = new THREE.Mesh(cornerGeo, cm);
    col.position.set(x, y, base + bandH / 2);
    col.castShadow = true;
    col.receiveShadow = true;
    cg.add(col);
    const cap = new THREE.Mesh(capGeo, bm);
    cap.position.set(x, y, base + bandH - 0.19);
    cap.castShadow = true;
    cg.add(cap);
    cutBands.push({ sides: [s1, s2], group: cg, glass: null, mats: [cm, bm] });
    batch.box(M.stoneWarm, x, y, u0 + (u1 - u0) / 2, 0.52, 0.52, u1 - u0 - 0.04);
    batch.box(M.bronzeLight, x, y, u1 - 0.24, 0.68, 0.68, 0.4);
  }

  return cutBands;
}

function buildEntrance(M, batch, fg, fd, isB1) {
  const b = fd.bounds;
  const base = fd.base;
  const z = base;
  if (isB1) {
    const x0 = -7.2, x1 = -0.4;
    const cx = (x0 + x1) / 2;
    const portalH = 7.3;
    /* deep sandstone portal with bronze reveals: a proper double-height
       entrance instead of a hole in a curtain wall.  The jambs project
       three quarters of a metre, so the doorway has real shadow depth. */
    const portalY = b.y0 - 0.16;
    batch.box(M.stoneWarm, x0, portalY, z + portalH / 2, 0.7, 1.2, portalH);
    batch.box(M.stoneWarm, x1, portalY, z + portalH / 2, 0.7, 1.2, portalH);
    batch.box(M.stoneWarm, cx, portalY, z + portalH + 0.32, x1 - x0 + 0.7, 1.2, 0.64);
    batch.box(M.bronzeLight, x0 + 0.40, b.y0 - 0.78, z + portalH / 2, 0.16, 0.22, portalH);
    batch.box(M.bronzeLight, x1 - 0.40, b.y0 - 0.78, z + portalH / 2, 0.16, 0.22, portalH);
    batch.box(M.bronzeLight, cx, b.y0 - 0.78, z + portalH + 0.04,
      x1 - x0 - 0.66, 0.22, 0.2);
    /* bronze transom anchors the tall glass above the revolving door */
    batch.box(M.bronze, cx, b.y0 - 0.04, z + 4.9, x1 - x0, 0.5, 0.22);
    /* revolving door */
    const dcx = cx, dcy = b.y0 + 0.15;
    const drum = cylinder(M.glassRail, 1.18, 1.18, 3.0, dcx, dcy, z + 1.5, 26,
      { rx: PI / 2, cast: false });
    fg.add(drum);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.055, 8, 30), M.bronze);
    ring.rotation.x = 0;
    ring.position.set(dcx, dcy, z + 3.02);
    fg.add(ring);
    const cap = cylinder(M.bronze, 1.25, 1.25, 0.1, dcx, dcy, z + 3.1, 26,
      { rx: PI / 2, cast: false });
    fg.add(cap);
    const post = cylinder(M.bronze, 0.055, 0.055, 3.0, dcx, dcy, z + 1.5, 12,
      { rx: PI / 2 });
    fg.add(post);
    for (let i = 0; i < 3; i++) {
      const ang = i * TAU / 3;
      const [wx, wy] = lp(dcx, dcy, ang, 0.58, 0);
      batch.box(M.glassRail, wx, wy, z + 1.5, 1.15, 0.04, 2.92, { rz: ang, cast: false });
      batch.box(M.bronze, wx, wy, z + 2.96, 1.18, 0.05, 0.05, { rz: ang });
    }
    /* side swing leaves */
    for (const [sx, w] of [[x0 + 1.15, 1.1], [x1 - 1.15, 1.1]]) {
      batch.box(M.glassRail, sx, b.y0, z + 1.5, w, 0.035, 3.0, { cast: false });
      batch.box(M.bronze, sx, b.y0, z + 3.03, w + 0.04, 0.05, 0.06);
    }
    /* entrance rug / mat */
    batch.box(M.carpetDark, cx, b.y0 + 1.0, z + 0.045, 3.4, 2.2, 0.03, { cast: false });
  } else {
    const x0 = 28.2, x1 = 31.8, cx = (x0 + x1) / 2;
    batch.box(M.bronze, x0, b.y0, z + 1.8, 0.22, 0.36, 3.6);
    batch.box(M.bronze, x1, b.y0, z + 1.8, 0.22, 0.36, 3.6);
    batch.box(M.bronze, cx, b.y0, z + 3.66, x1 - x0 + 0.22, 0.36, 0.16);
    batch.box(M.stone, cx, b.y0 - 1.15, z + 3.9, x1 - x0 + 1.4, 2.4, 0.26);
    batch.box(M.glowWarm, cx, b.y0 - 1.45, z + 3.74, 1.4, 0.2, 0.03, { cast: false });
    for (let i = 0; i < 2; i++) {
      const sx = x0 + 0.55 + i * ((x1 - x0 - 1.1) / 1);
      batch.box(M.glassRail, sx, b.y0, z + 1.45, (x1 - x0 - 1.2) / 2, 0.04, 2.9, { cast: false });
    }
  }
}

/* A deep, stone-clad entrance canopy on two bronze columns.  Kept out
   of the cut bands: it sits above the double-height lobby sightline, so
   the section still opens cleanly underneath it. */
function buildEntranceCanopy(M, fg, fd) {
  const b = fd.bounds, base = fd.base;
  const g = group(fg, "entrance-podium");
  const bch = new Batcher();
  const cx = -3.8;
  const frontY = b.y0 - 6.0;
  const cw = 10.4;
  const zCan = base + 7.85;

  /* stone canopy plate with a deep bronze fascia and a crisp top frame */
  bch.box(M.stoneWarm, cx, b.y0 - 3.0, zCan + 0.16, cw, 6.0, 0.32);
  bch.box(M.bronzeLight, cx, b.y0 - 5.95, zCan, cw + 0.2, 0.18, 0.44);
  bch.box(M.bronzeLight, cx - cw / 2 + 0.02, b.y0 - 3.0, zCan, 0.18, 5.9, 0.44);
  bch.box(M.bronzeLight, cx + cw / 2 - 0.02, b.y0 - 3.0, zCan, 0.18, 5.9, 0.44);
  bch.box(M.bronze, cx, b.y0 - 5.72, zCan + 0.345, cw - 0.5, 0.14, 0.05, { cast: false });
  bch.box(M.bronze, cx - cw / 2 + 0.32, b.y0 - 3.0, zCan + 0.345, 0.14, 5.5, 0.05, { cast: false });
  bch.box(M.bronze, cx + cw / 2 - 0.32, b.y0 - 3.0, zCan + 0.345, 0.14, 5.5, 0.05, { cast: false });
  bch.box(M.stoneLight, cx, b.y0 - 3.0, zCan + 0.335, 1.2, 5.55, 0.03, { cast: false });
  /* attachment ledger against the portal */
  bch.box(M.bronze, cx, b.y0 - 0.1, zCan - 0.06, cw - 0.3, 0.3, 0.5);
  /* warm downlights wash the entry */
  for (let i = 0; i < 5; i++) {
    bch.box(M.glowWarm, cx - 3.8 + i * 1.9, b.y0 - 3.4, zCan - 0.04,
      0.55, 0.12, 0.03, { cast: false });
  }
  /* columns, with capitals and a stone base */
  for (const x of [cx - 4.45, cx + 4.45]) {
    bch.cyl(M.bronze, x, frontY + 0.55, (base + zCan - 0.2) / 2, 0.3, zCan - base - 0.2);
    bch.box(M.bronzeLight, x, frontY + 0.55, zCan - 0.14, 0.78, 0.78, 0.2);
    bch.box(M.bronzeLight, x, frontY + 0.55, zCan - 0.32, 0.6, 0.6, 0.16);
    bch.box(M.stone, x, frontY + 0.55, base + 0.18, 0.82, 0.82, 0.36);
    bch.box(M.bronzeLight, x, frontY + 0.55, base + 0.38, 0.72, 0.72, 0.06, { cast: false });
    const rod = pipe(M.steel, x, frontY + 0.55, zCan - 0.12,
      x + (x < cx ? 0.9 : -0.9), b.y0 - 0.08, zCan + 4.3, 0.032, 6);
    if (rod) g.add(rod);
  }
  /* stone planters flank the wide entrance steps */
  for (const px of [-10.0, 2.4]) {
    bch.box(M.stone, px, -10.2, base + 0.42, 1.5, 2.5, 0.84);
    bch.box(M.soil, px, -10.2, base + 0.86, 1.3, 2.3, 0.06, { cast: false });
    bch.box(M.hedge, px, -10.2, base + 1.02, 1.2, 2.2, 0.32);
  }
  bch.flush(g);
}

/* ============================================================
   ROOFS
   ============================================================ */

function buildRoofTowerA(world, M, tower, data) {
  const b = data.floors[data.floors.length - 1].bounds;
  const outer = expandBounds(b, { w: 1.0, s: 1.1, e: 0.8, n: 0.8 });
  const roof = data.roof;
  const rg = tower.roofGroup;
  const batch = new Batcher();

  const slab = box(M.concrete, outer.w + 0.4, outer.d + 0.4, 0.66,
    outer.cx, outer.cy, roof - 0.33);
  slab.receiveShadow = true;
  rg.add(slab);
  rg.add(box(M.paving, outer.w + 0.02, outer.d + 0.02, 0.06,
    outer.cx, outer.cy, roof + 0.04, { cast: false }));

  /* parapet with a bronze coping */
  const ph = 1.05, pt = 0.3;
  for (const [x, y, w, d] of [
    [outer.cx, outer.y0, outer.w + 0.08, pt],
    [outer.cx, outer.y1, outer.w + 0.08, pt],
    [outer.x0, outer.cy, pt, outer.d + 0.08],
    [outer.x1, outer.cy, pt, outer.d + 0.08],
  ]) {
    batch.box(M.stoneWarm, x, y, roof + ph / 2, w, d, ph);
    batch.box(M.bronze, x, y, roof + ph + 0.04, w + 0.06, d + 0.06, 0.08);
  }

  /* a planted roof edge on the west and north, a green line above the
     glass when the tower is seen from the plaza */
  const plant = (x, y, w, d) => {
    batch.box(M.planter, x, y, roof + 0.33, w, d, 0.62);
    batch.box(M.soil, x, y, roof + 0.66, Math.max(0.1, w - 0.14), Math.max(0.1, d - 0.14), 0.06, { cast: false });
    batch.box(M.hedge, x, y, roof + 0.86, Math.max(0.1, w - 0.24), Math.max(0.1, d - 0.24), 0.36);
  };
  plant(outer.x0 + 0.78, 0.3, 0.72, outer.d - 5.8);
  plant(-6.2, outer.y1 - 0.78, 5.2, 0.72);

  /* PV array on the west roof */
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      const x = -7.6 + c * 2.55;
      const y = -5.4 + r * 2.6;
      batch.box(M.pv, x, y, roof + 0.78, 2.3, 1.5, 0.06, { rx: 0.17, cast: false });
      batch.box(M.pvFrame, x, y, roof + 0.53, 2.35, 1.55, 0.08, { cast: false });
      for (const s of [-0.9, 0, 0.9]) {
        batch.box(M.steel, x + s, y, roof + 0.28, 0.06, 0.06, 0.56);
      }
    }
  }

  /* plant screen + rooftop units north of the crown */
  for (let i = 0; i < 6; i++) {
    batch.box(M.mullion, 2.3 + i * 0.95, 3.9, roof + 0.85, 0.09, 0.16, 1.7);
  }
  for (const [x, y] of [[3.8, 5.4], [6.2, 5.4]]) {
    batch.box(M.aluminum, x, y, roof + 0.72, 2.0, 1.5, 1.1);
    batch.box(M.darkMetal, x, y, roof + 1.3, 1.8, 1.3, 0.06, { cast: false });
    batch.cyl(M.metal, x - 0.35, y, roof + 1.36, 0.38, 0.05, { cast: false });
    batch.cyl(M.metal, x + 0.45, y, roof + 1.36, 0.38, 0.05, { cast: false });
  }

  /* ---------------- crown ----------------
     A three-stage lantern replaces the single roof box: a solid,
     stone-and-bronze mechanical base, a glowing glass lantern, a smal&shy;ler
     upper lantern, then a floating bronze cap and a slender spire.  Each
     stage steps in, so the top of the tower has a profile of its own
     from every direction. */
  const ccx = 4.9, ccy = -1.0;
  const aw = 9.0, ad = 7.2;
  const az0 = roof + 0.2, az1 = roof + 3.7;

  /* stage A — mechanical base.  Stone drum, deep bronze ribs and tall
     warm slots, capped by a slim dark cornice rather than a wide eave. */
  const aTop = az1 - 0.24;
  const aH = aTop - az0;
  batch.box(M.concreteDark, ccx, ccy, az0 + aH / 2, aw, ad, aH);
  const skin = 0.26;
  batch.box(M.stoneWarm, ccx, ccy - ad / 2 + skin / 2, az0 + aH / 2, aw, skin, aH);
  batch.box(M.stoneWarm, ccx, ccy + ad / 2 - skin / 2, az0 + aH / 2, aw, skin, aH);
  batch.box(M.stoneWarm, ccx - aw / 2 + skin / 2, ccy, az0 + aH / 2, skin, ad - 2 * skin, aH);
  batch.box(M.stoneWarm, ccx + aw / 2 - skin / 2, ccy, az0 + aH / 2, skin, ad - 2 * skin, aH);
  batch.box(M.bronze, ccx, ccy, az0 + 0.24, aw + 0.32, ad + 0.32, 0.48);
  for (let x = ccx - aw / 2 + 0.8; x < ccx + aw / 2 - 0.5; x += 0.95) {
    batch.box(M.bronze, x, ccy - ad / 2 - 0.035, az0 + aH / 2, 0.09, 0.14, aH - 0.55);
    batch.box(M.bronze, x, ccy + ad / 2 + 0.035, az0 + aH / 2, 0.09, 0.14, aH - 0.55);
  }
  for (let y = ccy - ad / 2 + 0.9; y < ccy + ad / 2 - 0.5; y += 1.1) {
    batch.box(M.bronze, ccx - aw / 2 - 0.035, y, az0 + aH / 2, 0.14, 0.09, aH - 0.55);
    batch.box(M.bronze, ccx + aw / 2 + 0.035, y, az0 + aH / 2, 0.14, 0.09, aH - 0.55);
  }
  for (const sx of [-2.45, 0, 2.45]) {
    batch.box(M.glowWarm, ccx + sx, ccy - ad / 2 - 0.03, az0 + 1.85,
      0.16, 0.04, 2.1, { cast: false });
  }
  for (const sy of [-1.35, 1.35]) {
    batch.box(M.glowWarm, ccx + aw / 2 + 0.03, ccy + sy, az0 + 1.85,
      0.04, 0.16, 2.1, { cast: false });
  }
  batch.box(M.darkMetal, ccx, ccy, az1 - 0.12, aw + 0.5, ad + 0.5, 0.24);
  batch.box(M.bronzeLight, ccx, ccy, az1 - 0.015, aw + 0.62, ad + 0.62, 0.05);

  /* stage B — glazed lantern with a fine bronze cage */
  const bw = 6.6, bd = 5.4, bz0 = az1 + 0.08, bz1 = bz0 + 4.2;
  batch.box(M.lanternCore, ccx, ccy, (bz0 + bz1) / 2, bw - 0.7, bd - 0.7, bz1 - bz0 - 0.3);
  for (const [x, y, w, d] of [
    [ccx, ccy - bd / 2, bw, 0.1], [ccx, ccy + bd / 2, bw, 0.1],
    [ccx - bw / 2, ccy, 0.1, bd], [ccx + bw / 2, ccy, 0.1, bd],
  ]) {
    batch.box(M.glassRail, x, y, (bz0 + bz1) / 2, w, d, bz1 - bz0, { cast: false });
  }
  for (const [x, y] of [[ccx - bw / 2, ccy - bd / 2], [ccx + bw / 2, ccy - bd / 2],
    [ccx - bw / 2, ccy + bd / 2], [ccx + bw / 2, ccy + bd / 2]]) {
    batch.box(M.bronze, x, y, (bz0 + bz1) / 2, 0.18, 0.18, bz1 - bz0 + 0.14);
  }
  for (let x = ccx - bw / 2 + 1.0; x < ccx + bw / 2 - 0.4; x += 1.1) {
    batch.box(M.bronze, x, ccy - bd / 2, (bz0 + bz1) / 2, 0.07, 0.18, bz1 - bz0);
    batch.box(M.bronze, x, ccy + bd / 2, (bz0 + bz1) / 2, 0.07, 0.18, bz1 - bz0);
  }
  for (let y = ccy - bd / 2 + 1.0; y < ccy + bd / 2 - 0.4; y += 1.1) {
    batch.box(M.bronze, ccx - bw / 2, y, (bz0 + bz1) / 2, 0.18, 0.07, bz1 - bz0);
    batch.box(M.bronze, ccx + bw / 2, y, (bz0 + bz1) / 2, 0.18, 0.07, bz1 - bz0);
  }
  for (const zz of [bz0 + 1.15, bz1 - 1.15]) {
    for (const [x, y, w, d] of [
      [ccx, ccy - bd / 2 - 0.07, bw - 0.4, 0.05],
      [ccx, ccy + bd / 2 + 0.07, bw - 0.4, 0.05],
      [ccx - bw / 2 - 0.07, ccy, 0.05, bd - 0.4],
      [ccx + bw / 2 + 0.07, ccy, 0.05, bd - 0.4],
    ]) {
      batch.box(M.glowWarm, x, y, zz, w, d, 0.05, { cast: false });
    }
  }
  batch.box(M.darkMetal, ccx, ccy, bz1 + 0.1, bw + 0.42, bd + 0.42, 0.2);
  batch.box(M.bronzeLight, ccx, ccy, bz1 + 0.21, bw + 0.5, bd + 0.5, 0.04);

  /* stage C — upper lantern and a contemporary fin crown.  The fins
     rise above the glass and a shallow cap closes the composition, so
     the tower ends in a lantern instead of a stack of wide roofs. */
  const cw = 4.4, cd = 3.6, cz0 = bz1 + 0.23, glassTop = cz0 + 2.3;
  batch.box(M.lanternCore, ccx, ccy, cz0 + 1.15, cw - 0.6, cd - 0.6, 2.06);
  for (const [x, y, w, d] of [
    [ccx, ccy - cd / 2, cw, 0.08], [ccx, ccy + cd / 2, cw, 0.08],
    [ccx - cw / 2, ccy, 0.08, cd], [ccx + cw / 2, ccy, 0.08, cd],
  ]) {
    batch.box(M.glassRail, x, y, cz0 + 1.15, w, d, 2.3, { cast: false });
  }
  for (const [x, y] of [[ccx - cw / 2, ccy - cd / 2], [ccx + cw / 2, ccy - cd / 2],
    [ccx - cw / 2, ccy + cd / 2], [ccx + cw / 2, ccy + cd / 2]]) {
    batch.box(M.bronze, x, y, cz0 + 1.15, 0.16, 0.16, 2.44);
  }
  for (const [x, y, w, d] of [
    [ccx, ccy - cd / 2 - 0.06, cw - 0.3, 0.05],
    [ccx, ccy + cd / 2 + 0.06, cw - 0.3, 0.05],
    [ccx - cw / 2 - 0.06, ccy, 0.05, cd - 0.3],
    [ccx + cw / 2 + 0.06, ccy, 0.05, cd - 0.3],
  ]) {
    batch.box(M.glowWarm, x, y, cz0 + 0.42, w, d, 0.05, { cast: false });
  }
  const finZ0 = glassTop - 0.35, finZ1 = glassTop + 1.05;
  for (let x = ccx - cw / 2 + 0.32; x <= ccx + cw / 2 - 0.28; x += 0.73) {
    for (const yy of [ccy - cd / 2, ccy + cd / 2]) {
      batch.box(M.bronze, x, yy, (finZ0 + finZ1) / 2, 0.1, 0.4, finZ1 - finZ0);
    }
  }
  for (let y = ccy - cd / 2 + 0.32; y <= ccy + cd / 2 - 0.28; y += 0.73) {
    for (const xx of [ccx - cw / 2, ccx + cw / 2]) {
      batch.box(M.bronze, xx, y, (finZ0 + finZ1) / 2, 0.4, 0.1, finZ1 - finZ0);
    }
  }
  for (const [x, y, w, d] of [
    [ccx, ccy - cd / 2 - 0.14, cw + 0.5, 0.12],
    [ccx, ccy + cd / 2 + 0.14, cw + 0.5, 0.12],
    [ccx - cw / 2 - 0.14, ccy, 0.12, cd + 0.4],
    [ccx + cw / 2 + 0.14, ccy, 0.12, cd + 0.4],
  ]) {
    batch.box(M.bronzeLight, x, y, finZ1 - 0.1, w, d, 0.08);
  }
  batch.box(M.darkMetal, ccx, ccy, finZ1 + 0.165, 5.4, 4.4, 0.35);

  /* spire */
  const mz = data.mast;
  const spire = cylinder(M.metal, 0.025, 0.14, mz - data.crown, ccx, ccy,
    (data.crown + mz) / 2, 10, { rx: PI / 2 });
  rg.add(spire);
  for (const zz of [data.crown + 1.4, data.crown + 3.8, data.crown + 6.6]) {
    batch.cyl(M.bronzeLight, ccx, ccy, zz, 0.2, 0.06, { cast: false });
  }
  const beaconMat = M.glowRed.clone();
  const beacon = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 1), beaconMat);
  beacon.position.set(ccx, ccy, mz - 0.05);
  rg.add(beacon);
  /* aviation lights on the parapet corners */
  for (const [x, y] of [[outer.x0, outer.y0], [outer.x1, outer.y1]]) {
    const al = box(M.glowRed, 0.09, 0.09, 0.09, x, y, roof + ph + 0.12,
      { cast: false, receive: false });
    rg.add(al);
  }

  batch.flush(rg);

  /* roof pick — present in the building view */
  const pick = box(M.darkMetal, b.w - 0.3, b.d - 0.3, 0.35, b.cx, b.cy, roof + 0.2,
    { cast: false, receive: false });
  pick.visible = false;
  rg.add(pick);
  tagPick(world, pick, "roofs", "roof-b1", "roof", ["building"], { buildingId: "b1" });
}

function buildRoofAnnex(world, M, tower, data) {
  const b = data.floors[0].bounds;
  const roof = data.roof;
  const rg = tower.roofGroup;
  const batch = new Batcher();
  const slab = box(M.concrete, b.w + 0.5, b.d + 0.5, 0.5, b.cx, b.cy, roof - 0.25);
  slab.receiveShadow = true;
  rg.add(slab);
  rg.add(box(M.paving, b.w + 0.2, b.d + 0.2, 0.05, b.cx, b.cy, roof + 0.03, { cast: false }));
  const ph = 0.95, pt = 0.26;
  for (const [x, y, w, d] of [[b.cx, b.y0, b.w + 0.5, pt], [b.cx, b.y1, b.w + 0.5, pt],
    [b.x0, b.cy, pt, b.d + 0.5], [b.x1, b.cy, pt, b.d + 0.5]]) {
    batch.box(M.stone, x, y, roof + ph / 2, w, d, ph);
    batch.box(M.metal, x, y, roof + ph + 0.03, w + 0.05, d + 0.05, 0.05);
  }
  for (const [x, y] of [[38.0, 4.6], [40.4, 4.6]]) {
    batch.box(M.aluminum, x, y, roof + 0.62, 1.9, 1.4, 0.9);
    batch.box(M.darkMetal, x, y, roof + 1.1, 1.7, 1.2, 0.05, { cast: false });
  }
  /* crown: a small glazed lantern */
  const cx = 34.5, cy = 0.5, w = 3.0, d = 3.0;
  for (const [x, y] of [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2],
    [cx - w / 2, cy + d / 2], [cx + w / 2, cy + d / 2]]) {
    batch.box(M.bronze, x, y, (roof + data.crown) / 2, 0.16, 0.16, data.crown - roof);
  }
  for (const [x, y, ww, dd] of [[cx, cy - d / 2, w, 0.05], [cx, cy + d / 2, w, 0.05],
    [cx - w / 2, cy, 0.05, d], [cx + w / 2, cy, 0.05, d]]) {
    batch.box(M.glassRail, x, y, roof + 0.62, ww, dd, 1.0, { cast: false });
  }
  batch.box(M.bronze, cx, cy, data.crown - 0.12, w + 0.3, d + 0.3, 0.24);
  batch.box(M.glowWarm, cx, cy, roof + 0.7, w - 0.9, 0.16, 0.05, { cast: false });
  batch.flush(rg);

  const pick = box(M.darkMetal, b.w - 0.3, b.d - 0.3, 0.3, b.cx, b.cy, roof + 0.16,
    { cast: false, receive: false });
  pick.visible = false;
  rg.add(pick);
  tagPick(world, pick, "roofs", "roof-b2", "roof", ["building"], { buildingId: "b2" });
}
