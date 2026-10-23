/* ============================================================
   TWIN3D — interior fit-out
   ------------------------------------------------------------
   Human-scale rooms: finishes, suspended ceilings, task lighting,
   real desks/chairs, meeting tables, a double-height lobby and a
   working technical server room with a contained cold aisle.

   Everything here is procedural and batched.  A floor's loose
   furniture is flushed into a handful of InstancedMeshes by the
   `Batcher`, so the detail does not cost hundreds of draw calls.

   Device ids created here (all existing system ids):
     lt-<roomId>  lighting group          pl-<roomId>  socket group
     fc-<floorId> floor FCU (plenum)      ups-b1       UPS cabinet
     wh-b2        water heater
   ============================================================ */

"use strict";

import * as THREE from "./vendor/three.module.js";
import { canvasTexture } from "./twin3d-kit.js";

/* ---------------- shared little textures / materials ---------------- */

let artTex = null, boardTex = null;
function getArtTexture() {
  if (artTex) return artTex;
  artTex = canvasTexture(320, 400, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#2c3b45");
    grad.addColorStop(0.5, "#59636a");
    grad.addColorStop(1, "#9a8368");
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const cols = ["rgba(220,190,150,0.5)", "rgba(120,150,160,0.45)", "rgba(60,70,72,0.6)", "rgba(230,230,220,0.35)"];
    for (let i = 0; i < 7; i++) {
      g.fillStyle = cols[i % cols.length];
      g.beginPath();
      const y = Math.random() * h * 0.8 + h * 0.1;
      g.ellipse(Math.random() * w, y, 20 + Math.random() * 90, 40 + Math.random() * 140, Math.random() * 0.6, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = "rgba(20,24,26,0.5)"; g.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      g.beginPath(); g.moveTo(Math.random() * w, 0); g.lineTo(Math.random() * w, h); g.stroke();
    }
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
  }, 1, 1);
  return artTex;
}
function getBoardTexture() {
  if (boardTex) return boardTex;
  boardTex = canvasTexture(360, 220, (g, w, h) => {
    g.fillStyle = "#f2f1ec"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(40,60,80,0.5)"; g.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) {
      g.beginPath(); g.moveTo(18, 20 + i * 7); g.lineTo(w - 20, 20 + i * 7); g.stroke();
    }
    g.strokeStyle = "rgba(60,110,140,0.7)";
    g.strokeRect(24, 60, 90, 46);
    g.strokeRect(130, 60, 60, 46);
    g.strokeRect(206, 60, 90, 46);
    g.beginPath(); g.moveTo(114, 83); g.lineTo(130, 83); g.stroke();
    g.beginPath(); g.moveTo(190, 83); g.lineTo(206, 83); g.stroke();
    const note = ["#e5d36a", "#e5a86a", "#9fc4d4"];
    for (let i = 0; i < 6; i++) {
      g.fillStyle = note[i % 3];
      g.fillRect(24 + (i % 3) * 112, 132 + Math.floor(i / 3) * 44, 34, 28);
    }
    g.fillStyle = "rgba(30,40,48,0.45)";
    for (let i = 0; i < 22; i++) g.fillRect(32 + Math.random() * 300, 26 + Math.random() * 28, 14, 1);
  }, 1, 1);
  return boardTex;
}

const mirrorMat = () => new THREE.MeshStandardMaterial({
  color: 0xc7d4d9, metalness: 0.95, roughness: 0.06, envMapIntensity: 1.8,
});

/* ---------------- small placement helpers ---------------- */

function lp(cx, cy, ry, lx, ly) {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [cx + lx * c - ly * s, cy + lx * s + ly * c];
}

function lb(b, mat, cx, cy, ry, lx, ly, z, w, d, h, opts) {
  const [x, y] = lp(cx, cy, ry, lx, ly);
  /* The scene is Z-up, so a yaw is a rotation about Z (rotation.y would
     tip the piece sideways). */
  b.box(mat, x, y, z, w, d, h, Object.assign({ ry: 0, rx: 0, rz: ry }, opts || {}));
}

function lmesh(THREE_, parent, mat, geo, x, y, z, rx, ry, rz) {
  const m = new THREE_.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (rx) m.rotation.x = rx;
  if (ry) m.rotation.y = ry;
  if (rz) m.rotation.z = rz;
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/* ---------------- fit-out catalogue ---------------- */

function taskChair(ctx, x, y, z, face, kind) {
  const { M, batch: b } = ctx;
  const seatMat = kind === "exec" ? M.leather : (kind === "guest" ? M.fabric : M.fabricDark);
  const backMat = kind === "exec" ? M.leather : (kind === "guest" ? M.fabric : M.fabricBlue);
  const backH = kind === "exec" ? 0.72 : 0.5;
  lb(b, seatMat, x, y, face, 0, 0, z + 0.46, 0.5, 0.48, 0.08);
  lb(b, backMat, x, y, face, 0, -0.22, z + 0.48 + backH / 2, 0.46, 0.07, backH);
  if (kind === "exec") {
    lb(b, M.leather, x, y, face, -0.28, -0.06, z + 0.62, 0.05, 0.34, 0.05);
    lb(b, M.leather, x, y, face, 0.28, -0.06, z + 0.62, 0.05, 0.34, 0.05);
  }
  b.cyl(M.darkMetal, x, y, z + 0.22, 0.035, 0.34);
  lb(b, M.darkMetal, x, y, face, 0, 0, z + 0.06, 0.62, 0.06, 0.04, { rz: Math.PI / 4 });
  lb(b, M.darkMetal, x, y, face, 0, 0, z + 0.06, 0.62, 0.06, 0.04, { rz: -Math.PI / 4 });
  for (const [ox, oy] of [[-0.22, -0.16], [0.22, -0.16], [-0.22, 0.16], [0.22, 0.16]]) {
    const [wx, wy] = lp(x, y, face, ox, oy);
    b.sphere(M.darkMetal, wx, wy, z + 0.035, 0.035);
  }
}

function sideChair(ctx, x, y, z, face, mat) {
  const { M, batch: b } = ctx;
  const m = mat || M.fabric;
  lb(b, m, x, y, face, 0, 0, z + 0.46, 0.46, 0.44, 0.06);
  lb(b, m, x, y, face, 0, -0.21, z + 0.72, 0.44, 0.05, 0.42);
  for (const [ox, oy] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]]) {
    lb(b, M.walnut, x, y, face, ox, oy, z + 0.23, 0.035, 0.035, 0.46);
  }
}

function monitor(ctx, x, y, z, face, w, h, tilt) {
  const { M, batch: b } = ctx;
  const W = w || 0.58, H = h || 0.34;
  lb(b, M.screenDark, x, y, face, 0, 0.12, z, W + 0.02, 0.035, H + 0.02);
  lb(b, M.screen, x, y, face, 0, 0.098, z, W, 0.006, H);
  lb(b, M.darkMetal, x, y, face, 0, 0.1, z - H / 2 - 0.09, 0.05, 0.05, 0.2);
  lb(b, M.darkMetal, x, y, face, 0, 0.1, z - H / 2 - 0.19, 0.3, 0.18, 0.02);
}

function desk(ctx, x, y, z, face, w, d, opts) {
  const { M, batch: b } = ctx;
  const o = opts || {};
  lb(b, M.deskTop, x, y, face, 0, 0, z + 0.74, w, d, 0.045);
  lb(b, M.metal, x, y, face, -w / 2 + 0.07, 0, z + 0.36, 0.055, d - 0.16, 0.72);
  lb(b, M.metal, x, y, face, w / 2 - 0.07, 0, z + 0.36, 0.055, d - 0.16, 0.72);
  lb(b, M.deskTop, x, y, face, 0, d / 2 - 0.04, z + 0.47, w - 0.16, 0.03, 0.4);
  if (o.drawers !== false) {
    lb(b, M.cabinet, x, y, face, w / 2 - 0.32, -0.02, z + 0.3, 0.4, d - 0.18, 0.6);
  }
  monitor(ctx, ...lp(x, y, face, 0, 0.17), z + 1.08, face, o.screenW, o.screenH);
  // keyboard + mouse + a few personal things
  lb(b, M.blackMetal, x, y, face, 0, -0.08, z + 0.77, 0.36, 0.13, 0.015);
  lb(b, M.blackMetal, x, y, face, 0.3, -0.08, z + 0.77, 0.06, 0.1, 0.02);
  lb(b, M.ceramic, x, y, face, -0.28, -0.02, z + 0.8, 0.07, 0.07, 0.09);
  if (o.lamp !== false) {
    const [lx, ly] = lp(x, y, face, -w / 2 + 0.22, d / 2 - 0.2);
    b.cyl(M.blackMetal, lx, ly, z + 0.9, 0.018, 0.32);
    b.cyl(M.blackMetal, lx, ly, z + 1.06, 0.09, 0.05);
    b.cyl(M.glowSoft, lx, ly, z + 1.035, 0.07, 0.008);
  }
  if (o.plant !== false) {
    const [px, py] = lp(x, y, face, w / 2 - 0.24, d / 2 - 0.16);
    b.cyl(M.planter, px, py, z + 0.81, 0.055, 0.09);
    b.sphere(M.leafLight, px, py, z + 0.9, 0.07);
  }
  taskChair(ctx, ...lp(x, y, face, 0, -0.82), z, face, o.seat);
}

