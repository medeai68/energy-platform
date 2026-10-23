/* ============================================================
   TWIN3D — shared materials, textures and small builders
   ------------------------------------------------------------
   Every surface in the architectural prototype is procedural:
   no external models, no image downloads.  Materials are shared
   across rooms and floors so the whole tower stays cheap to draw.
   ============================================================ */

"use strict";

import * as THREE from "./vendor/three.module.js";

/* ---------------- canvas textures ---------------- */

export function canvasTexture(w, h, draw, repeatX, repeatY) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX || 1, repeatY || 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function noiseFill(g, w, h, base, amp, step, alpha) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const n = Math.floor(w * h / (step * step));
  const a = alpha == null ? 0.16 : alpha;
  for (let i = 0; i < n; i++) {
    const v = Math.round((Math.random() - 0.5) * amp);
    g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},${a})`;
    g.fillRect(Math.random() * w, Math.random() * h, step, step);
  }
}

function fineGrain(g, w, h, alpha, count) {
  for (let i = 0; i < (count || 1400); i++) {
    const v = Math.random() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
}

/* ---------------- materials ---------------- */

export function createMaterials() {
  const stoneTex = canvasTexture(512, 512, (g, w, h) => {
    noiseFill(g, w, h, "#c7c0b3", 26, 2, 0.12);
    g.strokeStyle = "rgba(120,114,104,0.18)";
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke();
    }
    for (let i = 0; i < 12; i++) {
      g.strokeStyle = `rgba(140,132,118,${0.05 + Math.random() * 0.07})`;
      g.beginPath();
      let x = Math.random() * w, y = Math.random() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 18; g.lineTo(x, y); }
      g.stroke();
    }
    fineGrain(g, w, h, 0.04, 1200);
  }, 3, 3);

  const pavingTex = canvasTexture(512, 512, (g, w, h) => {
    noiseFill(g, w, h, "#595650", 30, 3, 0.14);
    g.strokeStyle = "rgba(24,24,24,0.55)";
    g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * w / 4, 0); g.lineTo(i * w / 4, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * h / 4); g.lineTo(w, i * h / 4); g.stroke();
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(255,255,255,${0.015 + Math.random() * 0.035})`;
      g.fillRect(Math.random() * w, Math.random() * h, 6 + Math.random() * 30, 2);
    }
    fineGrain(g, w, h, 0.045, 2000);
  }, 22, 18);

  const grassTex = canvasTexture(256, 256, (g, w, h) => {
    noiseFill(g, w, h, "#39452f", 46, 2, 0.22);
    for (let i = 0; i < 900; i++) {
      g.strokeStyle = `rgba(${52 + Math.random() * 40},${72 + Math.random() * 45},${40 + Math.random() * 30},0.5)`;
      g.beginPath();
      const x = Math.random() * w, y = Math.random() * h;
      g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 4);
      g.stroke();
    }
  }, 40, 40);

  const carpetTex = canvasTexture(128, 128, (g, w, h) => {
    noiseFill(g, w, h, "#5c626b", 34, 1, 0.18);
  }, 8, 8);

  const ceilingTex = canvasTexture(256, 256, (g, w, h) => {
    noiseFill(g, w, h, "#d9d6cf", 18, 2, 0.1);
    g.strokeStyle = "rgba(120,118,112,0.3)";
    g.lineWidth = 2;
    for (let i = 0; i <= 2; i++) {
      g.beginPath(); g.moveTo(i * w / 2, 0); g.lineTo(i * w / 2, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * h / 2); g.lineTo(w, i * h / 2); g.stroke();
    }
    fineGrain(g, w, h, 0.03, 900);
  }, 5, 4);

  const woodTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#72543c"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 44; i++) {
      const y = Math.random() * h;
      g.strokeStyle = `rgba(${40 + Math.random() * 40},${28 + Math.random() * 26},${16 + Math.random() * 18},${0.12 + Math.random() * 0.2})`;
      g.lineWidth = 0.6 + Math.random() * 2;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 9, w * 0.7, y + (Math.random() - 0.5) * 9, w, y + (Math.random() - 0.5) * 5);
      g.stroke();
    }
    fineGrain(g, w, h, 0.03, 700);
  }, 2, 2);

  const tileTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#8f9494"; g.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const v = 150 + Math.round(Math.random() * 20);
      g.fillStyle = `rgb(${v},${v + 2},${v + 2})`;
      g.fillRect(x * 64 + 2, y * 64 + 2, 60, 60);
    }
    g.strokeStyle = "rgba(70,74,74,0.7)";
    g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke();
    }
    fineGrain(g, w, h, 0.03, 700);
  }, 3, 3);

  const esdTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#4b5157"; g.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const v = 68 + Math.round(Math.random() * 10);
      g.fillStyle = `rgb(${v},${v + 4},${v + 6})`;
      g.fillRect(x * 64 + 2, y * 64 + 2, 60, 60);
      g.fillStyle = "rgba(20,24,27,0.9)";
      for (let i = 0; i < 9; i++) g.fillRect(x * 64 + 10 + (i % 3) * 18, y * 64 + 10 + Math.floor(i / 3) * 18, 6, 6);
    }
    g.strokeStyle = "rgba(18,20,22,0.85)";
    g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke();
    }
  }, 4, 3);

  const asphaltTex = canvasTexture(256, 256, (g, w, h) => {
    noiseFill(g, w, h, "#34363a", 34, 2, 0.2);
    fineGrain(g, w, h, 0.05, 1600);
  }, 12, 12);

  const rackFaceTex = canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = "#0d1115"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#151b21"; g.fillRect(5, 5, w - 10, h - 10);
    for (let y = 12; y < h - 12; y += 9) {
      g.fillStyle = "rgba(84,94,104,0.6)";
      g.fillRect(9, y, w - 18, 2);
      g.fillStyle = "rgba(6,8,10,0.92)";
      g.fillRect(9, y + 3, w - 18, 4);
      if (y % 27 === 12) {
        g.fillStyle = "rgba(190,200,208,0.3)";
        g.fillRect(w - 24, y - 1, 8, 2);
      }
    }
    g.strokeStyle = "rgba(0,0,0,0.85)";
    g.lineWidth = 3;
    g.strokeRect(2, 2, w - 4, h - 4);
  }, 1, 1);

  const rackLedTex = canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
    for (let y = 14; y < h - 10; y += 18) {
      for (let x = 14; x < w - 14; x += 12) {
        if (Math.random() > 0.34) {
          g.fillStyle = Math.random() > 0.7 ? "#8ff0ff" : (Math.random() > 0.45 ? "#6cf0a8" : "#ffd27a");
          g.fillRect(x, y, 2, 2);
        }
      }
    }
  }, 1, 1);

  const screenTex = canvasTexture(512, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#07131c");
    grad.addColorStop(0.6, "#0b2230");
    grad.addColorStop(1, "#050d14");
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(120,220,255,0.8)";
    g.fillRect(24, 22, 150, 5);
    g.fillStyle = "rgba(120,220,255,0.25)";
    g.fillRect(24, 36, 300, 2);
    g.strokeStyle = "rgba(110,225,255,0.7)";
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 24; x <= w - 24; x += 6) {
      const y = h * 0.64 + Math.sin(x * 0.035) * 24 + Math.sin(x * 0.11) * 7;
      if (x === 24) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = "rgba(90,190,230,0.22)";
    for (let i = 0; i < 4; i++) g.fillRect(24 + i * 58, h - 54, 46, 28);
    g.fillStyle = "rgba(255,210,140,0.7)";
    g.fillRect(w - 120, 22, 96, 4);
  }, 1, 1);

  const marbleTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#d8d3c8"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(${110 + Math.random() * 40},${108 + Math.random() * 40},${102 + Math.random() * 40},${0.06 + Math.random() * 0.12})`;
      g.lineWidth = 0.6 + Math.random() * 3;
      g.beginPath();
      let x = Math.random() * w, y = Math.random() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (Math.random() - 0.4) * 70; y += (Math.random() - 0.5) * 50; g.lineTo(x, y); }
      g.stroke();
    }
    fineGrain(g, w, h, 0.035, 900);
  }, 2, 1);

  const M = {};

  M.stone = new THREE.MeshStandardMaterial({ color: 0xcfc7b8, roughness: 0.78, metalness: 0.03, map: stoneTex });
  M.stoneLight = new THREE.MeshStandardMaterial({ color: 0xe2dccf, roughness: 0.7, metalness: 0.02, map: stoneTex });
  M.marble = new THREE.MeshStandardMaterial({ color: 0xe6e1d6, roughness: 0.32, metalness: 0.05, map: marbleTex });
  M.concrete = new THREE.MeshStandardMaterial({ color: 0x8c8b86, roughness: 0.9, metalness: 0.03, map: stoneTex });
  M.concreteDark = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.92, metalness: 0.04 });
  M.paving = new THREE.MeshStandardMaterial({ color: 0x6f6c65, roughness: 0.86, metalness: 0.04, map: pavingTex });
  M.asphalt = new THREE.MeshStandardMaterial({ color: 0x3a3c3f, roughness: 0.92, metalness: 0.03, map: asphaltTex });
  M.grass = new THREE.MeshStandardMaterial({ color: 0x5c6b4d, roughness: 0.95, metalness: 0.0, map: grassTex });
  M.soil = new THREE.MeshStandardMaterial({ color: 0x3d3529, roughness: 1.0, metalness: 0.0 });

  M.wall = new THREE.MeshStandardMaterial({ color: 0xe0d6c6, roughness: 0.9, metalness: 0.02 });
  M.wallWarm = new THREE.MeshStandardMaterial({ color: 0xcfc0ac, roughness: 0.9, metalness: 0.02 });
  M.wallDark = new THREE.MeshStandardMaterial({ color: 0x5a5e60, roughness: 0.9, metalness: 0.03 });
  M.ceiling = new THREE.MeshStandardMaterial({ color: 0xdcd3c2, roughness: 0.92, metalness: 0.02, map: ceilingTex });
  M.ceilingDark = new THREE.MeshStandardMaterial({ color: 0x4a4d4f, roughness: 0.9, metalness: 0.04 });

  M.carpet = new THREE.MeshStandardMaterial({ color: 0x49515c, roughness: 0.98, metalness: 0.0, map: carpetTex });
  M.carpetWarm = new THREE.MeshStandardMaterial({ color: 0x6a5f53, roughness: 0.98, metalness: 0.0, map: carpetTex });
  M.carpetDark = new THREE.MeshStandardMaterial({ color: 0x343b43, roughness: 0.98, metalness: 0.0, map: carpetTex });
  M.woodFloor = new THREE.MeshStandardMaterial({ color: 0x8c6a4b, roughness: 0.55, metalness: 0.04, map: woodTex });
  M.tile = new THREE.MeshStandardMaterial({ color: 0xc9cdcc, roughness: 0.42, metalness: 0.04, map: tileTex });
  M.esd = new THREE.MeshStandardMaterial({ color: 0x777f85, roughness: 0.55, metalness: 0.12, map: esdTex });
  M.asphalt.receiveShadow = true;

  M.glass = new THREE.MeshPhysicalMaterial({
    color: 0x9fc6d8, metalness: 0.0, roughness: 0.035, transparent: true, opacity: 0.28,
    envMapIntensity: 2.3, clearcoat: 1, clearcoatRoughness: 0.03,
    emissive: 0x08141c, emissiveIntensity: 0.35,
    side: THREE.DoubleSide, depthWrite: false,
  });
  M.glassFoyer = M.glass.clone();
  M.glassFoyer.opacity = 0.17;
  /* the quiet upper bands of Tower A: a cool reflective skin that mirrors
     the dusk sky between the lit operational bands */
  M.glassUpper = new THREE.MeshStandardMaterial({
    color: 0x8fadb9, metalness: 0.55, roughness: 0.09,
    envMapIntensity: 2.4, transparent: true, opacity: 0.82,
    emissive: 0x0e1c24, emissiveIntensity: 0.4,
    side: THREE.DoubleSide, depthWrite: false,
  });
  M.glassFrost = new THREE.MeshStandardMaterial({
    color: 0xd9e2e2, roughness: 0.42, metalness: 0.05, transparent: true, opacity: 0.82,
    side: THREE.DoubleSide, depthWrite: false,
  });
  M.glassRail = new THREE.MeshPhysicalMaterial({
    color: 0xbcd7dd, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.32,
    envMapIntensity: 1.8, side: THREE.DoubleSide, depthWrite: false,
  });
  /* clear interior glass: aisle containment and doors must not veil the
     room behind them the way a bright balustrade panel does */
  M.glassClear = new THREE.MeshPhysicalMaterial({
    color: 0xa9c3c9, metalness: 0, roughness: 0.12, transparent: true, opacity: 0.1,
    envMapIntensity: 0.9, side: THREE.DoubleSide, depthWrite: false,
  });

  M.mullion = new THREE.MeshStandardMaterial({ color: 0x35383a, roughness: 0.4, metalness: 0.72 });
  // deep, near-black bronze: warm where the sun grazes it, never a gold cage
  M.bronze = new THREE.MeshStandardMaterial({ color: 0x392b1e, roughness: 0.38, metalness: 0.85 });
  /* a warmer bronze for exposed edges, belts and the crown: enough
     luminance to draw the silhouette at dusk without turning the tower
     into a gold cage */
  M.bronzeLight = new THREE.MeshStandardMaterial({ color: 0x6c4c2e, roughness: 0.34, metalness: 0.82 });
  /* warm sandstone used for the podium piers, corner piers and the deep
     floor bands; the tower's masonry counterpoint to the cool glass */
  M.stoneWarm = new THREE.MeshStandardMaterial({ color: 0xb4a58e, roughness: 0.72, metalness: 0.03, map: stoneTex });
  M.metal = new THREE.MeshStandardMaterial({ color: 0x8b9197, roughness: 0.34, metalness: 0.86 });
  M.aluminum = new THREE.MeshStandardMaterial({ color: 0xb9bec2, roughness: 0.3, metalness: 0.9 });
  M.darkMetal = new THREE.MeshStandardMaterial({ color: 0x252a2e, roughness: 0.42, metalness: 0.76 });
  M.blackMetal = new THREE.MeshStandardMaterial({ color: 0x121518, roughness: 0.4, metalness: 0.7 });
  M.steel = new THREE.MeshStandardMaterial({ color: 0x6c7278, roughness: 0.4, metalness: 0.85 });

  M.rack = new THREE.MeshStandardMaterial({
    color: 0x1a2027, roughness: 0.46, metalness: 0.62,
    map: rackFaceTex, emissive: 0x9be8ff, emissiveMap: rackLedTex, emissiveIntensity: 1.35,
  });
  M.rackSide = new THREE.MeshStandardMaterial({ color: 0x14191e, roughness: 0.5, metalness: 0.65 });
  M.screen = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  M.screenDark = new THREE.MeshStandardMaterial({ color: 0x0a0d10, roughness: 0.28, metalness: 0.35 });

  M.wood = new THREE.MeshStandardMaterial({ color: 0x8a6748, roughness: 0.58, metalness: 0.03, map: woodTex });
  M.walnut = new THREE.MeshStandardMaterial({ color: 0x5d4230, roughness: 0.52, metalness: 0.04, map: woodTex });
  M.woodDark = new THREE.MeshStandardMaterial({ color: 0x3f2e22, roughness: 0.6, metalness: 0.03, map: woodTex });
  M.woodLight = new THREE.MeshStandardMaterial({ color: 0xa98a63, roughness: 0.6, metalness: 0.02, map: woodTex });
  M.deskTop = new THREE.MeshStandardMaterial({ color: 0xd9d5cc, roughness: 0.55, metalness: 0.03 });
  M.fabric = new THREE.MeshStandardMaterial({ color: 0x9a8f80, roughness: 0.98, metalness: 0.0 });
  M.fabricBlue = new THREE.MeshStandardMaterial({ color: 0x53616e, roughness: 0.98, metalness: 0.0 });
  M.fabricDark = new THREE.MeshStandardMaterial({ color: 0x3a4148, roughness: 0.98, metalness: 0.0 });
  M.leather = new THREE.MeshStandardMaterial({ color: 0x4b3a2e, roughness: 0.62, metalness: 0.03 });
  M.rug = new THREE.MeshStandardMaterial({ color: 0x6a6258, roughness: 1.0, metalness: 0.0 });

  M.ceramic = new THREE.MeshStandardMaterial({ color: 0xe9e7e1, roughness: 0.26, metalness: 0.04 });
  M.counter = new THREE.MeshStandardMaterial({ color: 0x3f4649, roughness: 0.32, metalness: 0.18 });
  M.cabinet = new THREE.MeshStandardMaterial({ color: 0x5a4b3c, roughness: 0.6, metalness: 0.04, map: woodTex });
  M.fridge = new THREE.MeshStandardMaterial({ color: 0xb9bcbd, roughness: 0.3, metalness: 0.6 });

  M.foliage = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0 });
  M.leaf = new THREE.MeshStandardMaterial({ color: 0x4f6b43, roughness: 0.94, metalness: 0.0 });
  M.leafDark = new THREE.MeshStandardMaterial({ color: 0x3a5032, roughness: 0.96, metalness: 0.0 });
  M.leafLight = new THREE.MeshStandardMaterial({ color: 0x6d8755, roughness: 0.92, metalness: 0.0 });
  M.trunk = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.95, metalness: 0.0 });
  M.hedge = new THREE.MeshStandardMaterial({ color: 0x46563b, roughness: 0.98, metalness: 0.0 });
  M.planter = new THREE.MeshStandardMaterial({ color: 0x2b2f31, roughness: 0.55, metalness: 0.35 });
  M.granite = new THREE.MeshStandardMaterial({ color: 0x2f3234, roughness: 0.34, metalness: 0.12, map: marbleTex });
  M.cable = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.82, metalness: 0.1 });
  M.cableBlue = new THREE.MeshStandardMaterial({ color: 0x2f6f96, roughness: 0.85, metalness: 0.05 });
  M.cableYellow = new THREE.MeshStandardMaterial({ color: 0xa8873f, roughness: 0.85, metalness: 0.05 });
  M.cove = new THREE.MeshBasicMaterial({ color: 0xffd9a6, toneMapped: false });
  M.handrail = new THREE.MeshStandardMaterial({ color: 0x3a3025, roughness: 0.4, metalness: 0.7 });

  M.carBody = new THREE.MeshStandardMaterial({ color: 0x39434e, roughness: 0.26, metalness: 0.6 });
  M.carGlass = new THREE.MeshPhysicalMaterial({
    color: 0x1c2a33, metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.72,
    envMapIntensity: 1.6, depthWrite: false,
  });
  M.tire = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.95, metalness: 0.02 });
  M.headlight = new THREE.MeshBasicMaterial({ color: 0xfff0d0, toneMapped: false });

  M.pv = new THREE.MeshStandardMaterial({ color: 0x152434, roughness: 0.22, metalness: 0.45, emissive: 0x06131d, emissiveIntensity: 0.35 });
  M.pvFrame = new THREE.MeshStandardMaterial({ color: 0x9ca3a7, roughness: 0.32, metalness: 0.85 });

  /* a warm, diffuse crown core that reads through the lantern glass
     without the flat white clip of a MeshBasicMaterial */
  M.lanternCore = new THREE.MeshStandardMaterial({
    color: 0x3a2514, roughness: 0.62, metalness: 0.1,
    emissive: 0xffae66, emissiveIntensity: 1.35,
  });

  M.glowWarm = new THREE.MeshBasicMaterial({ color: 0xffe3b5, toneMapped: false });
  M.glowSoft = new THREE.MeshBasicMaterial({ color: 0xffd49a, toneMapped: false });
  M.glowWhite = new THREE.MeshBasicMaterial({ color: 0xf3f6fa, toneMapped: false });
  M.glowCool = new THREE.MeshBasicMaterial({ color: 0xbfe9ff, toneMapped: false });
  M.glowCyan = new THREE.MeshBasicMaterial({ color: 0x78e8ff, toneMapped: false });
  M.glowGreen = new THREE.MeshBasicMaterial({ color: 0x8cf2b0, toneMapped: false });

  /* distant skyline: cool silhouettes with a sparse, dim window grid.
     Kept deliberately matte so the city reads as depth, not as bright
     stripes floating behind the tower. */
  M.cityWall = new THREE.MeshStandardMaterial({
    color: 0x2f3a46, roughness: 0.94, metalness: 0.06,
    emissive: 0x0a1119, emissiveIntensity: 0.5,
  });
  M.cityWarm = new THREE.MeshBasicMaterial({ color: 0x7a5f3f });
  M.cityCool = new THREE.MeshBasicMaterial({ color: 0x536d7a });

  /* server-room feature wall */
  M.serverPanel = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.82, metalness: 0.18 });
  M.serverTrim = new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.5, metalness: 0.5 });
  M.glowRed = new THREE.MeshBasicMaterial({ color: 0xff6b5e, toneMapped: false });
  M.red = new THREE.MeshStandardMaterial({ color: 0x8f2f2a, roughness: 0.45, metalness: 0.35 });

  M.lineCyan = new THREE.LineBasicMaterial({ color: 0x7fe4ff, transparent: true, opacity: 0.5 });
  M.lineCyanSoft = new THREE.LineBasicMaterial({ color: 0x6fc6e2, transparent: true, opacity: 0.2 });
  M.lineWarm = new THREE.LineBasicMaterial({ color: 0xdfe8ec, transparent: true, opacity: 0.32 });

  M.textures = {
    stoneTex, pavingTex, grassTex, carpetTex, ceilingTex, woodTex,
    tileTex, esdTex, asphaltTex, rackFaceTex, rackLedTex, screenTex, marbleTex,
  };

  /* Base tints used by the existing per-room data overlay.  They are
     deliberately quiet so they never fight the architecture. */
  M.usage = {
    office: 0x7c93a9,
    meeting: 0x8794a3,
    lobby: 0x9a8f7d,
    server: 0x5f9a9a,
    services: 0x8b8e90,
    storage: 0x94836c,
  };

  return M;
}

