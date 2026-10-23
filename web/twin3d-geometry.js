/* ============================================================
   Twin3D geometry entry (compatibility shim)
   ------------------------------------------------------------
   The WebGL renderer's world is now built by the presentation-scale
   architecture module (twin3d-arch.js) from the shared material /
   batching kit (twin3d-kit.js).  This module is kept as the stable
   import point for twin3d.js and the test harness.
   ============================================================ */

"use strict";

export { createMaterials } from "./twin3d-kit.js";
export { buildWorld } from "./twin3d-arch.js";