function plant(ctx, x, y, z, s, kind) {
  const { M, batch: b } = ctx;
  const sc = s || 1;
  b.cyl(M.planter, x, y, z + 0.2 * sc, 0.2 * sc, 0.4 * sc);
  b.cyl(M.trunk, x, y, z + 0.72 * sc, 0.028 * sc, 0.72 * sc);
  const leaves = kind === "desk" ? 1 : 5;
  for (let i = 0; i < leaves; i++) {
    const a = (i / Math.max(1, leaves)) * Math.PI * 2;
    const rr = leaves === 1 ? 0 : 0.19 * sc;
    const mat = i % 3 === 0 ? M.leaf : (i % 3 === 1 ? M.leafDark : M.leafLight);
    b.sphere(mat, x + Math.cos(a) * rr, y + Math.sin(a) * rr,
      z + (0.95 + (i % 3) * 0.14) * sc, (0.2 + (i % 2) * 0.06) * sc);
  }
}

function rug(ctx, x, y, z, w, d, mat) {
  ctx.batch.box(mat || ctx.M.rug, x, y, z + 0.012, w, d, 0.02, { cast: false });
}

function sofa(ctx, x, y, z, face, w) {
  const { M, batch: b } = ctx;
  const W = w || 2.3;
  lb(b, M.fabric, x, y, face, 0, 0, z + 0.2, W, 0.92, 0.32);
  lb(b, M.fabric, x, y, face, 0, -0.33, z + 0.55, W, 0.26, 0.4);
  lb(b, M.fabric, x, y, face, -W / 2 + 0.12, 0, z + 0.46, 0.24, 0.92, 0.5);
  lb(b, M.fabric, x, y, face, W / 2 - 0.12, 0, z + 0.46, 0.24, 0.92, 0.5);
  const n = W > 2.4 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    lb(b, M.fabricLight, x, y, face, (i - (n - 1) / 2) * (W - 0.5) / n, 0.06, z + 0.43, (W - 0.5) / n - 0.04, 0.78, 0.14);
  }
  for (const ox of [-W / 2 + 0.25, W / 2 - 0.25]) {
    lb(b, M.walnut, x, y, face, ox, -0.3, z + 0.06, 0.07, 0.07, 0.12);
    lb(b, M.walnut, x, y, face, ox, 0.3, z + 0.06, 0.07, 0.07, 0.12);
  }
}

function armchair(ctx, x, y, z, face) {
  const { M, batch: b } = ctx;
  lb(b, M.leather, x, y, face, 0, 0, z + 0.22, 0.82, 0.82, 0.34);
  lb(b, M.leather, x, y, face, 0, -0.31, z + 0.55, 0.8, 0.22, 0.4);
  lb(b, M.leather, x, y, face, -0.36, 0, z + 0.44, 0.18, 0.82, 0.46);
  lb(b, M.leather, x, y, face, 0.36, 0, z + 0.44, 0.18, 0.82, 0.46);
  lb(b, M.fabricLight, x, y, face, 0, 0.04, z + 0.43, 0.5, 0.56, 0.12);
  for (const ox of [-0.32, 0.32]) for (const oy of [-0.3, 0.3]) {
    lb(b, M.walnut, x, y, face, ox, oy, z + 0.05, 0.05, 0.05, 0.1);
  }
}

function coffeeTable(ctx, x, y, z) {
  const { M, batch: b } = ctx;
  lb(b, M.walnut, x, y, 0, 0, 0, z + 0.38, 1.1, 0.6, 0.05);
  lb(b, M.metal, x, y, 0, -0.42, 0, z + 0.19, 0.04, 0.5, 0.38);
  lb(b, M.metal, x, y, 0, 0.42, 0, z + 0.19, 0.04, 0.5, 0.38);
  lb(b, M.ceramic, x, y, 0, 0.1, 0.02, z + 0.43, 0.16, 0.1, 0.06);
}

function pendant(cx, cy, zTop, zBottom, ceilZ) {
  const g = new THREE.Group();
  const ringGeo = new THREE.TorusGeometry(1.25, 0.028, 8, 48);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2b, metalness: 0.8, roughness: 0.35 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(cx, cy, zTop - 0.2);
  ring.castShadow = true;
  g.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.022, 8, 40), ringMat);
  ring2.position.set(cx, cy, zTop - 0.8);
  g.add(ring2);
  const globes = [
    [-0.55, 0.2, 0.0], [0.4, -0.35, -0.5], [0.72, 0.4, -0.9],
    [-0.25, -0.5, -1.2], [-0.85, -0.25, -1.5], [0.2, 0.55, -1.7],
    [0.9, -0.1, -2.1], [-0.4, 0.45, -2.4],
  ];
  const globeMat = new THREE.MeshStandardMaterial({
    color: 0xfff0d5, emissive: 0xffc27a, emissiveIntensity: 2.4,
    roughness: 0.2, metalness: 0.0, transparent: true, opacity: 0.95,
  });
  for (const [ox, oy, dz] of globes) {
    const gm = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), globeMat);
    gm.position.set(cx + ox, cy + oy, zTop + dz);
    g.add(gm);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, Math.abs(dz) + 0.4, 5), ringMat);
    cable.rotation.x = Math.PI / 2;
    cable.position.set(cx + ox, cy + oy, zTop + dz / 2 + 0.2);
    g.add(cable);
  }
  const topRing = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.015, 6, 40), ringMat);
  topRing.position.set(cx, cy, zTop + 0.15);
  g.add(topRing);
  if (ceilZ && ceilZ > zTop + 0.5) {
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, ceilZ - zTop - 0.35, 8), ringMat);
    stem.rotation.x = Math.PI / 2;
    stem.position.set(cx, cy, (zTop + 0.35 + ceilZ) / 2);
    g.add(stem);
    const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.06, 20), ringMat);
    canopy.rotation.x = Math.PI / 2;
    canopy.position.set(cx, cy, ceilZ - 0.03);
    g.add(canopy);
  }
  return { group: g, anchor: new THREE.Vector3(cx, cy, zTop - 0.9) };
}

function linearLightGroup(ctx, room, items, parent) {
  const g = new THREE.Group();
  g.name = "light-" + room.id;
  for (const it of items) {
    const housing = new THREE.Mesh(
      new THREE.BoxGeometry(it.w + 0.06, it.d + 0.06, 0.055),
      ctx.M.blackMetal);
    housing.position.set(it.x, it.y, it.z + 0.03);
    housing.castShadow = false;
    g.add(housing);
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(it.w, it.d, 0.014),
      room.ltMat);
    lens.position.set(it.x, it.y, it.z - 0.005);
    g.add(lens);
  }
  parent.add(g);
  const anchor = new THREE.Vector3(items[0].x, items[0].y, items[0].z - 0.12);
  const dev = room.addDevice("lt-" + room.id, g, anchor, room.floorId, room.id, "LIGHTING");
  room.registerStatusMat(dev, room.ltMat);
  for (const it of items) {
    const proxy = new THREE.Mesh(
      new THREE.BoxGeometry(it.w + 0.1, it.d + 0.1, 0.2),
      ctx.M.darkMetal);
    proxy.position.set(it.x, it.y, it.z);
    proxy.visible = false;
    g.add(proxy);
    room.tagPick(proxy, "devices", "lt-" + room.id, "device",
      ["building", "floor", "room"], { floorId: room.floorId, roomId: room.id });
  }
  room.lightGroup = g;
}

