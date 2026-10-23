/* ============================================================
   Step 10 — keyboard access
   ------------------------------------------------------------
   The perspective scene is a canvas, so its objects are invisible to
   the accessibility tree.  This module adds a roving keyboard focus
   over the same objects the mouse can click:

     Tab            reach the canvas (it is focusable)
     ← → ↑ ↓        move through the scene objects in draw order
     Home / End     jump to the first / last object
     Enter / Space  open the focused object (drawer or level view)
     Esc            clear the scene focus, then fall through to
                    the normal "close panel / go up a level" handler

   Scene focus is drawn as a white dashed ring (scene.js) and every
   move is announced through the #sr-status live region.  Global
   shortcuts cover the visualization modes, the exploded view and
   the keyboard-help dialog.
   ============================================================ */

"use strict";

const KB = {
  active: false,        // the canvas owns keyboard focus
  focusId: null,        // object currently under the keyboard ring
  pointerRing: false,   // ring armed by a pointer/script focus, not the keyboard
  helpOpen: false,
  returnFocus: null,    // element to restore after the help dialog
};

function kbAnnounce(message) {
  const live = document.getElementById("sr-status");
  if (!live) return;
  // clearing first makes repeated announcements speak again
  live.textContent = "";
  requestAnimationFrame(() => { live.textContent = message; });
}

function kbKindLabel(kind) {
  return ({
    panel: "Solar panel", device: "Equipment", room: "Room",
    floor: "Floor", building: "Building", roof: "Rooftop",
  })[kind] || "Object";
}

function kbObjectName(id, kind) {
  if (typeof findTwinThing === "function") {
    const thing = findTwinThing(id);
    if (thing) {
      if (thing.kind === "device") return thing.d && thing.d.name ? thing.d.name : id;
      if (thing.data && thing.data.name) return thing.data.name;
      if (thing.building && thing.building.name) return thing.building.name;
    }
  }
  if (typeof findTwinDevice === "function") {
    const d = findTwinDevice(id);
    if (d && d.name) return d.name;
  }
  return id;
}

function kbDescribe(id, kind) {
  const list = (typeof sceneSelectables === "function") ? sceneSelectables() : [];
  const i = list.findIndex(x => x.id === id);
  const at = i >= 0 ? `, ${i + 1} of ${list.length}` : "";
  return `${kbKindLabel(kind)} ${kbObjectName(id, kind)}${at}`;
}

function kbFocusObject(id, kind) {
  KB.focusId = id;
  KB.active = true;
  KB.pointerRing = false;
  if (typeof sceneInvalidate === "function") sceneInvalidate();
  kbAnnounce(`Scene focus: ${kbDescribe(id, kind)}. Press Enter to open.`);
}

function kbClearFocus(silent) {
  KB.focusId = null;
  KB.pointerRing = false;
  if (typeof sceneInvalidate === "function") sceneInvalidate();
  if (!silent) kbAnnounce("Scene focus cleared.");
}

function kbMoveFocus(step) {
  const list = (typeof sceneSelectables === "function") ? sceneSelectables() : [];
  if (!list.length) { kbAnnounce("Nothing to select in this view yet."); return; }
  let i = list.findIndex(x => x.id === KB.focusId);
  if (i < 0) i = step > 0 ? -1 : 0;
  const next = (i + step + list.length) % list.length;
  kbFocusObject(list[next].id, list[next].kind);
}

function kbJumpFocus(toEnd) {
  const list = (typeof sceneSelectables === "function") ? sceneSelectables() : [];
  if (!list.length) { kbAnnounce("Nothing to select in this view yet."); return; }
  const item = toEnd ? list[list.length - 1] : list[0];
  kbFocusObject(item.id, item.kind);
}