/* ---------------- sky ---------------- */

/* A Z-up dusk dome.  A procedural shader keeps the horizon clean at any
   resolution and makes the environment used for glass reflections match
   the visible sky exactly. */
export function createSky() {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(-0.88, -0.30, 0.24).normalize() },
    uZenith: { value: new THREE.Color(0x15253f) },
    uUpper: { value: new THREE.Color(0x46608a) },
    uHorizon: { value: new THREE.Color(0xd6b394) },
    uHaze: { value: new THREE.Color(0xefbd93) },
    uGround: { value: new THREE.Color(0x2a2b2c) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir, uZenith, uUpper, uHorizon, uHaze, uGround;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.z, -1.0, 1.0);
        float hi = smoothstep(-0.02, 0.72, h);
        vec3 col = mix(uHorizon, uUpper, smoothstep(0.02, 0.42, h));
        col = mix(col, uZenith, smoothstep(0.34, 0.95, h));
        float sun = max(dot(d, normalize(uSunDir)), 0.0);
        col += uHaze * (pow(sun, 6.0) * 0.32 + pow(sun, 48.0) * 0.35 + pow(sun, 420.0) * 1.4);
        float band = exp(-pow((h - 0.035) / 0.055, 2.0));
        col = mix(col, uHaze, band * 0.18);
        float below = smoothstep(0.015, -0.16, h);
        col = mix(col, uGround, below);
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        col += (dither - 0.5) * 0.004;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(540, 40, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -20;
  return { mesh, material: mat, uniforms };
}