function socketGroup(ctx, room) {
  const g = new THREE.Group();
  const side = { S: "N", N: "S", E: "W", W: "E" }[room.entry] || "N";
  const rect = room.rect, base = room.base;
  const pts = [];
  const alongY = side === "N" || side === "S";
  if (alongY) {
    const y = side === "N" ? rect.y1 - 0.08 : rect.y0 + 0.08;
    pts.push([rect.x0 + 0.6, y], [rect.x0 + 1.05, y]);
  } else {
    const x = side === "E" ? rect.x1 - 0.08 : rect.x0 + 0.08;
    pts.push([x, rect.y0 + 0.6], [x, rect.y0 + 1.05]);
  }
  for (const [x, y] of pts) {
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(alongY ? 0.11 : 0.045, alongY ? 0.045 : 0.11, 0.14),
      ctx.M.ceramic);
    plate.position.set(x, y, base + 0.32);
    g.add(plate);
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.012, 0.02), room.plMat);
    led.position.set(x + (alongY ? 0.03 : 0), y + (alongY ? -0.026 : -0.03), base + 0.375);
    g.add(led);
  }
  room.group.add(g);
  const first = pts[0];
  const dev = room.addDevice("pl-" + room.id, g,
    new THREE.Vector3(first[0], first[1], base + 0.5),
    room.floorId, room.id, "PLUGS");
  room.registerStatusMat(dev, room.plMat);
  for (const [x, y] of pts) {
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.34), ctx.M.darkMetal);
    proxy.position.set(x, y, base + 0.32);
    proxy.visible = false;
    g.add(proxy);
    room.tagPick(proxy, "devices", "pl-" + room.id, "device",
      ["building", "floor", "room"], { floorId: room.floorId, roomId: room.id });
  }
}

/* ---------------- finishes ---------------- */

function roomFinish(room) {
  const u = room.usage;
  if (room.name === "Server Room") return { mat: "esd", ceil: 3.5, carpet: false };
  if (room.name === "Lobby" || room.name === "Reception") return { mat: "stone", ceil: 8.6, carpet: false };
  if (room.name === "Executive Suite") return { mat: "wood", ceil: 4.6, carpet: false };
  if (room.name === "Pantry") return { mat: "tile", ceil: 3.4, carpet: false };
  if (room.name === "Restrooms") return { mat: "tile", ceil: 3.4, carpet: false };
  if (u === "storage") return { mat: "concrete", ceil: 3.4, carpet: false };
  if (u === "meeting") return { mat: "carpetWarm", ceil: 4.6, carpet: true };
  return { mat: "carpet", ceil: 4.6, carpet: true };
}

function finishRoom(ctx, room, spec, opts) {
  const { M } = ctx;
  const r = room.rect, base = room.base;
  const o = opts || {};
  const mat = M[spec.mat] || M.carpet;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(r.w - 0.06, r.d - 0.06), mat);
  floor.position.set(r.cx, r.cy, base + 0.028);
  floor.receiveShadow = true;
  room.group.add(floor);

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(r.w - 0.08, r.d - 0.08), ctx.ceilingMat);
  ceil.rotation.x = Math.PI;
  ceil.position.set(r.cx, r.cy, base + spec.ceil);
  room.ceilGroup.add(ceil);
  room.ceilingH = base + spec.ceil;

  if (o.cove !== false) {
    const coveY = spec.ceil - 0.1;
    const coveMat = ctx.coveMat;
    const strips = [
      [r.cx, r.y0 + 0.15, r.w - 0.6, 0.08],
      [r.cx, r.y1 - 0.15, r.w - 0.6, 0.08],
    ];
    for (const [x, y, w, d] of strips) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, 0.03), coveMat);
      m.position.set(x, y, base + coveY);
      m.castShadow = false;
      room.ceilGroup.add(m);
    }
  }
  if (o.rug) {
    rug(ctx, r.cx, r.cy, base, Math.min(r.w - 2, o.rug[0]), Math.min(r.d - 2, o.rug[1]), o.rugMat);
  }
}

function defaultLinearLights(ctx, room, spec, axes) {
  const r = room.rect, base = room.base;
  const z = base + spec.ceil - 0.06;
  const items = [];
  if (axes === "y") {
    const cols = Math.max(1, Math.round(r.w / 3.2));
    for (let i = 0; i < cols; i++) {
      items.push({ x: r.x0 + (i + 0.5) * r.w / cols, y: r.cy, z, w: 0.16, d: Math.min(2.2, r.d * 0.45) });
    }
  } else {
    const rows = Math.max(1, Math.round(r.d / 3.2));
    for (let i = 0; i < rows; i++) {
      items.push({ x: r.cx, y: r.y0 + (i + 0.5) * r.d / rows, z, w: Math.min(2.4, r.w * 0.4), d: 0.16 });
    }
  }
  linearLightGroup(ctx, room, items, room.group);
}

/* ---------------- room types ---------------- */

function officeRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs);
  defaultLinearLights(ctx, room, specs, "y");

  const n = r.w > 9 ? 4 : 3;
  const gap = 1.95;
  const startX = r.cx - ((n - 1) * gap) / 2;
  const aisle = Math.min(2.4, r.d * 0.32);
  for (let i = 0; i < n; i++) {
    const x = startX + i * gap;
    desk(ctx, x, r.cy + aisle / 2 + 0.05, base, Math.PI, 1.55, 0.72, { plant: i % 2 === 0 });
    desk(ctx, x, r.cy - aisle / 2 - 0.05, base, 0, 1.55, 0.72, { plant: i % 2 === 1 });
  }
  // central low planter / cable spine
  lb(b, M.planter, r.cx, r.cy, 0, 0, 0, base + 0.18, Math.max(1.2, r.w - 2.4), 0.24, 0.36);
  for (let i = 0; i < Math.max(2, Math.round(r.w / 4)); i++) {
    plant(ctx, r.x0 + 1.0 + i * (r.w - 2) / Math.max(1, Math.round(r.w / 4) - 1), r.cy, base + 0.36, 0.32);
  }

  // credenza on the wall opposite the entry
  const side = { S: "N", N: "S", E: "W", W: "E" }[room.entry] || "N";
  const cx = side === "W" ? r.x0 + 0.32 : (side === "E" ? r.x1 - 0.32 : r.cx);
  const cy = side === "N" ? r.y1 - 0.32 : (side === "S" ? r.y0 + 0.32 : r.cy);
  if (side === "N" || side === "S") {
    const along = Math.min(3.2, r.w - 2);
    lb(b, M.cabinet, r.cx, cy, 0, 0, 0, base + 0.36, along, 0.5, 0.72);
    lb(b, M.stoneLight, r.cx, cy, 0, 0, 0, base + 0.735, along + 0.04, 0.54, 0.03);
    lb(b, M.blackMetal, r.cx + along / 2 - 0.5, cy, 0, 0, 0, base + 0.78, 0.5, 0.35, 0.1);
    const artMat = new THREE.MeshStandardMaterial({ map: getArtTexture(), roughness: 0.7 });
    const art = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.02, 1.1), artMat);
    art.position.set(r.cx - 0.2, cy + (side === "N" ? -0.06 : 0.06), base + 2.0);
    room.group.add(art);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.04, 1.2), M.bronze);
    frame.position.set(r.cx - 0.2, cy + (side === "N" ? -0.1 : 0.1), base + 2.0);
    room.group.add(frame);
  } else {
    lb(b, M.cabinet, cx, r.cy, 0, 0, 0, base + 0.36, 0.5, 2.8, 0.72);
    lb(b, M.stoneLight, cx, r.cy, 0, 0, 0, base + 0.735, 0.54, 2.84, 0.03);
  }

  // whiteboard (keep it off the door wall) + phone booth
  const boardNorth = room.door === "S";
  const bwx = r.x0 + 1.35;
  const bwy = boardNorth ? r.y1 - 0.12 : r.y0 + 0.12;
  const bdir = boardNorth ? -1 : 1;
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.02, 1.25),
    new THREE.MeshStandardMaterial({ map: getBoardTexture(), roughness: 0.8 }));
  board.position.set(bwx, bwy + bdir * 0.05, base + 1.9);
  room.group.add(board);
  const bf = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 1.35), M.aluminum);
  bf.position.set(bwx, bwy, base + 1.9);
  room.group.add(bf);

  if (r.w >= 10.5) {
    const px = r.x1 - 1.0, py = r.y1 - 1.15;
    const booth = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.12, 2.25), M.glassRail);
    booth.position.set(px, py, base + 1.125);
    booth.castShadow = false;
    room.group.add(booth);
    for (const [ox, oy] of [[-0.54, -0.54], [0.54, -0.54], [-0.54, 0.54], [0.54, 0.54]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 2.28), M.mullion);
      post.position.set(px + ox, py + oy, base + 1.14);
      room.group.add(post);
    }
    lb(b, M.wood, px, py, 0, 0, 0, base + 0.74, 0.5, 0.5, 0.04);
    taskChair(ctx, px, py + 0.02, base, 0);
    b.box(M.carpetDark, px, py, base + 0.03, 1.0, 1.0, 0.02, { cast: false });
  }

  // acoustic baffles (live with the ceiling so the cutaway reads cleanly)
  for (let i = 0; i < 3; i++) {
    const baffle = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.55), M.fabricDark);
    baffle.position.set(r.x0 + 2.2 + i * 2.4, r.cy + aisle / 2 + 1.45, base + specs.ceil - 0.55);
    baffle.castShadow = true;
    room.ceilGroup.add(baffle);
  }

  socketGroup(ctx, room);
}

function meetingRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs, { rug: [Math.min(r.w - 1.6, 5.2), Math.min(r.d - 1.6, 4.4)], rugMat: M.rug });

  const tw = Math.min(3.6, r.w - 2.4), td = 1.25;
  const shape = new THREE.Shape();
  const rr = 0.35, hw = tw / 2, hd = td / 2;
  shape.moveTo(-hw + rr, -hd);
  shape.lineTo(hw - rr, -hd); shape.quadraticCurveTo(hw, -hd, hw, -hd + rr);
  shape.lineTo(hw, hd - rr); shape.quadraticCurveTo(hw, hd, hw - rr, hd);
  shape.lineTo(-hw + rr, hd); shape.quadraticCurveTo(-hw, hd, -hw, hd - rr);
  shape.lineTo(-hw, -hd + rr); shape.quadraticCurveTo(-hw, -hd, -hw + rr, -hd);
  const topGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.055, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, curveSegments: 8 });
  const top = new THREE.Mesh(topGeo, M.walnut);
  top.position.set(r.cx, r.cy, base + 0.72);
  top.castShadow = true;
  top.receiveShadow = true;
  room.group.add(top);
  b.box(M.darkMetal, r.cx, r.cy, base + 0.36, 0.18, 0.18, 0.72);
  b.box(M.metal, r.cx, r.cy, base + 0.04, 0.8, 0.5, 0.06);

  const seats = 3;
  for (let i = 0; i < seats; i++) {
    const ox = (i - (seats - 1) / 2) * (tw - 0.7) / seats;
    sideChair(ctx, r.cx + ox, r.cy + hd + 0.38, base, Math.PI);
    sideChair(ctx, r.cx + ox, r.cy - hd - 0.38, base, 0);
  }
  sideChair(ctx, r.cx - hw - 0.4, r.cy, base, -Math.PI / 2);
  sideChair(ctx, r.cx + hw + 0.4, r.cy, base, Math.PI / 2);
  b.cyl(M.ceramic, r.cx - 0.3, r.cy, base + 0.83, 0.09, 0.16);
  b.cyl(M.ceramic, r.cx + 0.05, r.cy + 0.15, base + 0.8, 0.055, 0.1);
  b.box(M.blackMetal, r.cx + 0.4, r.cy - 0.12, base + 0.78, 0.2, 0.2, 0.03);

  // display on the far wall (opposite the door / entry)
  const side = { S: "N", N: "S", E: "W", W: "E" }[room.entry] || "N";
  if (side === "N" || side === "S") {
    const y = side === "N" ? r.y1 - 0.15 : r.y0 + 0.15;
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.04, 1.0), M.screen);
    screen.position.set(r.cx, y, base + 1.75);
    room.group.add(screen);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.05, 1.1), M.blackMetal);
    frame.position.set(r.cx, y + (side === "N" ? -0.03 : 0.03), base + 1.75);
    room.group.add(frame);
    lb(b, M.cabinet, r.cx, y, 0, 0, 0, base + 0.36, 2.0, 0.42, 0.72);
    lb(b, M.glowSoft, r.cx, y, 0, 0, 0, base + 0.78, 2.0, 0.05, 0.02);
  } else {
    /* East / west entries look across the table at a side wall: mount the
       screen there so every meeting room reads as a working space. */
    const x = side === "W" ? r.x0 + 0.15 : r.x1 - 0.15;
    const toWall = side === "W" ? -0.03 : 0.03;
    const ry = side === "W" ? -Math.PI / 2 : Math.PI / 2;
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.04, 1.0), M.screen);
    screen.position.set(x, r.cy, base + 1.75);
    screen.rotation.z = ry;
    room.group.add(screen);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.05, 1.1), M.blackMetal);
    frame.position.set(x + toWall, r.cy, base + 1.75);
    frame.rotation.z = ry;
    room.group.add(frame);
    lb(b, M.cabinet, x, r.cy, ry, 0, 0.21, base + 0.36, 2.0, 0.42, 0.72);
    lb(b, M.glowSoft, x, r.cy, ry, 0, 0.42, base + 0.78, 2.0, 0.05, 0.02);
    // acoustic felt panels flank the screen instead of covering it
    for (const yy of [r.cy - 1.75, r.cy + 1.75]) {
      lb(b, M.bronze, x + toWall, yy, 0, 0, 0, base + 2.45, 0.03, 0.8, 1.44);
      lb(b, M.fabricBlue, x, yy, 0, 0, 0, base + 2.45, 0.04, 0.68, 1.3);
    }
  }
  if (side !== "W" && side !== "E") {
    // acoustic felt panels on the free side wall
    const px = r.x0 + 0.13;
    for (let i = 0; i < 5; i++) {
      lb(b, M.fabricBlue, px, r.y0 + 1.2 + i * 0.85, 0, 0, 0, base + 2.4, 0.04, 0.68, 1.6);
    }
  }
  plant(ctx, r.x1 - 0.75, r.y1 - 0.75, base, 0.95);
  const pend = [
    { x: r.cx, y: r.cy, z: base + specs.ceil - 0.75, w: tw - 0.7, d: 0.16 },
  ];
  linearLightGroup(ctx, room, pend, room.group);
  socketGroup(ctx, room);
}

function lobbyRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs, { cove: false });
  rug(ctx, r.x0 + 4.2, r.cy + 1.8, base, 5.4, 4.2, M.rug);

  /* reception: a gently curved stone counter on the east side */
  const rx = r.x1 - 1.35, ry = r.cy + 0.4;
  for (let i = -2; i <= 2; i++) {
    const segY = ry + i * 1.0;
    const off = Math.abs(i) * 0.11;
    lb(b, M.stone, rx + off, segY, 0, 0, 0, base + 0.52, 0.92, 1.02, 1.04);
    lb(b, M.marble, rx + off, segY, 0, 0, 0, base + 1.06, 1.02, 1.04, 0.06);
    lb(b, M.walnut, rx + off - 0.43, segY, 0, 0, 0, base + 0.58, 0.06, 0.92, 0.92);
  }
  // slatted feature wall behind reception
  const wx = r.x1 - 0.12;
  const nSlat = Math.max(1, Math.floor((r.d - 1.0) / 0.3));
  for (let i = 0; i < nSlat; i++) {
    const yy = r.y0 + 0.5 + i * 0.3;
    lb(b, M.walnut, wx - 0.07, yy, 0, 0, 0, base + 3.1, 0.1, 0.13, 6.2);
  }
  lb(b, M.glowWarm, wx - 0.03, ry, 0, 0, 0, base + 5.9, 0.02, 8.6, 0.06);
  lb(b, M.bronze, wx - 0.16, ry, 0, 0, 0, base + 2.9, 0.03, 2.3, 1.15);
  lb(b, M.stoneLight, wx - 0.18, ry, 0, 0, 0, base + 2.9, 0.02, 2.0, 0.85);
  monitor(ctx, wx - 0.75, ry - 0.7, base + 1.32, -Math.PI / 2, 0.55, 0.33);
  monitor(ctx, wx - 0.75, ry + 0.7, base + 1.32, -Math.PI / 2, 0.55, 0.33);
  b.cyl(M.ceramic, wx - 0.7, ry + 2.0, base + 1.2, 0.12, 0.26);
  taskChair(ctx, wx - 1.15, ry, base, -Math.PI / 2, "guest");

  // lounge cluster
  const lx = r.x0 + 4.4, ly = r.cy + 1.6;
  sofa(ctx, lx - 1.55, ly, base, Math.PI / 2, 2.5);
  armchair(ctx, lx + 1.65, ly - 1.15, base, -Math.PI / 2);
  armchair(ctx, lx + 1.65, ly + 1.15, base, -Math.PI / 2);
  coffeeTable(ctx, lx, ly, base);
  b.cyl(M.ceramic, lx - 1.4, ly - 1.7, base + 0.52, 0.18, 0.06);
  b.cyl(M.metal, lx - 1.4, ly - 1.7, base + 0.28, 0.03, 0.4);
  plant(ctx, lx - 2.0, ly + 2.2, base, 1.35);

  // second seating group near the west glass
  sofa(ctx, r.x0 + 1.7, r.cy - 2.2, base, Math.PI / 2, 2.2);
  armchair(ctx, r.x0 + 3.7, r.cy - 1.4, base, -Math.PI / 2);
  coffeeTable(ctx, r.x0 + 3.1, r.cy - 2.2, base);

  // tall planting + directory near the entrance
  plant(ctx, r.x1 - 1.2, r.y0 + 0.9, base, 1.7);
  plant(ctx, r.x0 + 1.2, r.y0 + 1.1, base, 1.25);
  const totem = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.16, 2.1), M.bronze);
  totem.position.set(r.x0 + 3.8, r.y0 + 1.1, base + 1.05);
  room.group.add(totem);
  const totemFace = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.02, 1.6), M.screen);
  totemFace.position.set(r.x0 + 3.8, r.y0 + 1.03, base + 1.1);
  room.group.add(totemFace);

  // security speed gates toward the lifts
  for (const gy of [r.y1 - 4.2, r.y1 - 3.3]) {
    for (const gx of [r.x0 + 7.1, r.x0 + 8.0]) {
      const ped = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.9, 1.1), M.glassRail);
      ped.position.set(gx, gy, base + 0.55);
      room.group.add(ped);
      lb(b, M.darkMetal, gx, gy, 0, 0, 0, base + 0.95, 0.3, 0.9, 0.08);
      lb(b, M.glowWarm, gx, gy, 0, 0, 0, base + 1.0, 0.02, 0.35, 0.02);
    }
  }

  // rug / doormat
  b.box(M.carpetDark, r.x0 + 5.5, r.y0 + 0.9, base + 0.04, 3.2, 1.2, 0.015, { cast: false });

  const pend = pendant(r.x0 + 5.0, r.cy + 0.6, base + 7.2, base + 4.0, base + 8.6);
  room.group.add(pend.group);
  const dev = room.addDevice("lt-" + room.id, pend.group, pend.anchor, room.floorId, room.id, "LIGHTING");
  room.registerStatusMat(dev, room.ltMat);
  for (const [ox, oy, dz] of [[-0.55, 0.2, 0], [0.9, -0.1, -2.1], [-0.4, 0.45, -2.4]]) {
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), M.darkMetal);
    proxy.position.set(pend.anchor.x + ox, pend.anchor.y + oy, pend.anchor.z + dz);
    proxy.visible = false;
    pend.group.add(proxy);
    room.tagPick(proxy, "devices", "lt-" + room.id, "device",
      ["building", "floor", "room"], { floorId: room.floorId, roomId: room.id });
  }
  // cove around the double-height perimeter
  for (const [x, y, w, d] of [
    [r.cx, r.y0 + 0.2, r.w - 0.8, 0.1], [r.cx, r.y1 - 0.2, r.w - 0.8, 0.1],
    [r.x0 + 0.2, r.cy, 0.1, r.d - 0.8],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, 0.04), ctx.coveMat);
    m.position.set(x, y, base + 8.3);
    m.castShadow = false;
    room.ceilGroup.add(m);
  }
  socketGroup(ctx, room);
}

function pantryRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs, { cove: false });
  const north = r.y1 - 0.32;
  const runW = Math.min(4.6, r.w - 1.2);
  lb(b, M.cabinet, r.cx, north, 0, 0, 0, base + 0.45, runW, 0.62, 0.9);
  lb(b, M.granite, r.cx, north, 0, 0, 0, base + 0.93, runW + 0.04, 0.66, 0.05);
  lb(b, M.stoneLight, r.cx, north + 0.28, 0, 0, 0, base + 1.3, runW, 0.03, 0.7);
  lb(b, M.cabinet, r.cx, north + 0.25, 0, 0, 0, base + 2.15, runW, 0.38, 0.72);
  // sink
  b.box(M.metal, r.cx - runW / 2 + 1.2, north, base + 0.94, 0.62, 0.42, 0.03);
  b.cyl(M.metal, r.cx - runW / 2 + 1.2, north + 0.12, base + 1.16, 0.02, 0.34);
  // coffee machine
  b.box(M.blackMetal, r.cx + 0.4, north, base + 1.16, 0.42, 0.4, 0.4);
  b.box(M.screen, r.cx + 0.4, north - 0.205, base + 1.24, 0.25, 0.01, 0.12);
  b.box(M.metal, r.cx + 0.4, north - 0.3, base + 1.02, 0.3, 0.2, 0.02);
  // fridge
  b.box(M.fridge, r.x0 + 0.65, north - 0.05, base + 0.95, 0.72, 0.68, 1.9);
  b.box(M.blackMetal, r.x0 + 0.65, north - 0.4, base + 1.3, 0.04, 0.03, 0.5);
  // high table by the window
  lb(b, M.wood, r.cx + 0.5, r.y0 + 1.0, 0, 0, 0, base + 1.02, 2.2, 0.72, 0.05);
  b.cyl(M.metal, r.cx + 0.5, r.y0 + 1.0, base + 0.51, 0.06, 1.0);
  for (let i = 0; i < 4; i++) {
    const sx = r.cx - 0.5 + i * 0.7;
    b.cyl(M.metal, sx, r.y0 + 0.55, base + 0.36, 0.035, 0.72);
    b.cyl(M.leather, sx, r.y0 + 0.55, base + 0.75, 0.16, 0.07);
  }
  for (let i = 0; i < 3; i++) {
    const x = r.cx - 1.6 + i * 1.6;
    b.cyl(M.blackMetal, x, r.y0 + 1.0, base + 2.65, 0.006, 1.6);
    b.cyl(M.glowWarm, x, r.y0 + 1.0, base + 1.9, 0.14, 0.22);
  }
  const lightItems = [
    { x: r.cx - 1.1, y: r.cy, z: base + specs.ceil - 0.06, w: 0.14, d: 1.6 },
    { x: r.cx + 1.3, y: r.cy, z: base + specs.ceil - 0.06, w: 0.14, d: 1.6 },
  ];
  linearLightGroup(ctx, room, lightItems, room.group);
  plant(ctx, r.x1 - 0.6, r.y1 - 0.7, base, 0.85);
  socketGroup(ctx, room);
}

function restroomRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs, { cove: false });
  const mirror = mirrorMat();
  // vanity along the east wall
  const vx = r.x1 - 0.35, vy = r.cy;
  lb(b, M.walnut, vx, vy, 0, 0, 0, base + 0.43, 0.62, 2.5, 0.86);
  lb(b, M.marble, vx, vy, 0, 0, 0, base + 0.88, 0.68, 2.56, 0.05);
  for (const oy of [-0.7, 0.7]) {
    b.cyl(M.ceramic, vx, vy + oy, base + 0.98, 0.22, 0.14);
    b.cyl(M.ceramic, vx, vy + oy, base + 1.06, 0.17, 0.03);
    b.cyl(M.metal, vx + 0.2, vy + oy, base + 1.04, 0.014, 0.2);
  }
  const mir = new THREE.Mesh(new THREE.BoxGeometry(0.02, 2.2, 1.1), mirror);
  mir.position.set(vx + 0.33, vy, base + 1.75);
  room.group.add(mir);
  lb(b, M.glowWarm, vx + 0.25, vy, 0, 0, 0, base + 2.35, 0.03, 2.1, 0.08);

  // two cubicles along the north wall
  for (let i = 0; i < 2; i++) {
    const cx = r.cx - 1.0 + i * 2.0;
    const y = r.y1 - 1.1;
    lb(b, M.glassFrost, cx, y + 0.02, 0, 0, 0, base + 1.1, 1.9, 0.025, 2.2);
    b.box(M.ceramic, cx, y - 0.06, base + 0.3, 0.42, 0.6, 0.4);
    b.box(M.ceramic, cx, y + 0.16, base + 0.62, 0.42, 0.16, 0.34);
    b.box(M.ceramic, cx, y + 0.26, base + 0.8, 0.36, 0.06, 0.04);
  }
  lb(b, M.glassFrost, r.cx, r.y1 - 2.2, 0, 0, 0, base + 1.1, 3.9, 0.02, 2.2);

  // hand dryer + bin
  b.box(M.aluminum, r.x0 + 0.18, r.cy + 1.2, base + 1.1, 0.12, 0.32, 0.3);
  b.box(M.darkMetal, r.x0 + 0.28, r.cy - 1.6, base + 0.32, 0.3, 0.3, 0.6);
  plant(ctx, r.x0 + 0.5, r.y0 + 0.55, base, 0.7);

  const items = [
    { x: r.cx - 1.2, y: r.cy, z: base + specs.ceil - 0.05, w: 0.14, d: 1.4 },
    { x: r.cx + 1.2, y: r.cy, z: base + specs.ceil - 0.05, w: 0.14, d: 1.4 },
  ];
  linearLightGroup(ctx, room, items, room.group);
  socketGroup(ctx, room);
}

function executiveRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs, { cove: true });
  rug(ctx, r.x0 + 2.6, r.cy + 1.4, base, 4.8, 3.8, M.rug);

  // slatted walnut feature wall on the south side
  for (let i = 0; i < 34; i++) {
    const x = r.x0 + 0.4 + i * 0.3;
    if (x > r.x1 - 0.4) break;
    lb(b, M.walnut, x, r.y0 + 0.12, 0, 0, 0, base + 1.75, 0.12, 0.09, 3.5);
  }
  lb(b, M.glowSoft, r.cx, r.y0 + 0.18, 0, 0, 0, base + 3.56, r.w - 1.0, 0.03, 0.03);

  // executive desk facing the entry (user sits west of the desk)
  const dx = r.x0 + 3.4, dy = r.cy + 1.1;
  lb(b, M.walnut, dx, dy, 0, 0, 0, base + 0.75, 2.6, 1.1, 0.06);
  lb(b, M.walnut, dx - 0.02, dy - 0.42, 0, 0, 0, base + 0.42, 2.3, 0.15, 0.58);
  lb(b, M.walnut, dx - 1.18, dy, 0, 0, 0, base + 0.37, 0.12, 0.95, 0.74);
  lb(b, M.walnut, dx + 1.18, dy, 0, 0, 0, base + 0.37, 0.12, 0.95, 0.74);
  lb(b, M.leather, dx, dy + 0.05, 0, 0, 0, base + 0.79, 0.9, 0.5, 0.015);
  monitor(ctx, dx + 0.95, dy, base + 1.05, -Math.PI / 2, 0.66, 0.4);
  lb(b, M.blackMetal, dx - 0.3, dy + 0.15, 0, 0, 0, base + 0.79, 0.34, 0.24, 0.02);
  lb(b, M.blackMetal, dx - 0.3, dy + 0.27, 0, 0, 0, base + 0.9, 0.34, 0.02, 0.22);
  b.cyl(M.ceramic, dx + 0.5, dy - 0.3, base + 0.82, 0.07, 0.1);
  taskChair(ctx, dx - 1.05, dy, base, -Math.PI / 2, "exec");
  sideChair(ctx, dx + 1.15, dy - 0.6, base, Math.PI / 2, M.fabricBlue);
  sideChair(ctx, dx + 1.15, dy + 0.6, base, Math.PI / 2, M.fabricBlue);

  // credenza on the north wall
  lb(b, M.walnut, r.cx + 1.4, r.y1 - 0.32, 0, 0, 0, base + 0.38, 3.0, 0.48, 0.76);
  lb(b, M.granite, r.cx + 1.4, r.y1 - 0.32, 0, 0, 0, base + 0.79, 3.04, 0.52, 0.03);
  const art = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.02, 1.35),
    new THREE.MeshStandardMaterial({ map: getArtTexture(), roughness: 0.7 }));
  art.position.set(r.cx + 1.4, r.y1 - 0.15, base + 1.9);
  room.group.add(art);
  lb(b, M.bronze, r.cx + 1.4, r.y1 - 0.14, 0, 0, 0, base + 1.9, 2.3, 0.02, 1.45);

  // lounge by the west glass
  const lx = r.x0 + 1.6, ly = r.cy - 1.4;
  sofa(ctx, lx + 0.2, ly, base, -Math.PI / 2, 2.2);
  armchair(ctx, lx + 1.9, ly + 1.0, base, Math.PI);
  armchair(ctx, lx + 1.9, ly - 1.0, base, 0);
  coffeeTable(ctx, lx + 1.2, ly, base);
  b.cyl(M.metal, lx - 0.6, ly + 1.5, base + 0.8, 0.02, 1.6);
  b.cyl(M.glowWarm, lx - 0.6, ly + 1.5, base + 1.65, 0.15, 0.25);
  plant(ctx, r.x1 - 0.8, r.y0 + 0.8, base, 1.5);
  plant(ctx, r.x0 + 0.7, r.y1 - 0.8, base, 1.0);

  const items = [
    { x: r.cx + 1.4, y: r.cy + 0.9, z: base + specs.ceil - 0.06, w: 2.3, d: 0.15 },
    { x: r.cx + 1.4, y: r.cy - 1.5, z: base + specs.ceil - 0.06, w: 2.3, d: 0.15 },
  ];
  linearLightGroup(ctx, room, items, room.group);
  socketGroup(ctx, room);
}

/* ---------------- featured technical room ---------------- */

function serverRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs, { cove: false });
  const floorZ = base + 0.36;
  const aisleY = r.cy;
  const rackW = 0.62, rackD = 1.05, rackH = 2.0;
  const rowX = [-7.1, -6.48, -5.86, -5.24, -4.62];
  const northY = aisleY + 0.65 + rackD / 2;   // fronts meet the aisle
  const southY = aisleY - 0.65 - rackD / 2;

  // raised floor + edge
  b.box(M.esd, r.cx, r.cy, floorZ - 0.06, r.w - 0.12, r.d - 0.12, 0.12, { cast: false });
  for (const [x, y, w, d] of [
    [r.cx, r.y0 + 0.07, r.w - 0.1, 0.08], [r.cx, r.y1 - 0.07, r.w - 0.1, 0.08],
    [r.x0 + 0.07, r.cy, 0.08, r.d - 0.1], [r.x1 - 0.07, r.cy, 0.08, r.d - 0.1],
  ]) {
    b.box(M.aluminum, x, y, floorZ - 0.12, w, d, 0.24);
  }
  // containment glass + frames
  for (const yy of [aisleY + 0.65, aisleY - 0.65]) {
    b.box(M.aluminum, -5.9, yy, base + 2.55, 3.6, 0.06, 0.06);
    b.box(M.aluminum, -5.9, yy, base + 2.3, 3.6, 0.04, 0.04);
  }
  b.box(M.glassClear, -5.9, aisleY, base + 2.5, 3.6, 1.3, 0.015, { cast: false });
  b.box(M.glassClear, -4.24, aisleY, base + 1.45, 0.02, 1.3, 2.2, { cast: false });
  b.box(M.aluminum, -4.24, aisleY + 0.65, base + 1.45, 0.05, 0.05, 2.2);
  b.box(M.aluminum, -4.24, aisleY - 0.65, base + 1.45, 0.05, 0.05, 2.2);
  b.box(M.aluminum, -4.24, aisleY, base + 2.52, 0.06, 1.35, 0.06);

  const rackLed = new THREE.MeshBasicMaterial({ color: 0x7fe8ff, toneMapped: false });
  for (const x of rowX) {
    for (const [y, face] of [[northY, Math.PI], [southY, 0]]) {
      b.box(M.rack, x, y, floorZ + rackH / 2, rackW, rackD, rackH);
      b.box(M.rackSide, x, y, floorZ + rackH + 0.025, rackW + 0.02, rackD + 0.02, 0.05);
      // glowing status strip at the top front
      const fy = y + (face === Math.PI ? -rackD / 2 - 0.012 : rackD / 2 + 0.012);
      b.box(rackLed, x, fy, floorZ + rackH - 0.12, 0.28, 0.012, 0.018, { cast: false });
      b.box(M.blackMetal, x, fy, floorZ + 0.045, rackW - 0.12, 0.02, 0.09);
    }
  }
  // cable trays over each row
  for (const y of [northY, southY]) {
    b.box(M.aluminum, -5.86, y, floorZ + 2.55, 3.7, 0.36, 0.08);
    for (const x of [-7.55, -6.7, -5.85, -5.0, -4.2]) {
      b.cyl(M.steel, x, y, floorZ + 2.72, 0.012, 0.26);
    }
    for (let i = 0; i < 3; i++) {
      b.box(i === 0 ? M.cableBlue : (i === 1 ? M.cableYellow : M.cable),
        -5.86, y - 0.1 + i * 0.1, floorZ + 2.6, 3.5, 0.03, 0.025, { cast: false });
    }
  }
  // cold-aisle perforated tiles
  b.box(M.darkMetal, -5.86, aisleY, floorZ + 0.006, 3.3, 0.7, 0.012, { cast: false });

  // UPS — existing device ups-b1
  const ux = -2.1, uy = r.y0 + 1.8;
  const ups = new THREE.Group();
  const upsBody = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 1.9), M.darkMetal);
  upsBody.position.set(ux, uy, base + 1.3);
  upsBody.castShadow = true;
  ups.add(upsBody);
  const upsFace = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.9), M.blackMetal);
  upsFace.position.set(ux - 0.46, uy, base + 1.36);
  ups.add(upsFace);
  const upsScreen = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.26), M.screen);
  upsScreen.position.set(ux - 0.481, uy, base + 1.52);
  ups.add(upsScreen);
  const upsLedMat = M.glowCool.clone();
  const upsLed = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.025), upsLedMat);
  upsLed.position.set(ux - 0.482, uy, base + 1.28);
  ups.add(upsLed);
  const upsBatt = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 1.9), M.rackSide);
  upsBatt.position.set(ux - 1.0, uy, base + 1.3);
  ups.add(upsBatt);
  room.group.add(ups);
  const upsDev = room.addDevice("ups-b1", ups,
    new THREE.Vector3(ux, uy, base + 1.9), room.floorId, room.id, "UPS");
  room.registerStatusMat(upsDev, upsLedMat);
  for (const mesh of [upsBody, upsBatt]) {
    room.tagPick(mesh, "devices", "ups-b1", "device",
      ["building", "floor", "room"], { floorId: room.floorId, roomId: room.id });
  }

  // CRAC units, tucked into the corners so the feature wall stays clear
  for (const [cy2, cool] of [[r.y1 - 0.7, true], [r.y0 + 0.6, false]]) {
    b.box(M.aluminum, r.x1 - 0.62, cy2, base + 1.15, 0.82, 1.0, 2.1);
    b.box(M.darkMetal, r.x1 - 1.04, cy2, base + 1.35, 0.02, 0.72, 1.2);
    for (let i = 0; i < 5; i++) b.box(M.steel, r.x1 - 1.055, cy2 - 0.28 + i * 0.14, base + 1.35, 0.015, 0.08, 1.0, { cast: false });
    b.box(M.screen, r.x1 - 1.045, cy2, base + 1.95, 0.02, 0.26, 0.14, { cast: false, ry: 0 });
    if (cool) b.box(M.glowCool, r.x1 - 1.06, cy2 + 0.42, base + 2.02, 0.01, 0.06, 0.02, { cast: false });
  }

  /* feature wall on the corridor side.  The east partition used to read as a
     blank sunlit plane between the racks: a dark technical finish, an
     overhead containment tray and a monitoring display above the console give
     the room a working operations wall. */
  const wallX = r.x1 - 0.15;
  const wallTop = specs.ceil - 0.03;
  b.box(M.serverPanel, wallX, r.cy, base + wallTop / 2, 0.06, r.d - 0.24, wallTop);
  for (let i = 0; i < 7; i++) {
    const yy = r.y0 + 0.32 + i * (r.d - 0.64) / 6;
    b.box(M.serverTrim, wallX - 0.045, yy, base + wallTop / 2, 0.02, 0.028, wallTop,
      { cast: false });
  }
  b.box(M.serverTrim, wallX - 0.05, r.cy, base + wallTop - 0.06, 0.03, r.d - 0.2, 0.08,
    { cast: false });
  b.box(M.serverTrim, wallX - 0.05, r.cy, base + 0.09, 0.03, r.d - 0.2, 0.1,
    { cast: false });

  // monitoring display centred above the console, clear of both CRAC units
  b.box(M.blackMetal, wallX - 0.08, -4.15, base + 2.35, 0.05, 1.5, 1.0);
  b.box(M.screen, wallX - 0.108, -4.15, base + 2.35, 0.02, 1.38, 0.88,
    { cast: false });
  b.box(M.serverTrim, wallX - 0.09, -4.15, base + 2.9, 0.07, 1.64, 0.06,
    { cast: false });
  // overhead containment tray with a few riser drops
  b.box(M.serverTrim, wallX - 0.09, r.cy, base + 3.05, 0.07, r.d - 0.4, 0.07,
    { cast: false });
  for (const yy of [-6.55, -5.55, -1.95]) {
    b.box(M.cable, wallX - 0.09, yy, base + 2.75, 0.05, 0.05, 0.6, { cast: false });
  }
  // suppression call point and access control by the north door
  b.box(M.red, wallX - 0.08, -5.45, base + 2.25, 0.04, 0.3, 0.42);
  b.box(M.blackMetal, wallX - 0.075, -2.9, base + 1.28, 0.05, 0.12, 0.24);
  b.box(M.glowCool, wallX - 0.102, -2.9, base + 1.33, 0.015, 0.03, 0.03,
    { cast: false });

  // monitoring console at the end of the aisle, clear of the UPS
  const mx = -3.2, my = aisleY + 0.45;
  lb(b, M.counter, mx, my, Math.PI / 2, 0, 0, floorZ + 0.74, 1.9, 0.72, 0.05);
  lb(b, M.metal, mx, my, Math.PI / 2, 0.75, 0, floorZ + 0.37, 0.06, 0.6, 0.72);
  lb(b, M.metal, mx, my, Math.PI / 2, -0.75, 0, floorZ + 0.37, 0.06, 0.6, 0.72);
  for (const [off, w] of [[-0.62, 0.55], [0, 0.6], [0.62, 0.55]]) {
    const [sx, sy] = lp(mx, my, Math.PI / 2, off, 0.16);
    const scr = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.36, w), M.screen);
    scr.position.set(sx - 0.19, sy, floorZ + 1.25);
    room.group.add(scr);
    const bez = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.4, w + 0.02), M.blackMetal);
    bez.position.set(sx - 0.21, sy, floorZ + 1.25);
    room.group.add(bez);
  }
  taskChair(ctx, mx + 0.62, my, floorZ, -Math.PI / 2);

  // suppression cylinders + pipe
  for (const x of [r.x0 + 1.1, r.x0 + 1.6]) {
    b.cyl(M.red, x, r.y0 + 0.45, base + 0.95, 0.22, 1.6);
    b.cyl(M.darkMetal, x, r.y0 + 0.45, base + 1.82, 0.06, 0.14);
    b.cyl(M.red, x, r.y0 + 0.45, base + 2.05, 0.035, 0.5);
  }
  b.cyl(M.red, r.cx, r.y0 + 0.45, base + 2.32, 0.035, 1.2, { rz: Math.PI / 2 });
  for (const x of [r.x0 + 2.8, r.x0 + 4.2, r.x0 + 5.6]) {
    b.cyl(M.red, x, r.y0 + 0.45, base + 2.55, 0.018, 0.5);
    b.cyl(M.metal, x, r.y0 + 0.45, base + 2.3, 0.05, 0.05);
  }
  b.box(M.red, r.x0 + 1.35, r.y1 - 0.12, base + 1.5, 0.4, 0.12, 0.55);
  b.box(M.glowRed, r.x0 + 1.35, r.y1 - 0.2, base + 1.8, 0.3, 0.02, 0.03, { cast: false });

  // sealed door + card reader on the north wall
  const doorX = r.cx + 1.6, doorY = r.y1 - 0.08;
  lb(b, M.bronze, doorX, doorY, 0, 0, 0, base + 1.15, 1.05, 0.08, 2.3);
  lb(b, M.steel, doorX, doorY - 0.06, 0, 0, 0, base + 1.12, 0.95, 0.04, 2.2);
  b.box(M.blackMetal, doorX + 0.65, doorY - 0.1, base + 1.25, 0.12, 0.05, 0.22);
  b.box(M.glowCool, doorX + 0.65, doorY - 0.13, base + 1.3, 0.03, 0.01, 0.025, { cast: false });

  // network board on the north wall, clear of the feature wall display
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.02, 1.0),
    new THREE.MeshStandardMaterial({ map: getBoardTexture(), roughness: 0.75 }));
  board.position.set(r.x0 + 3.0, r.y1 - 0.06, base + 2.1);
  room.group.add(board);
  for (let i = 0; i < 4; i++) {
    b.box(M.fabricDark, r.x0 + 0.08, r.cy + 0.8 + i * 1.1, base + 1.7, 0.04, 0.9, 1.1);
  }

  const lightItems = [
    { x: r.cx - 2.2, y: r.cy, z: base + specs.ceil - 0.05, w: 0.16, d: 2.2 },
    { x: r.cx + 1.6, y: r.cy + 1.8, z: base + specs.ceil - 0.05, w: 1.6, d: 0.16 },
    { x: r.cx + 1.6, y: r.cy - 1.8, z: base + specs.ceil - 0.05, w: 1.6, d: 0.16 },
  ];
  linearLightGroup(ctx, room, lightItems, room.group);
  socketGroup(ctx, room);
}

/* ---------------- Annex B (kept modest on purpose) ---------------- */

