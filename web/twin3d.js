/* ============================================================
   TWIN3D — WebGL prototype renderer (opt-in: ?render=gl)
   ------------------------------------------------------------
   Renders a genuine three.js scene behind the existing #twin
   interaction canvas.  The Canvas renderer remains the default;
   this module is only imported when the URL asks for it and the
   browser exposes WebGL2.

   Responsibilities:
     - perspective camera that follows VIEW / CAM exactly
     - PMREM environment, sun/key/rim lights, soft shadows
     - cutaway visibility per mode (campus → building → floor → room)
     - raycast picking on invisible proxies, same ids as the 2D HIT
     - selection / hover outline + status dots and labels
   ============================================================ */

"use strict";

import * as THREE from "./vendor/three.module.js";
import { createMaterials, createSky } from "./twin3d-kit.js";
import { buildWorld } from "./twin3d-arch.js";
import { PRESENT } from "./twin3d-presentation.js";

const LAYER_ORDER = ["devices", "rooms", "roofs", "floors", "buildings"];
const LAYER_KIND = {
  devices: "device", rooms: "room", roofs: "roof",
  floors: "floor", buildings: "building",
};

/* Pick proxies are invisible by design (they cost no draw calls); ignore
   the object's own flag but still honour a hidden floor/room/tower above it. */
function pickVisible(o) {
  let n = o;
  let first = true;
  while (n) {
    if (n.visible === false && !(first && n.userData.pickOnly)) return false;
    first = false;
    n = n.parent;
  }
  return true;
}

function radialTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.28, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* The glass reflections come from the same procedural dusk dome the
   camera sees, so highlights and the visible sky always agree. */
function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = createSky();
  envScene.add(envSky.mesh);
  const rt = pmrem.fromScene(envScene, 0.02, 1, 900);
  pmrem.dispose();
  envSky.mesh.geometry.dispose();
  envSky.material.dispose();
  return rt;
}