/* ---------------- instancing helpers ---------------- */

const _dummy = {};

function instancedGeo(geo, material, items, opts) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(geo, material, items.length);
  const d = _dummy[THREE.REVISION] || (_dummy[THREE.REVISION] = new THREE.Object3D());
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    d.position.set(it.x, it.y, it.z);
    d.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
    d.scale.set(it.w || it.s || 1, it.d || it.s || 1, it.h || it.s || 1);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
    if (opts && opts.colors && opts.colors[i] != null) {
      mesh.setColorAt(i, opts.colors[i]);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = !(opts && opts.cast === false);
  mesh.receiveShadow = !(opts && opts.receive === false);
  return mesh;
}

export function instancedBoxes(material, items, opts) {
  return instancedGeo(new THREE.BoxGeometry(1, 1, 1), material, items, opts);
}

export function instancedCylinders(material, items, opts) {
  return instancedGeo(new THREE.CylinderGeometry(1, 1, 1, 12), material, items, opts);
}

export function instancedSpheres(material, items, opts) {
  return instancedGeo(new THREE.IcosahedronGeometry(1, 1), material, items, opts);
}

export function box(material, w, d, h, x, y, z, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), material);
  m.position.set(x, y, z);
  if (opts && opts.rx) m.rotation.x = opts.rx;
  if (opts && opts.ry) m.rotation.y = opts.ry;
  if (opts && opts.rz) m.rotation.z = opts.rz;
  m.castShadow = !(opts && opts.cast === false);
  m.receiveShadow = !(opts && opts.receive === false);
  return m;
}