function annexRoom(ctx, room, specs) {
  const { M, batch: b } = ctx;
  const r = room.rect, base = room.base;
  finishRoom(ctx, room, specs);
  defaultLinearLights(ctx, room, specs, "x");
  if (room.usage === "storage") {
    for (let i = 0; i < 3; i++) {
      const x = r.x0 + 0.8 + i * 1.6;
      for (let lvl = 0; lvl < 4; lvl++) {
        lb(b, M.metal, x, r.cy, 0, 0, 0, base + 0.35 + lvl * 0.55, 0.9, 1.4, 0.04);
      }
      for (const oy of [-0.65, 0.65]) {
        b.cyl(M.metal, x, r.cy + oy, base + 1.1, 0.025, 2.2);
      }
      for (let k = 0; k < 5; k++) {
        const jy = ((i * 7 + k * 3) % 5) / 5;          // deterministic jitter
        const jl = (i * 5 + k * 2) % 3;
        lb(b, M.cabinet, x, r.cy - 0.4 + jy * 0.8, 0,
          0, 0, base + 0.55 + jl * 0.55, 0.5, 0.4, 0.3);
      }
    }
    // water heater (existing device wh-b2)
    const wx = r.x1 - 0.8, wy = r.y1 - 0.8;
    const wh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.7, 20), M.fridge);
    body.rotation.x = Math.PI / 2;
    body.position.set(wx, wy, base + 1.05);
    body.castShadow = true;
    wh.add(body);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 10), M.darkMetal);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(wx, wy, base + 2.0);
    wh.add(cap);
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.02), M.glowWarm.clone());
    led.position.set(wx, wy - 0.32, base + 1.6);
    wh.add(led);
    room.group.add(wh);
    const whDev = room.addDevice("wh-b2", wh,
      new THREE.Vector3(wx, wy - 0.5, base + 2.2), room.floorId, room.id, "WATER HEATER");
    room.registerStatusMat(whDev, led.material);
    room.tagPick(body, "devices", "wh-b2", "device",
      ["building", "floor", "room"], { floorId: room.floorId, roomId: room.id });
    socketGroup(ctx, room);
    return;
  }
  if (room.usage === "services") {
    restroomRoom(ctx, room, specs);
    return;
  }
  if (room.usage === "lobby") {
    lb(b, M.stone, r.cx, r.y1 - 0.8, 0, 0, 0, base + 0.52, 3.0, 0.9, 1.04);
    lb(b, M.marble, r.cx, r.y1 - 0.8, 0, 0, 0, base + 1.06, 3.05, 0.95, 0.05);
    taskChair(ctx, r.cx, r.y1 - 1.5, base, Math.PI, "guest");
    sofa(ctx, r.x0 + 1.6, r.cy, base, Math.PI / 2, 2.1);
    coffeeTable(ctx, r.x0 + 3.2, r.cy, base);
    plant(ctx, r.x1 - 0.7, r.y0 + 0.7, base, 1.2);
    socketGroup(ctx, room);
    return;
  }
  // studios / workshops / offices
  const n = r.w > 8 ? 3 : 2;
  const gap = Math.min(2.1, (r.w - 2.2) / n);
  for (let i = 0; i < n; i++) {
    const x = r.cx + (i - (n - 1) / 2) * gap;
    desk(ctx, x, r.cy + 0.8, base, Math.PI, 1.5, 0.7);
    desk(ctx, x, r.cy - 0.8, base, 0, 1.5, 0.7);
  }
  plant(ctx, r.x1 - 0.7, r.y1 - 0.7, base, 1.0);
  socketGroup(ctx, room);
}

/* ---------------- plenum services + floor FCU ---------------- */

function buildFloorServices(ctx) {
  const { M, floor, servicesGroup } = ctx;
  const base = floor.base;
  const b = ctx.batch;
  const L = ctx.layout || {};
  const ox = (ctx.origin && ctx.origin.x) || 0;
  const oy = (ctx.origin && ctx.origin.y) || 0;

  if (!L.minimal) {
    const zDuct = L.zDuct != null ? L.zDuct : base + 8.35;
    const zBranch = L.zBranch != null ? L.zBranch : base + 7.3;
    const ducts = L.ducts || [
      { y: 1.4, len: 15.4, depth: 0.7, h: 0.4 },
      { y: -4.4, len: 14.6, depth: 0.55, h: 0.32 },
    ];
    for (const d of ducts) {
      const y = oy + d.y;
      b.box(M.aluminum, ox, y, zDuct, d.len, d.depth, d.h);
      for (let x = -d.len / 2 + 1.0; x <= d.len / 2 - 1.0; x += 2.6) {
        b.box(M.steel, ox + x, y, zDuct + d.h / 2 + 0.03, 0.35, 0.07, 0.05, { cast: false });
        b.cyl(M.steel, ox + x, y + 0.3, zDuct + d.h / 2 + 0.3, 0.012, 0.55, { cast: false });
      }
    }
    // branches into the rooms, with rises to the mains and drops to slot diffusers
    const centers = L.centers || [[-4.2, 3.6], [-4.2, -4.2], [5.6, 3.6], [5.6, -4.6]];
    for (const [rx, ry] of centers) {
      const x = ox + rx, y = oy + ry;
      let main = ducts[0], best = Infinity;
      for (const d of ducts) {
        const dist = Math.abs(oy + d.y - y);
        if (dist < best) { best = dist; main = d; }
      }
      const mainY = oy + main.y;
      b.box(M.aluminum, x, (y + mainY) / 2, zBranch, 0.4, Math.max(0.3, Math.abs(y - mainY)), 0.28);
      b.box(M.aluminum, x, mainY, (zBranch + zDuct) / 2,
        0.34, 0.34, Math.max(0.3, zDuct - zBranch + main.h / 2));
      b.box(M.aluminum, x, y, (zBranch + base + 4.75) / 2,
        0.3, 0.3, Math.max(0.3, zBranch - base - 4.75));
      b.box(M.darkMetal, x, y, base + 4.72, 2.2, 0.22, 0.045, { cast: false });
    }
    // cable trays, kept clear of the central sight line
    const trays = L.trays || [[-7.6, 7.6, 2.8], [-7.6, 4.0, -3.2]];
    for (const [x0, x1, ty] of trays) {
      const cx = ox + (x0 + x1) / 2, y = oy + ty;
      b.box(M.steel, cx, y, base + 8.0, x1 - x0, 0.38, 0.06, { cast: false });
      for (let x = x0; x <= x1; x += 2.2) {
        b.cyl(M.steel, ox + x, y + 0.2, base + 8.45, 0.01, 1.1, { cast: false });
      }
    }
    // sprinkler main + heads
    const sy = oy + (L.sprinklerY != null ? L.sprinklerY : -0.9);
    const slen = L.sprinklerLen || 15.4;
    b.cyl(M.red, ox, sy, base + 8.6, 0.045, slen, { rz: Math.PI / 2, cast: false });
    for (let x = -slen / 2 + 0.7; x <= slen / 2 - 0.7; x += 2.4) {
      b.cyl(M.red, ox + x, sy, base + 8.45, 0.015, 0.3, { cast: false });
      b.cyl(M.metal, ox + x, sy, base + 8.3, 0.045, 0.045, { cast: false });
    }
    // exposed structure: downstand beams just under the slab
    const beamLen = L.beamLen || 11.8;
    for (let x = -7.2; x <= 7.2; x += 2.4) {
      b.box(M.concreteDark, ox + x, oy, base + 8.95, 0.22, beamLen, 0.34, { cast: false });
    }
  }

  // floor FCU (existing device fc-<floor>)
  const fx = ox + (L.fcu ? L.fcu.x : 1.4);
  const fy = oy + (L.fcu ? L.fcu.y : 1.0);
  const fz = L.fcuZ != null ? L.fcuZ : base + 7.65;
  const fcu = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.68, 0.62), M.aluminum);
  body.position.set(fx, fy, fz);
  body.castShadow = true;
  fcu.add(body);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.02, 0.4), M.darkMetal);
  grille.position.set(fx, fy - 0.35, fz - 0.03);
  fcu.add(grille);
  const stub = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.7), M.aluminum);
  stub.position.set(fx, fy + 0.1, fz + 0.6);
  fcu.add(stub);
  const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.04, 16), M.metal);
  fan.position.set(fx + 0.5, fy - 0.35, fz + 0.05);
  fcu.add(fan);
  const ledMat = M.glowWarm.clone();
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.015), ledMat);
  led.position.set(fx - 0.6, fy - 0.35, fz + 0.15);
  fcu.add(led);
  (ctx.fcuGroup || servicesGroup).add(fcu);
  const dev = ctx.addDevice("fc-" + floor.id, fcu,
    new THREE.Vector3(fx, fy, fz + 0.65), floor.id, null, "FLOOR FCU");
  ctx.registerStatusMat(dev, ledMat);
  for (const mesh of [body, grille, stub]) {
    ctx.tagPick(mesh, "devices", "fc-" + floor.id, "device",
      ["building", "floor", "room"], { floorId: floor.id });
  }
}

/* ---------------- public entry ---------------- */

export function furnishRoom(ctx, room) {
  const specs = roomFinish(room);
  const maxCeil = (room.floorHeight || 9.6) - 1.0;
  specs.ceil = Math.min(specs.ceil, maxCeil);
  const isAnnex = room.towerId === "b2";
  if (isAnnex) {
    annexRoom(ctx, room, specs);
    return;
  }
  if (room.name === "Server Room") serverRoom(ctx, room, specs);
  else if (room.name === "Lobby") lobbyRoom(ctx, room, specs);
  else if (room.name === "Pantry") pantryRoom(ctx, room, specs);
  else if (room.name === "Restrooms") restroomRoom(ctx, room, specs);
  else if (room.name === "Executive Suite") executiveRoom(ctx, room, specs);
  else if (room.usage === "meeting") meetingRoom(ctx, room, specs);
  else officeRoom(ctx, room, specs);
}

export function furnishFloor(ctx) {
  const rooms = ctx.rooms;
  for (const room of rooms) {
    furnishRoom(ctx, room);
  }
  buildFloorServices(ctx);
}

export { buildFloorServices };