export function createTwin3D(env) {
  const canvas = env.canvas || document.getElementById("twin-gl");
  const view = env.view;
  const camState = env.cam;
  const twin = env.twin;

  /* building.js is a classic script; it reads the presentation-scale
     camera/room model from here only while the WebGL renderer is alive. */
  try { window.TWIN3D_PRESENT = PRESENT; } catch (_) { /* ignore */ }

  let renderer = null, scene = null, camera = null, world = null;
  let envRT = null;
  let active = false, disposed = false, hiddenReason = null;
  let glow = null, selBox = null, hoverBox = null;
  let statusPoints = null;
  let statusPositions = null, statusColors = null;
  let currentW = 0, currentH = 0, currentDpr = 0;
  let lastModeKey = "";
  let lastNow = 0, lastExplode = 0;
  let lastRenderMs = 0, emaMs = 0, renderCount = 0;
  let measureCancel = false;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const boxScratch = new THREE.Box3();
  const vecScratch = new THREE.Vector3();

  const api = {
    isActive: () => active,
    render,
    overlay,
    hit,
    selectables,
    focusRect,
    focusInfo,
    roomInfo,
    cameraState,
    lineOfSight,
    occludedBetween,
    resize,
    setVisible,
    dispose,
    stats,
    measure,
    reason: () => hiddenReason,
    world: () => world,
  };

  /* ---------------- setup ---------------- */

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,   // screenshots / pixel checks
      powerPreference: "high-performance",
    });
  } catch (err) {
    hiddenReason = "context-failed";
    console.warn("Twin3D: WebGL context unavailable — keeping the Canvas renderer.", err);
    return api;
  }

  renderer.setClearColor(0x0b1420, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;   // static scene: one pass per view change

  scene = new THREE.Scene();
  // warm dusk haze: the skyline and the far ground dissolve into the
  // horizon instead of ending in a hard silhouette
  scene.fog = new THREE.Fog(0xb09a85, 140, 520);
  camera = new THREE.PerspectiveCamera(view.fov || 52, 16 / 10, 0.06, 1200);
  camera.up.set(0, 0, 1);

  const sky = createSky();
  scene.add(sky.mesh);

  envRT = buildEnvironment(renderer);
  scene.environment = envRT.texture;

  // dusk lighting: low warm sun, cool sky fill, soft shadows.  The
  // hemisphere term acts as the indirect bounce so interiors keep some
  // form in shadow instead of reading as black holes behind the glass.
  const hemi = new THREE.HemisphereLight(0x9fb6d2, 0x4a3a2a, 0.72);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffd0a0, 3.7);
  key.position.set(-96, -34, 44);
  key.target.position.set(8, 0, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -85;
  key.shadow.camera.right = 85;
  key.shadow.camera.top = 85;
  key.shadow.camera.bottom = -85;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 340;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.045;
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0x8fb6dc, 0.6);
  fill.position.set(54, 46, 38);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffcf9e, 0.5);
  rim.position.set(30, 62, 12);
  scene.add(rim);

  // warm interior practicals (no shadows: the fixtures carry the look)
  const practical = (x, y, z, color, intensity, range) => {
    const l = new THREE.PointLight(color, intensity, range, 2);
    l.position.set(x, y, z);
    scene.add(l);
  };
  practical(-3.8, -4.4, 5.6, 0xffcf9a, 130, 22);   // lobby
  practical(-4.7, -4.4, 22.5, 0xcfe9ff, 36, 15);   // server room, aisle
  practical(-7.4, -4.4, 22.2, 0xcfe9ff, 22, 11);   // server room, west end
  practical(-3.0, 3.4, 22.6, 0xffd6a6, 112, 20);   // floor 2 office
  practical(6.4, 3.4, 22.5, 0xffd6a6, 86, 17);     // floor 2 meeting
  practical(0.6, 3.4, 41.8, 0xffd0a0, 104, 19);    // executive floor
  practical(-3.0, 3.6, 3.2, 0xffd6a6, 108, 20);    // floor 1 office
  practical(6.4, 3.6, 3.2, 0xffd6a6, 80, 17);      // floor 1 meeting
  practical(30.0, -2.0, 3.4, 0xffd2a4, 82, 18);    // annex reception

  const materials = createMaterials();
  world = buildWorld(env, materials);
  world.roomRect = env.roomRect;
  scene.add(world.root);

  // selection helpers
  selBox = new THREE.Box3Helper(new THREE.Box3(), 0x9fd6ee);
  selBox.material.transparent = true;
  selBox.material.opacity = 0.72;
  selBox.material.depthTest = false;
  selBox.renderOrder = 12;
  selBox.visible = false;
  scene.add(selBox);
  hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xe8f2f7);
  hoverBox.material.transparent = true;
  hoverBox.material.opacity = 0.38;
  hoverBox.material.depthTest = false;
  hoverBox.renderOrder = 12;
  hoverBox.visible = false;
  scene.add(hoverBox);

  const glowTex = radialTexture();
  glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0x8fc8e6, transparent: true, opacity: 0.08,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
  }));
  glow.renderOrder = 13;
  glow.visible = false;
  scene.add(glow);

  // status dots in one additive Points draw
  const maxDots = world.devices.size;
  const dotGeo = new THREE.BufferGeometry();
  statusPositions = new THREE.BufferAttribute(new Float32Array(maxDots * 3), 3);
  statusColors = new THREE.BufferAttribute(new Float32Array(maxDots * 3), 3);
  statusPositions.setUsage(THREE.DynamicDrawUsage);
  statusColors.setUsage(THREE.DynamicDrawUsage);
  dotGeo.setAttribute("position", statusPositions);
  dotGeo.setAttribute("color", statusColors);
  dotGeo.setDrawRange(0, 0);
  statusPoints = new THREE.Points(dotGeo, new THREE.PointsMaterial({
    size: 6, sizeAttenuation: false, vertexColors: true, map: glowTex,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    alphaTest: 0.02,
  }));
  statusPoints.frustumCulled = false;
  scene.add(statusPoints);

  active = true;
  try { document.body.classList.add("gl-prototype"); } catch (_) { /* ignore */ }
  renderer.shadowMap.needsUpdate = true;
  resize(twin.W || 1600, twin.H || 950, twin.DPR || 1);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    hiddenReason = "context-lost";
    active = false;
    setVisible(false);
    try { document.body.classList.remove("gl-prototype"); } catch (_) { /* ignore */ }
    try { delete window.TWIN3D_PRESENT; } catch (_) { /* ignore */ }
    console.warn("Twin3D: WebGL context lost — falling back to the Canvas renderer.");
    if (env.sceneInvalidate) env.sceneInvalidate();
  });

  return api;

  /* ---------------- camera ---------------- */

  function applyProjectionOffset() {
    const z = camState.zoom || 1;
    // Match the Canvas renderer exactly: SCENE offsets are applied before the
    // zoom/pan transform, so they scale with CAM.zoom too.
    const off = env.sceneOffset || {};
    const dx = currentW * 0.5 * (z - 1) + z * (off.ox || 0) + (camState.x || 0);
    const dy = currentH * 0.5 * (z - 1) + z * (off.oy || 0) + (camState.y || 0);
    // perspective w = -z, so adding e8/e9 shifts NDC in the opposite direction
    camera.projectionMatrix.elements[8] -= dx / (currentW * 0.5);
    camera.projectionMatrix.elements[9] -= -dy / (currentH * 0.5);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  function updateCamera() {
    const yaw = view.yaw, pitch = view.pitch, D = view.dist;
    const t = view.target;
    // Room inspection uses a separate orbit pivot (the room centre) while
    // still looking at the selected target, so the eye can circle the room
    // without leaving it. Every other view uses the target as the pivot.
    const p = view.pivot || t;
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const ex = p.x + Math.sin(yaw) * D * cosP;
    const ey = p.y - Math.cos(yaw) * D * cosP;
    const ez = p.z + D * sinP;
    camera.position.set(ex, ey, ez);
    camera.up.set(0, 0, 1);
    camera.lookAt(t.x, t.y, t.z);
    camera.fov = view.fov || 52;
    camera.aspect = currentW / currentH;
    camera.zoom = camState.zoom || 1;
    camera.updateProjectionMatrix();
    applyProjectionOffset();
    camera.updateMatrixWorld();
  }

  function projectPoint(x, y, z) {
    vecScratch.set(x, y, z).project(camera);
    if (vecScratch.z < -1 || vecScratch.z > 1) return null;
    return {
      x: (vecScratch.x * 0.5 + 0.5) * currentW,
      y: (-vecScratch.y * 0.5 + 0.5) * currentH,
    };
  }

  /* ---------------- visibility ---------------- */

  /* The section floor: the selected storey, or the tower's default cut. */
  function resolveCut(mode, v) {
    if (mode !== "building" && mode !== "floor" && mode !== "room") return null;
    let bId = v && v.buildingId;
    let fId = v && v.floorId;
    if (!bId) {
      if (v && v.roomId && PRESENT.rooms[v.roomId]) bId = PRESENT.rooms[v.roomId].towerId;
      else if (fId && PRESENT.floors[fId]) bId = PRESENT.floors[fId].towerId;
    }
    if (!bId) return null;
    const tower = PRESENT.towers[bId];
    const cutId = fId || (tower && tower.defaultCut);
    return (cutId && PRESENT.floors[cutId]) || null;
  }

  function sideDot(side, cx, cy) {
    const nx = side === "W" ? -1 : side === "E" ? 1 : 0;
    const ny = side === "S" ? -1 : side === "N" ? 1 : 0;
    const dx = camera.position.x - cx;
    const dy = camera.position.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return (nx * dx + ny * dy) / d;
  }

  function cameraInsideFloor(f) {
    const b = f.bounds;
    return camera.position.x > b.x0 && camera.position.x < b.x1
      && camera.position.y > b.y0 && camera.position.y < b.y1
      && camera.position.z > f.base && camera.position.z < f.base + f.height + 0.6;
  }

  function applyVisibility(mode, v, dt) {
    const cut = resolveCut(mode, v);
    world.cutaway = cut
      ? { buildingId: cut.towerId, floorId: cut.id }
      : { buildingId: null, floorId: null };
    const glassK = Math.min(1, Math.max(0.05, (dt || 0.016) * 7));
    const ceilK = Math.min(1, Math.max(0.04, (dt || 0.016) * 6));

    /* Full architecture is always present.  The cutaway is a real section:
       the near glass fades, ceilings open over the cut floor, everything
       above and below stays in place. */
    for (const id of Object.keys(world.towers)) {
      const tower = world.towers[id];
      tower.group.visible = true;
      tower.roofGroup.visible = true;
      for (const f of tower.floors) {
        f.group.visible = true;
        const isCut = cut && f.id === cut.id;
        for (const g of f.glassMats) {
          let target;
          if (mode === "campus") target = 0.55;
          else if (mode === "building") {
            target = isCut ? (sideDot(g.side, f.bounds.cx, f.bounds.cy) > 0.16 ? 0.05 : 0.32) : 0.40;
          } else if (mode === "floor") {
            target = isCut ? (sideDot(g.side, f.bounds.cx, f.bounds.cy) > 0.12 ? 0.04 : 0.24) : 0.24;
          } else {
            target = isCut ? (sideDot(g.side, f.bounds.cx, f.bounds.cy) > 0.3 ? 0.12 : 0.20) : 0.20;
          }
          g.mat.opacity += (target - g.mat.opacity) * glassK;
        }

        /* Lift the camera-facing wall of the cut band completely:
           cloned per-side materials ease their mullions, transoms,
           fins, spandrel and podium entrance with the glass, so the
           section reads open instead of showing a lattice edge-on. */
        const bands = f.cutBands || [];
        if (bands.length) {
          for (const band of bands) {
            const thr = mode === "room" ? 0.3 : mode === "floor" ? 0.12 : 0.16;
            const near = band.sides
              ? band.sides.every(s => sideDot(s, f.bounds.cx, f.bounds.cy) > thr)
              : sideDot(band.side, f.bounds.cx, f.bounds.cy) > thr;
            const open = isCut && near && mode !== "campus";
            let maxOp = 0;
            for (const m of band.mats) {
              const baseOp = m.userData.baseOpacity == null ? 1 : m.userData.baseOpacity;
              const target = open ? 0 : baseOp;
              m.opacity += (target - m.opacity) * glassK;
              if (m.opacity > maxOp) maxOp = m.opacity;
            }
            band.group.visible = maxOp > 0.03;
          }
        }
      }
    }

    /* Ceilings of the cut storey open while the camera is outside it and
       close again as the camera settles inside, so no shot is blocked and
       the transition never snaps.  Other storeys keep their ceilings. */
    for (const [, room] of world.rooms) {
      let target = 1;
      if (cut && room.floorId === cut.id) {
        const tower = world.towers[room.buildingId];
        const f = tower && tower.floors.find(x => x.id === room.floorId);
        if (f && !cameraInsideFloor(f)) target = 0;
      }
      if (room.ceilFade == null) room.ceilFade = 1;
      room.ceilFade += (target - room.ceilFade) * ceilK;
      const op = room.ceilFade;
      for (const m of room.ceilingMats) m.opacity = op;
      room.ceilGroup.visible = op > 0.02;
      room.group.visible = true;
    }
  }

  function modeKey(mode, v) {
    return [mode, v.buildingId || "", v.floorId || "", v.roomId || ""].join("|");
  }

  /* ---------------- picking ---------------- */

  function pickAllowed(obj, mode, v) {
    const p = obj.userData.pick;
    if (!p || p.modes.indexOf(mode) === -1) return false;
    if (!pickVisible(obj)) return false;
    if (p.floorId) {
      // In the building overview only the open storey exposes equipment;
      // floor volumes themselves stay selectable on every storey.
      if (mode === "building" && p.layer !== "floors"
        && p.floorId !== world.cutaway.floorId) return false;
      if ((mode === "floor" || mode === "room") && p.floorId !== v.floorId) return false;
    }
    if (p.roomId && mode === "room" && p.roomId !== v.roomId) return false;
    if (mode === "campus" && p.layer === "devices" && p.id !== "ev-b1") return false;
    return true;
  }

  function hit(px, py) {
    if (!active) return null;
    const v = env.state() ? env.state().view : view;
    const mode = view.mode;
    if (mode === "roof") return null;
    // A click can land before the next scheduled frame after a camera move;
    // rebuild the camera from VIEW so picking always uses the pose the user
    // is actually looking at.
    updateCamera();
    ndc.set((px / currentW) * 2 - 1, -(py / currentH) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.near = 0;
    raycaster.far = Infinity;   // line-of-sight calls use a short far plane
    raycaster.setFromCamera(ndc, camera);
    for (const layer of LAYER_ORDER) {
      const list = world.picks[layer];
      const allowed = [];
      for (const o of list) if (pickAllowed(o, mode, v)) allowed.push(o);
      if (!allowed.length) continue;
      const hits = raycaster.intersectObjects(allowed, false);
      if (hits.length) return hits[0].object.userData.pick.id;
    }
    return null;
  }

  function selectables() {
    if (!active) return [];
    const mode = view.mode;
    const v = env.state() ? env.state().view : view;
    const out = [], seen = new Set();
    for (const layer of LAYER_ORDER) {
      for (const o of world.picks[layer]) {
        const p = o.userData.pick;
        if (!p || seen.has(p.id)) continue;
        if (!pickAllowed(o, mode, v)) continue;
        seen.add(p.id);
        out.push({ id: p.id, kind: p.kind || LAYER_KIND[layer] });
      }
    }
    return out;
  }

  function floorOfRoom(room) {
    const t = world.towers[room.buildingId];
    return t ? t.floors.find(f => f.id === room.floorId) : null;
  }

  function boxesFor(id) {
    const out = [];
    if (!id) return out;
    const room = world.rooms.get(id);
    if (room) {
      const r = room.rect;
      const f = floorOfRoom(room);
      const lift = f ? f.lift : 0;
      out.push(new THREE.Box3(
        new THREE.Vector3(r.x0, r.y0, room.surface + lift + 0.01),
        new THREE.Vector3(r.x1, r.y1, room.surface + lift + 0.07)));
      return out;
    }
    for (const tid of Object.keys(world.towers)) {
      const t = world.towers[tid];
      for (const f of t.floors) {
        if (f.id === id) {
          const b = f.bounds;
          out.push(new THREE.Box3(
            new THREE.Vector3(b.x0, b.y0, f.base + f.lift + 0.01),
            new THREE.Vector3(b.x1, b.y1, f.base + f.lift + 0.12)));
          return out;
        }
      }
      if (id === "roof-" + tid) {
        const b = t.floors[t.floors.length - 1].bounds;
        out.push(new THREE.Box3(
          new THREE.Vector3(b.x0, b.y0, t.roofZ + t.roofLift),
          new THREE.Vector3(b.x1, b.y1, t.roofZ + t.roofLift + 0.1)));
        return out;
      }
      if (id === tid) {
        const b = t.floors[0].bounds;
        out.push(new THREE.Box3(
          new THREE.Vector3(b.x0, b.y0, 0),
          new THREE.Vector3(b.x1, b.y1, t.mastZ + 0.4)));
        return out;
      }
    }
    const dev = world.devices.get(id);
    if (dev) {
      // prefer the visible pick proxies: the elevator has one per floor
      const proxies = [];
      for (const layer of Object.keys(world.picks)) {
        for (const o of world.picks[layer]) {
          const p = o.userData.pick;
          if (p && p.id === id && pickVisible(o)) proxies.push(o);
        }
      }
      const source = proxies.length ? proxies : [dev.group];
      const box = new THREE.Box3();
      for (const o of source) {
        boxScratch.setFromObject(o);
        if (!boxScratch.isEmpty()) box.union(boxScratch);
      }
      if (!box.isEmpty()) {
        box.expandByScalar(0.06);
        out.push(box);
      }
    }
    return out;
  }

  function focusRect(id) {
    if (!active || !id) return null;
    camera.updateMatrixWorld();
    const boxes = boxesFor(id);
    if (!boxes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, seen = 0;
    const corner = new THREE.Vector3();
    for (const box of boxes) {
      for (let i = 0; i < 8; i++) {
        corner.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z);
        const p = projectPoint(corner.x, corner.y, corner.z);
        if (!p) continue;
        seen += 1;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    if (seen < 2) return null;
    const x = Math.max(0, minX), y = Math.max(0, minY);
    const w = Math.min(currentW, maxX) - x, h = Math.min(currentH, maxY) - y;
    if (w < 2 || h < 2) return null;
    return { x, y, w, h };
  }

  /* World-space bounds for camera framing (focus selected equipment).
     Kept in the renderer because only it knows the authored metres and
     the exploded-floor lift currently applied to the groups. */
  function focusInfo(id) {
    if (!active || !id) return null;
    const boxes = boxesFor(id);
    if (!boxes.length) return null;
    const box = boxes.reduce((a, b) => a.union(b));
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dev = world.devices.get(id);
    const room = world.rooms.get(id);
    return {
      id,
      center: { x: center.x, y: center.y, z: center.z },
      size: { x: size.x, y: size.y, z: size.z },
      buildingId: dev ? dev.buildingId : (room ? room.buildingId : null),
      floorId: dev ? dev.floorId : (room ? room.floorId : null),
      roomId: dev ? dev.roomId : (room ? room.id : null),
    };
  }

  function roomInfo(id) {
    if (!active || !id) return null;
    const room = world.rooms.get(id);
    if (!room) return null;
    const floor = room.buildingId && world.towers[room.buildingId]
      ? world.towers[room.buildingId].floors.find(f => f.id === room.floorId)
      : null;
    const lift = floor ? floor.lift || 0 : 0;
    const base = room.surface + lift;
    const ceiling = (room.ceilingH || room.surface + 4.6) + lift;
    return {
      id, buildingId: room.buildingId, floorId: room.floorId,
      rect: {
        x0: room.rect.x0, y0: room.rect.y0, x1: room.rect.x1, y1: room.rect.y1,
        cx: room.rect.cx, cy: room.rect.cy, w: room.rect.w, d: room.rect.d,
      },
      base, ceiling,
      center: {
        x: room.rect.cx, y: room.rect.cy,
        z: base + Math.min(1.65, Math.max(0.6, (ceiling - base) * 0.45)),
      },
    };
  }

  function cameraState() {
    if (!active) return null;
    return {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: view.target.x, y: view.target.y, z: view.target.z },
      pivot: view.pivot ? { x: view.pivot.x, y: view.pivot.y, z: view.pivot.z } : null,
      yaw: view.yaw, pitch: view.pitch, dist: view.dist,
      fov: camera.fov, zoom: camera.zoom,
      width: currentW, height: currentH,
    };
  }

  /* Opaque-geometry line of sight from a candidate inspection eye to the
     selected equipment.  Used only when the user asks to focus a device, so
     the camera lands in the room's open aisle rather than behind a rack.
     Transparent glazing and invisible pick proxies do not occlude. */
  function lineOfSight(from, to, targetId) {
    if (!active) return false;
    if (!from || !to) return false;
    const a = new THREE.Vector3(from.x, from.y, from.z);
    const b = new THREE.Vector3(to.x, to.y, to.z);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 0.05) return true;
    dir.multiplyScalar(1 / len);
    raycaster.set(a, dir);
    raycaster.near = 0.02;
    raycaster.far = Math.max(0.05, len - 0.12);
    const hits = raycaster.intersectObject(world.root, true);
    for (const h of hits) {
      const o = h.object;
      if (!o || !o.visible) continue;
      if (o.userData && (o.userData.pickOnly || o.userData.twinSkipOcclusion)) continue;
      if (o.isLine || o.isPoints || o.isSprite) continue;
      const pd = o.userData && o.userData.pick;
      if (pd && pd.id === targetId) return true;   // reached the subject itself
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let opaque = false;
      for (const m of mats) {
        if (!m) continue;
        if (m.transparent && (m.opacity == null || m.opacity < 0.6)) continue;
        opaque = true;
        break;
      }
      if (!opaque) continue;
      return false;
    }
    return true;
  }

  /* True when opaque geometry sits between two points, ignoring the
     subject itself. Used in both directions for inspection candidates:
     a camera placed inside a rack can pass the eye→device ray (back-face
     culling) but the device→eye ray still reports the rack shell. */
  function occludedBetween(from, to, skipId) {
    if (!active || !from || !to) return false;
    const a = new THREE.Vector3(from.x, from.y, from.z);
    const b = new THREE.Vector3(to.x, to.y, to.z);
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 0.05) return false;
    dir.multiplyScalar(1 / len);
    raycaster.set(a, dir);
    raycaster.near = 0.02;
    raycaster.far = Math.max(0.05, len - 0.05);
    const hits = raycaster.intersectObject(world.root, true);
    for (const h of hits) {
      const o = h.object;
      if (!o || !o.visible) continue;
      if (o.userData && o.userData.pickOnly) continue;
      if (o.isLine || o.isPoints || o.isSprite) continue;
      const pd = o.userData && o.userData.pick;
      if (pd && pd.id === skipId) continue;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let opaque = false;
      for (const m of mats) {
        if (!m) continue;
        if (m.transparent && (m.opacity == null || m.opacity < 0.6)) continue;
        opaque = true;
        break;
      }
      if (opaque) return true;
    }
    return false;
  }

  /* ---------------- state tint ---------------- */

  function equipmentMaps(state) {
    const snap = state && state.snap;
    const equips = {};
    for (const d of (snap && snap.equipment) || []) equips[d.id] = d;
    return { snap, equips };
  }

  function vizSpace(space) {
    if (!space) return null;
    try { return env.vizSpaceColor ? env.vizSpaceColor(space) : null; } catch (_) { return null; }
  }

  function updateTints(state, now) {
    const { equips } = equipmentMaps(state);
    const heat = env.vizMode ? env.vizMode() === "heatmap" : false;
    for (const [id, room] of world.rooms) {
      let data = null;
      try {
        const thing = env.findTwinThing ? env.findTwinThing(id) : null;
        data = thing ? thing.data : null;
      } catch (_) { data = null; }
      const viz = vizSpace(data);
      const base = new THREE.Color(viz || world.materials.usage[room.usage] || 0x6b7480);
      room.tintMat.color.copy(base);
      room.tintMat.opacity = viz ? (heat ? 0.55 : 0.28) : 0.11;
      room.tintMat.emissive.copy(base).multiplyScalar(viz ? 0.22 : 0.02);
    }
    for (const [id, dev] of world.devices) {
      const d = equips[id];
      const status = (d && d.status) || "ok";
      let color;
      if (id.indexOf("lt-") === 0 && status === "ok") {
        color = new THREE.Color(d && d.actual > 0.02 ? 0xffe2ad : 0x2c3138);
      } else {
        color = new THREE.Color(env.stColor ? env.stColor(status) : "#4ff0a2");
      }
      for (const m of dev.statusMats) {
        if (!m) continue;
        if (m.isMeshBasicMaterial) m.color.copy(color);
        else if (m.emissive) m.emissive.copy(color).multiplyScalar(0.7);
      }
    }
    return equips;
  }

  function updateStatusDots(mode, v, equips) {
    const pos = statusPositions.array;
    const col = statusColors.array;
    let n = 0;
    const c = new THREE.Color();
    for (const [id, dev] of world.devices) {
      if (id === "el-b1") continue;            // one dot per floor would duplicate
      let on = false;
      if (mode === "campus") on = id === "ev-b1";
      else if (mode === "building") {
        const cutHere = world.cutaway.buildingId === v.buildingId;
        on = (id === "ev-b1" && v.buildingId === "b1")
          || (cutHere && dev.floorId === world.cutaway.floorId);
      } else if (mode === "floor") on = dev.floorId === v.floorId;
      else if (mode === "room") {
        on = dev.floorId === v.floorId
          && (!dev.roomId || dev.roomId === v.roomId || id === "fc-" + v.floorId);
      }
      if (!on || dev.anchor.x === undefined) continue;
      pos[n * 3] = dev.anchor.x;
      pos[n * 3 + 1] = dev.anchor.y;
      pos[n * 3 + 2] = dev.anchor.z;
      const d = equips[id];
      c.set(env.stColor ? env.stColor((d && d.status) || "ok") : "#4ff0a2");
      col[n * 3] = c.r; col[n * 3 + 1] = c.g; col[n * 3 + 2] = c.b;
      n += 1;
    }
    statusPositions.needsUpdate = true;
    statusColors.needsUpdate = true;
    statusPoints.geometry.setDrawRange(0, n);
  }

  /* ---------------- selection ---------------- */

  function updateSelection(mode, v, state, now) {
    const selId = (state && state.selection && state.selection.id) || null;
    const hoverId = (state && state.hover) || null;
    let activeId = selId;
    if (!activeId && mode === "room") activeId = v.roomId;
    else if (!activeId && mode === "floor") activeId = v.floorId;

    let box = null;
    if (activeId) {
      const boxes = boxesFor(activeId);
      if (boxes.length) box = boxes.reduce((a, b) => a.union(b));
    }
    if (box) {
      selBox.box.copy(box);
      selBox.visible = true;
      if (glow) {
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const dim = Math.max(size.x, size.y, size.z, 0.2);
        glow.position.copy(center);
        glow.scale.setScalar(dim * 1.8);
        glow.visible = mode !== "campus";
        glow.material.opacity = 0.045 + 0.025 * Math.sin((now || 0) / 420);
        glow.material.color.set(0x9fd0e8);
      }
    } else {
      selBox.visible = false;
      if (glow) glow.visible = false;
    }
    if (hoverId && hoverId !== activeId) {
      const boxes = boxesFor(hoverId);
      if (boxes.length) {
        hoverBox.box.copy(boxes.reduce((a, b) => a.union(b)));
        hoverBox.visible = true;
      } else hoverBox.visible = false;
    } else {
      hoverBox.visible = false;
    }
  }

  /* ---------------- frame ---------------- */

  function resize(w, h, dpr) {
    if (!active) return;
    currentW = Math.max(2, Math.round(w));
    currentH = Math.max(2, Math.round(h));
    const reduced = env.reduced ? env.reduced() : false;
    const cap = reduced ? 1 : 1.5;
    currentDpr = Math.max(1, Math.min(dpr || 1, cap));
    renderer.setPixelRatio(currentDpr);
    renderer.setSize(currentW, currentH, false);
    camera.aspect = currentW / currentH;
    camera.updateProjectionMatrix();
    setVisible(view.mode !== "roof");
    if (env.sceneInvalidate) env.sceneInvalidate();
  }

  function setVisible(on) {
    if (!canvas) return;
    canvas.style.display = on ? "block" : "none";
  }

  function render(now, v, state, twinSize) {
    if (!active || disposed) return false;
    if (v.mode === "roof") { setVisible(false); return false; }
    setVisible(true);
    if (twinSize && (twinSize.W !== currentW || twinSize.H !== currentH)) {
      resize(twinSize.W, twinSize.H, twinSize.DPR);
    }
    const t0 = performance.now();
    const dt = lastNow ? Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000)) : 0.016;
    lastNow = now;
    // The Canvas camera module owns the eased explode value; mirror it into
    // the presentation world so floors lift and settle continuously.
    const explosion = (typeof globalThis.twinExplodeT === "function")
      ? globalThis.twinExplodeT() : 0;
    if (world.setExplode && Math.abs(explosion - (world.explode || 0)) > 0.0004) {
      world.setExplode(explosion);
    }
    updateCamera();
    applyVisibility(v.mode, state ? state.view : v, dt);
    const equips = updateTints(state, now);
    updateStatusDots(v.mode, state ? state.view : v, equips);
    updateSelection(v.mode, state ? state.view : v, state, now);

    const mk = modeKey(v.mode, state ? state.view : v);
    const explodeNow = world.explode || 0;
    if (mk !== lastModeKey || explodeNow !== lastExplode) {
      lastModeKey = mk;
      lastExplode = explodeNow;
      renderer.shadowMap.needsUpdate = true;
    }
    renderer.render(scene, camera);
    lastRenderMs = performance.now() - t0;
    emaMs = emaMs ? emaMs * 0.9 + lastRenderMs * 0.1 : lastRenderMs;
    renderCount += 1;
    return true;
  }

  /* ---------------- 2D overlay labels ---------------- */

  function deviceValue(id, equips) {
    const d = equips[id];
    if (!d) return "";
    if (d.actual == null) return "";
    return d.actual.toFixed(2) + " kW";
  }

  function overlay(ctx, now, v, state) {
    if (!active || v.mode === "roof" || !state || !state.snap) return;
    const { equips } = equipmentMaps(state);
    updateCamera();
    const chip = env.drawSceneChip;
    if (!chip) return;
    const inside = (p) => p && p.x > -80 && p.x < currentW + 80
      && p.y > -40 && p.y < currentH + 40;

    if (v.mode === "room") {
      const room = world.rooms.get(v.roomId);
      const f = v.floorId && world.towers[v.buildingId] &&
        world.towers[v.buildingId].floors.find(x => x.id === v.floorId);
      let rData = null;
      try {
        const thing = env.findTwinThing ? env.findTwinThing(v.roomId) : null;
        rData = thing ? thing.data : null;
      } catch (_) { rData = null; }
      const lift = f ? f.lift : 0;
      const headerPos = room && projectPoint(room.rect.cx, room.rect.y1 + 0.4,
        room.surface + lift + 1.25);
      if (inside(headerPos)) {
        const vizVal = (env.vizSpaceChip && rData) ? env.vizSpaceChip(rData) : null;
        const vizCol = vizSpace(rData);
        // rooms without a floor area in the data model omit the m² suffix
        const areaTxt = (rData && rData.area > 1) ? ` · ${Math.round(rData.area)} m²` : "";
        const value = vizVal || (rData
          ? `${rData.actual.toFixed(1)} kW${areaTxt}` : "");
        chip(ctx, headerPos.x, headerPos.y, room ? room.name.toUpperCase() : "",
          value, vizCol || (rData && rData.anomalies
            ? "rgba(239, 106, 69, 0.9)" : "rgba(143, 220, 255, 0.9)"));
        if (rData && rData.anomalies && env.drawAnomalyBadge) {
          env.drawAnomalyBadge(ctx, headerPos.x + 52, headerPos.y - 7, rData.anomalies, now);
        }
      }
      for (const lab of world.labels.devices) {
        const dev = world.devices.get(lab.id);
        if (!dev || dev.floorId !== v.floorId) continue;
        if (dev.roomId && dev.roomId !== v.roomId) continue;
        if (!dev.roomId && lab.id !== "fc-" + v.floorId) continue;
        const p = projectPoint(lab.pos.x, lab.pos.y, lab.pos.z);
        if (!inside(p)) continue;
        const d = equips[lab.id];
        chip(ctx, p.x, p.y, lab.title, deviceValue(lab.id, equips),
          (d && env.stColor) ? env.stColor(d.status) : "rgba(143,220,255,0.9)");
      }
      return;
    }

    if (v.mode === "floor") {
      for (const lab of world.labels.rooms) {
        if (lab.floorId !== v.floorId) continue;
        const p = projectPoint(lab.pos.x, lab.pos.y, lab.pos.z);
        if (!inside(p)) continue;
        let data = null;
        try {
          const thing = env.findTwinThing ? env.findTwinThing(lab.id) : null;
          data = thing ? thing.data : null;
        } catch (_) { data = null; }
        const vizVal = (env.vizSpaceChip && data) ? env.vizSpaceChip(data, true) : null;
        const vizCol = vizSpace(data);
        chip(ctx, p.x, p.y, lab.name.toUpperCase(),
          vizVal || (data ? `${data.actual.toFixed(1)} kW` : ""),
          vizCol || (env.stColor ? env.stColor(data && data.status) : "rgba(143,220,255,0.9)"));
        if (data && data.anomalies && env.drawAnomalyBadge) {
          env.drawAnomalyBadge(ctx, p.x + 44, p.y - 6, data.anomalies, now);
        }
      }
      return;
    }

    if (v.mode === "building") {
      // In the cutaway only the open storey is labelled; the ghosted floors
      // above it would otherwise stack three chips on the same façade edge.
      const cutHere = world.cutaway && world.cutaway.buildingId === v.buildingId;
      for (const lab of world.labels.floors) {
        if (lab.buildingId !== v.buildingId) continue;
        if (cutHere && lab.id !== world.cutaway.floorId) continue;
        const p = projectPoint(lab.pos.x, lab.pos.y, lab.pos.z);
        if (!inside(p)) continue;
        let data = null;
        try {
          const thing = env.findTwinThing ? env.findTwinThing(lab.id) : null;
          data = thing ? thing.data : null;
        } catch (_) { data = null; }
        const vizVal = (env.vizSpaceChip && data) ? env.vizSpaceChip(data, true) : null;
        const vizCol = vizSpace(data);
        chip(ctx, p.x, p.y, lab.name.toUpperCase(),
          vizVal || (data ? `${data.actual.toFixed(1)} kW` : ""),
          vizCol || (env.stColor ? env.stColor(data && data.status) : "rgba(143,220,255,0.9)"));
      }
      return;
    }

    if (v.mode === "campus") {
      for (const lab of world.labels.buildings) {
        const p = projectPoint(lab.pos.x, lab.pos.y, lab.pos.z);
        if (!inside(p)) continue;
        let data = null;
        try {
          const thing = env.findTwinThing ? env.findTwinThing(lab.id) : null;
          data = thing ? thing.data : null;
        } catch (_) { data = null; }
        const vizVal = (env.vizSpaceChip && data) ? env.vizSpaceChip(data, true) : null;
        chip(ctx, p.x, p.y, lab.name.toUpperCase(),
          vizVal || (data ? `${data.actual.toFixed(1)} kW` : ""),
          vizSpace(data) || (env.stColor ? env.stColor(data && data.status) : "rgba(143,220,255,0.9)"));
      }
    }
  }

  /* ---------------- diagnostics ---------------- */

  function stats() {
    if (!active) return { active: false, reason: hiddenReason };
    const info = renderer.info;
    return {
      active: true,
      width: currentW, height: currentH, dpr: currentDpr,
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      rooms: world.rooms.size,
      devices: world.devices.size,
      pickTargets: LAYER_ORDER.reduce((n, k) => n + world.picks[k].length, 0),
      renderMs: +lastRenderMs.toFixed(2),
      emaMs: +emaMs.toFixed(2),
      frames: renderCount,
      shadowMap: key.shadow.mapSize.x,
    };
  }

  function measure(frames) {
    const n = Math.max(10, frames || 90);
    measureCancel = false;
    return new Promise((resolve) => {
      const times = [];
      let i = 0;
      const step = () => {
        if (measureCancel || disposed) { resolve(null); return; }
        const t0 = performance.now();
        renderer.render(scene, camera);
        times.push(performance.now() - t0);
        i += 1;
        if (i < n) requestAnimationFrame(step);
        else {
          const sorted = times.slice().sort((a, b) => a - b);
          resolve({
            frames: n,
            avgMs: +(times.reduce((s, t) => s + t, 0) / n).toFixed(2),
            p95Ms: +sorted[Math.floor(n * 0.95)].toFixed(2),
            maxMs: +sorted[n - 1].toFixed(2),
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
          });
        }
      };
      requestAnimationFrame(step);
    });
  }

  function dispose() {
    disposed = true;
    active = false;
    measureCancel = true;
    setVisible(false);
    try { document.body.classList.remove("gl-prototype"); } catch (_) { /* ignore */ }
    try { delete window.TWIN3D_PRESENT; } catch (_) { /* ignore */ }
    try {
      if (scene) {
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
              if (m.map && m.map.dispose) m.map.dispose();
              if (m.dispose) m.dispose();
            }
          }
        });
      }
      if (envRT) envRT.dispose();
      if (renderer) renderer.dispose();
    } catch (_) { /* best effort */ }
  }
}