export function plane(material, w, d, x, y, z, opts) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  m.position.set(x, y, z);
  if (opts && opts.rx != null) m.rotation.x = opts.rx;
  if (opts && opts.ry != null) m.rotation.y = opts.ry;
  if (opts && opts.rz != null) m.rotation.z = opts.rz;
  m.castShadow = false;
  m.receiveShadow = !(opts && opts.receive === false);
  return m;
}

export function cylinder(material, rTop, rBot, h, x, y, z, seg, opts) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg || 12), material);
  m.position.set(x, y, z);
  if (opts && opts.rx) m.rotation.x = opts.rx;
  if (opts && opts.ry) m.rotation.y = opts.ry;
  if (opts && opts.rz) m.rotation.z = opts.rz;
  m.castShadow = !(opts && opts.cast === false);
  m.receiveShadow = !(opts && opts.receive === false);
  return m;
}

export function pipe(material, x0, y0, z0, x1, y1, z1, r, seg) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return null;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg || 8), material);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len));
  m.castShadow = true;
  return m;
}

/* ---------------- picks / devices ---------------- */

export function tagPick(world, obj, layer, id, kind, modes, extra) {
  obj.userData.pick = Object.assign({ layer, id, kind, modes }, extra || {});
  if (obj.visible === false) obj.userData.pickOnly = true;
  world.picks[layer].push(obj);
  return obj;
}