function kbActivateFocus() {
  if (!KB.focusId) {
    const list = (typeof sceneSelectables === "function") ? sceneSelectables() : [];
    if (list.length) kbFocusObject(list[0].id, list[0].kind);
    else kbAnnounce("Nothing to select in this view yet.");
    return;
  }
  const id = KB.focusId;
  const thing = (typeof findTwinThing === "function") ? findTwinThing(id) : null;
  if (thing && thing.kind !== "device") {
    if (typeof openLevel === "function") openLevel(id);
    kbAnnounce(`Opened ${kbDescribe(id, thing.kind)}.`);
    return;
  }
  if (typeof openDrawer === "function") openDrawer(id);
  const name = kbObjectName(id, "device");
  kbAnnounce(`Opened details for ${name}.`);
}

/* ---------------- keyboard help dialog ---------------- */

function kbHelpEls() {
  return {
    dialog: document.getElementById("kbd-help"),
    close: document.getElementById("kbd-help-close"),
  };
}

function kbOpenHelp() {
  const { dialog, close } = kbHelpEls();
  if (!dialog || KB.helpOpen) return;
  KB.returnFocus = document.activeElement;
  KB.helpOpen = true;
  dialog.classList.remove("hidden");
  if (close) close.focus({ preventScroll: true });
  kbAnnounce("Keyboard shortcuts dialog opened. Press Escape to close.");
}

function kbCloseHelp() {
  const { dialog, close } = kbHelpEls();
  KB.helpOpen = false;
  if (dialog) dialog.classList.add("hidden");
  const back = KB.returnFocus;
  KB.returnFocus = null;
  if (back && typeof back.focus === "function" && document.contains(back)) {
    back.focus({ preventScroll: true });
  }
  kbAnnounce("Keyboard shortcuts dialog closed.");
  if (close) close.blur();
}