export function addDevice(world, id, group, anchor, floorId, roomId, title) {
  if (!world.devices.has(id)) {
    world.devices.set(id, {
      id, group, anchor: anchor.clone(), floorId: floorId || null,
      roomId: roomId || null, title: title || id, statusMats: [],
    });
    world.labels.devices.push({ id, title: title || id, pos: anchor.clone() });
  }
  return world.devices.get(id);
}

export function registerStatusMat(dev, mat) {
  if (dev && mat) dev.statusMats.push(mat);
}

/* ---------------- soft contact shadow ---------------- */
let _contactTex = null;
export function contactShadow(materialless) {
  if (!_contactTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, "rgba(0,0,0,0.55)");
    grad.addColorStop(0.45, "rgba(0,0,0,0.28)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    _contactTex = new THREE.CanvasTexture(c);
    _contactTex.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshBasicMaterial({
    map: _contactTex, transparent: true, opacity: 0.9,
    depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
  });
}

export function addContactShadow(group, x, y, z, r, opacity) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), contactShadow());
  m.position.set(x, y, z + 0.015);
  m.material.opacity = opacity == null ? 0.9 : opacity;
  m.renderOrder = 1;
  group.add(m);
  return m;
}

/* ---------------- furniture batcher ----------------
   Interior fit-out is authored as hundreds of small boxes/cylinders.
   Batching every item that shares a material into a single InstancedMesh
   keeps the whole tower at a sensible draw-call count.  Items are grouped
   per floor so the exploded view can lift them with the storey. */