function kbTrapHelpFocus(e) {
  if (e.key !== "Tab") return;
  const { dialog } = kbHelpEls();
  if (!dialog) return;
  const f = dialog.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

/* ---------------- visualization shortcuts ---------------- */

function kbSetVizMode(index) {
  const buttons = document.querySelectorAll("#viz-modes .viz-mode");
  const btn = buttons[index];
  if (!btn) return;
  btn.click();
  kbAnnounce(`Visualization: ${btn.textContent}.`);
}

function kbToggleExplode() {
  if (typeof VIEW === "undefined" || VIEW.mode !== "building"
      || typeof setExplodedView !== "function" || typeof EXPLODE === "undefined") {
    kbAnnounce("The exploded view is available in the building overview.");
    return;
  }
  setExplodedView(!EXPLODE.on);
  kbAnnounce(EXPLODE.on ? "Floors exploded." : "Floors collapsed.");
}

/* ---------------- wiring ---------------- */

/* Dialogs owned by other modules that are modal to the page. The keyboard
   help is tracked separately (KB.helpOpen); the AI Energy Report uses a
   visible .ei-report-backdrop with aria-modal="true". */
function kbExternalModalOpen() {
  return !!document.querySelector(".ei-report-backdrop:not(.hidden)");
}

function initKeyboard() {
  const canvas = document.getElementById("twin");
  const help = kbHelpEls();

  // input modality: used by CSS and by the scene focus ring policy
  let lastPointerDown = 0;
  window.addEventListener("keydown", () => {
    document.documentElement.classList.add("kbd-user");
  }, true);
  window.addEventListener("pointerdown", () => {
    lastPointerDown = performance.now();
    document.documentElement.classList.remove("kbd-user");
  }, true);

  if (canvas) {
    canvas.addEventListener("focus", () => {
      KB.active = true;
      // A click also focuses the focusable canvas.  Only a keyboard (or
      // scripted) focus arms the roving ring; otherwise the first Escape
      // would be swallowed clearing a ring the pointer user never asked for.
      const pointerFocus = performance.now() - lastPointerDown < 400;
      if (!KB.focusId && !pointerFocus) {
        const list = (typeof sceneSelectables === "function") ? sceneSelectables() : [];
        const selected = (typeof S !== "undefined" && S.selection) ? S.selection.id : null;
        const pick = selected && list.some(x => x.id === selected) ? selected : (list[0] && list[0].id);
        if (pick) {
          const item = list.find(x => x.id === pick);
          KB.focusId = pick;
          // Focus can come back to the canvas by script (e.g. the drawer
          // restores it after a mouse close).  Such a ring is not the
          // keyboard's and must not intercept the first Escape press.
          KB.pointerRing = !document.documentElement.classList.contains("kbd-user");
          kbAnnounce(`Scene keyboard focus. ${kbDescribe(pick, item ? item.kind : "device")}.`);
        } else {
          kbAnnounce("Scene keyboard focus. Use the arrow keys to select an object.");
        }
        if (typeof sceneInvalidate === "function") sceneInvalidate();
      }
    });
    canvas.addEventListener("blur", () => {
      // focus moved to the drawer or another control: hide the ring
      KB.active = false;
      if (typeof sceneInvalidate === "function") sceneInvalidate();
    });
    canvas.addEventListener("keydown", (e) => {
      // Shift + arrows drive the camera; plain arrows keep moving the
      // keyboard focus ring through the scene objects.
      if (e.shiftKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)
          && typeof cameraKeyboardOrbit === "function") {
        e.preventDefault(); e.stopPropagation();
        const step = e.repeat ? 12 : 26;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        cameraKeyboardOrbit(dx, dy);
        return;
      }
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault(); e.stopPropagation(); kbMoveFocus(1); break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault(); e.stopPropagation(); kbMoveFocus(-1); break;
        case "Home":
          e.preventDefault(); e.stopPropagation(); kbJumpFocus(false); break;
        case "End":
          e.preventDefault(); e.stopPropagation(); kbJumpFocus(true); break;
        case "Enter":
        case " ":
          e.preventDefault(); e.stopPropagation(); kbActivateFocus(); break;
        case "Escape":
          if (KB.focusId) {
            e.preventDefault();
            if (KB.pointerRing) {
              // no visible ring to clear — let Esc close the panel or
              // walk up the hierarchy on this same press
              kbClearFocus(true);
            } else {
              e.stopImmediatePropagation();
              kbClearFocus();
            }
          }
          break;
        default:
          break;
      }
    });
  }

  if (help.dialog) {
    help.dialog.addEventListener("keydown", kbTrapHelpFocus);
    if (help.close) help.close.addEventListener("click", kbCloseHelp);
    help.dialog.addEventListener("click", (e) => {
      if (e.target === help.dialog) kbCloseHelp();
    });
    const opener = document.getElementById("kbd-help-btn");
    if (opener) opener.addEventListener("click", kbOpenHelp);
  }

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    const tag = (t && t.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "select" || tag === "textarea"
      || (t && t.isContentEditable);

    if (KB.helpOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        kbCloseHelp();
      }
      return;
    }
    // The AI Energy Report is an aria-modal dialog with its own focus trap.
    // Global shortcuts must not fire behind it; Esc still closes it even if
    // focus has escaped the backdrop.
    if (typeof kbExternalModalOpen === "function" && kbExternalModalOpen()) {
      if (e.key === "Escape" && typeof closeReport === "function") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeReport();
      }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "?") {
      e.preventDefault();
      kbOpenHelp();
      return;
    }
    // 1-6 pick a visualization mode when the focus is not on a control
    if (/^[1-6]$/.test(e.key) && !(t && t.closest && t.closest("button, select"))) {
      e.preventDefault();
      kbSetVizMode(Number(e.key) - 1);
      return;
    }
    if (e.key === "e" || e.key === "E") {
      kbToggleExplode();
    }
    if (e.key === "a" || e.key === "A") {
      // Route through the shell launcher so a hidden stage (Settings,
      // Intelligence) navigates to the Alarms destination instead of
      // opening an invisible window inside the hidden stage.
      if (typeof shellToggleAlarmCenterWindow === "function") {
        e.preventDefault();
        shellToggleAlarmCenterWindow();
      } else if (typeof toggleAlarms === "function") {
        e.preventDefault();
        toggleAlarms();
      }
    }
  });
}