export class Batcher {
  constructor() {
    this.groups = new Map();
  }

  _add(kind, material, it) {
    if (!material) return;
    const key = material.uuid + "|" + kind;
    let e = this.groups.get(key);
    if (!e) {
      e = { material, kind, items: [] };
      this.groups.set(key, e);
    }
    e.items.push(it);
  }

  box(material, x, y, z, w, d, h, opts) {
    this._add("box", material, Object.assign({ x, y, z, w, d, h }, opts || {}));
  }

  cyl(material, x, y, z, r, h, opts) {
    const o = Object.assign({ x, y, z, w: r, d: h, h: r }, opts || {});
    /* CylinderGeometry's axis is local +Y; the scene is Z-up, so a
       vertical instance needs a 90° turn about X.  Pass rx:0 explicitly
       for a horizontal member (usually together with rz). */
    if (o.rx === undefined) o.rx = Math.PI / 2;
    this._add("cyl", material, o);
  }

  sphere(material, x, y, z, r, opts) {
    this._add("sphere", material, Object.assign({ x, y, z, w: r, d: r, h: r }, opts || {}));
  }

  flush(parent, opts) {
    const geos = {};
    for (const e of this.groups.values()) {
      let geo;
      if (e.kind === "box") geo = geos.box || (geos.box = new THREE.BoxGeometry(1, 1, 1));
      else if (e.kind === "cyl") geo = geos.cyl || (geos.cyl = new THREE.CylinderGeometry(1, 1, 1, 14));
      else geo = geos.sphere || (geos.sphere = new THREE.IcosahedronGeometry(1, 1));
      const mesh = instancedGeo(geo, e.material, e.items, {
        cast: !(opts && opts.cast === false),
        receive: true,
      });
      if (mesh) parent.add(mesh);
    }
    this.groups.clear();
  }
}
