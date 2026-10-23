/* ============================================================
   Step 8 — Building navigation
   A single panel that mirrors the physical hierarchy
       Building → Floor → Room / zone → Equipment
   and keeps it synchronized with the 3D scene:

     - building / floor / room selectors and clickable floor pills
       navigate the twin (and open the matching level details)
     - the searchable equipment list selects an item in 3D
     - a 3D selection (openDrawer / openLevel in app.js) updates
       this panel's scope, list highlight and the details drawer
     - "Building overview" is an explicit return-to-overview action

   The panel is display-only: it reads snapshot values, it never
   derives or fabricates measurements.
   ============================================================ */

"use strict";

const NAV = {
  open: false,
  scope: { buildingId: null, floorId: null, roomId: null, roof: false },
  query: "",
  filters: { type: "", status: "", source: "", anomaliesOnly: false },
  sig: "",
  selectSig: "",
  rowEls: new Map(),
  els: null,
  highlighted: null,
};

const NAV_KIND_LABELS = {
  room_light: "Lighting circuit",
  room_plug: "Socket circuit",
  fcu: "Fan coil unit",
  elevator: "Elevator",
  server_ups: "Server UPS",
  ev_charger: "EV charger",
  water_heater: "Water heater",
  battery_storage: "Battery storage",
  panel: "PV module",
  solar: "Solar array",
  inverter: "Inverter",
  hvac: "HVAC plant",
  lighting: "Lighting plant",
  plugs: "Plug loads",
  systems: "Systems",
};

/* Coarse type groups for the filter bar. Each kind belongs to at most one
   group so the filter reads as a partition of the equipment list. */
const NAV_TYPE_FILTERS = [
  { id: "", label: "All types", kinds: null },
  { id: "lighting", label: "Lighting & plugs",
    kinds: ["room_light", "room_plug", "lighting", "plugs"] },
  { id: "hvac", label: "HVAC", kinds: ["fcu", "hvac"] },
  { id: "systems", label: "Systems",
    kinds: ["elevator", "server_ups", "ev_charger", "water_heater", "systems"] },
  { id: "solar", label: "Solar PV", kinds: ["solar", "inverter", "panel"] },
];

const NAV_STATUS_FILTERS = [
  { id: "", label: "All statuses" },
  { id: "ok", label: "Normal" },
  { id: "warning", label: "Warning" },
  { id: "serious", label: "Serious" },
  { id: "critical", label: "Critical" },
];

const NAV_SOURCE_FILTERS = [
  { id: "", label: "All sources" },
  { id: "simulated", label: "Simulated" },
  { id: "live", label: "Live" },
  { id: "imported", label: "Imported" },
];

/* ---------------- small helpers ---------------- */

function navEls() {
  if (!NAV.els) {
    NAV.els = {
      panel: $("#navigator"),
      crumbs: $("#nav-crumbs"),
      building: $("#nav-building"),
      floor: $("#nav-floor"),
      room: $("#nav-room"),
      floors: $("#nav-floors"),
      overview: $("#nav-overview"),
      focus: $("#nav-focus"),
      search: $("#nav-search"),
      clearSearch: $("#nav-clear-search"),
      filterType: $("#nav-filter-type"),
      filterStatus: $("#nav-filter-status"),
      filterSource: $("#nav-filter-source"),
      filterAnomalies: $("#nav-filter-anomalies"),
      filterClear: $("#nav-filter-clear"),
      scope: $("#nav-scope"),
      list: $("#nav-equipment"),
      empty: $("#nav-empty"),
      emptyText: $("#nav-empty-text"),
      listWrap: $("#nav-list-wrap"),
      selected: $("#nav-selected"),
      selectedBtn: $("#nav-selected-btn"),
      selectedName: $("#nav-selected-name"),
      selectedKind: $("#nav-selected-kind"),
      close: $("#nav-close"),
    };
  }
  return NAV.els;
}

function navBuilding(id) {
  return (S.snap && (S.snap.buildings || []).find(b => b.id === id)) || null;
}

function navFloor(b, id) {
  return (b && (b.floors || []).find(f => f.id === id)) || null;
}

function navRoom(b, f, id) {
  return (f && (f.rooms || []).find(r => r.id === id)) || null;
}

function navKindLabel(d) {
  if (!d) return "Equipment";
  return NAV_KIND_LABELS[d.kind] || String(d.kind || "equipment").replace(/_/g, " ");
}

function navKw(v) {
  if (v == null || !isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0) + " kW";
  if (Math.abs(v) >= 10) return v.toFixed(1) + " kW";
  return v.toFixed(2) + " kW";
}

function navStatus(d) {
  return STATUS[d.status] || STATUS.ok;
}

/* ---------------- scope <-> selection synchronization ---------------- */

/* Where the 3D selection lives, falling back to the current view. */
function navigatorScopeFromState() {
  const sel = S.selection;
  if (sel) {
    if (sel.kind === "device") {
      const ctx = typeof deviceContext === "function" ? deviceContext(sel.id) : null;
      if (ctx) {
        return {
          buildingId: ctx.building.id,
          floorId: ctx.floor ? ctx.floor.id : null,
          roomId: ctx.room ? ctx.room.id : null,
          roof: !!ctx.roof,
        };
      }
      return { buildingId: null, floorId: null, roomId: null, roof: false };
    }
    const thing = typeof findTwinThing === "function" ? findTwinThing(sel.id) : null;
    if (thing) {
      if (thing.kind === "building") {
        return { buildingId: thing.data.id, floorId: null, roomId: null, roof: false };
      }
      if (thing.kind === "floor") {
        return { buildingId: thing.building.id, floorId: thing.data.id, roomId: null, roof: false };
      }
      if (thing.kind === "room") {
        return {
          buildingId: thing.building.id,
          floorId: thing.floor.id,
          roomId: thing.data.id,
          roof: false,
        };
      }
      if (thing.kind === "roof") {
        return { buildingId: thing.building.id, floorId: null, roomId: null, roof: true };
      }
    }
    return { buildingId: null, floorId: null, roomId: null, roof: false };
  }
  return navigatorScopeFromView();
}

function navigatorScopeFromView() {
  const v = S.view || {};
  if (v.mode === "building" || v.mode === "floor" || v.mode === "room" || v.mode === "roof") {
    return {
      buildingId: v.buildingId || null,
      floorId: (v.mode === "floor" || v.mode === "room") ? v.floorId || null : null,
      roomId: v.mode === "room" ? v.roomId || null : null,
      roof: v.mode === "roof",
    };
  }
  return { buildingId: null, floorId: null, roomId: null, roof: false };
}

/* Called by app.js whenever the view or the 3D selection changes.
   A view navigation follows the new view; a selection follows the
   selected object, which may live deeper than the current view. */
function syncNavigator(reason) {
  if (!S.snap) return;
  NAV.scope = reason === "view" ? navigatorScopeFromView() : navigatorScopeFromState();
  if (NAV.open) renderNavigator(reason === "selection");
}

/* ---------------- item model (built from the snapshot tree) ---------------- */

function navigatorItems() {
  const snap = S.snap || {};
  const buildings = snap.buildings || [];
  const byId = new Map(buildings.map(b => [b.id, b]));
  const items = [];
  const add = (d, extra) => {
    const b = byId.get(extra.buildingId) || null;
    const f = extra.floorId && b ? navFloor(b, extra.floorId) : null;
    const r = f && extra.roomId ? navRoom(b, f, extra.roomId) : null;
    items.push({
      d,
      building: b,
      floor: f,
      room: r,
      buildingId: extra.buildingId || null,
      floorId: extra.floorId || null,
      roomId: extra.roomId || null,
      roof: !!extra.roof,
      aggregate: !!extra.aggregate,
      search: [
        d.id, d.name, d.kind, navKindLabel(d),
        b ? b.name : "",
        f ? f.name : "",
        r ? r.name : "",
        r ? r.usage : "",
      ].filter(Boolean).join(" ").toLowerCase(),
    });
  };

  // campus-level aggregates first (roof hardware belongs to its building)
  const roofIds = new Set();
  for (const b of buildings) for (const id of b.roof_device_ids || []) roofIds.add(id);
  for (const d of snap.devices || []) {
    if (roofIds.has(d.id)) continue;
    add(d, { aggregate: true });
  }

  // every leaf: circuits, FCUs, elevator, UPS, EV charger, water heater
  for (const d of snap.equipment || []) {
    const p = d.parent || {};
    if (!p.building) continue;
    add(d, { buildingId: p.building, floorId: p.floor, roomId: p.room });
  }

  // solar array + inverter + individual modules live on the rooftop
  for (const b of buildings) {
    if (!b.solar) continue;
    const roof = b.roof_device_ids || [];
    for (const d of snap.devices || []) {
      if (roof.includes(d.id)) add(d, { buildingId: b.id, roof: true });
    }
    for (const p of snap.panels || []) {
      if ((p.parent || {}).building === b.id) add(p, { buildingId: b.id, roof: true });
    }
  }
  return items;
}

/* A non-empty search looks across all buildings; otherwise the
   selectors define the scope. Type/status/anomaly filters always apply. */
function navFilterTypes() {
  const group = NAV_TYPE_FILTERS.find(x => x.id === NAV.filters.type);
  return group ? group.kinds : null;
}

function navFiltersActive() {
  return !!(NAV.filters.type || NAV.filters.status || NAV.filters.source || NAV.filters.anomaliesOnly);
}

function navMatchesFilters(it) {
  const kinds = navFilterTypes();
  if (kinds && !kinds.includes(it.d.kind)) return false;
  if (NAV.filters.status && (it.d.status || "ok") !== NAV.filters.status) return false;
  if (NAV.filters.source && (it.d.source || "simulated") !== NAV.filters.source) return false;
  if (NAV.filters.anomaliesOnly && (it.d.status || "ok") === "ok") return false;
  return true;
}

function navFiltersSuffix() {
  const parts = [];
  const type = NAV_TYPE_FILTERS.find(x => x.id === NAV.filters.type);
  const status = NAV_STATUS_FILTERS.find(x => x.id === NAV.filters.status);
  const source = NAV_SOURCE_FILTERS.find(x => x.id === NAV.filters.source);
  if (type && type.id) parts.push("type: " + type.label);
  if (status && status.id) parts.push("status: " + status.label);
  if (source && source.id) parts.push("source: " + source.label);
  if (NAV.filters.anomaliesOnly) parts.push("anomalies only");
  return parts.length ? " · " + parts.join(" · ") : "";
}

function navigatorFilteredItems() {
  const scope = NAV.scope;
  const q = NAV.query.trim().toLowerCase();
  const inScope = (it) => {
    if (!scope.buildingId) return true;
    if (it.aggregate) return false;
    if (it.buildingId !== scope.buildingId) return false;
    if (scope.roof) return it.roof;
    if (scope.floorId && it.floorId !== scope.floorId) return false;
    if (scope.roomId && it.roomId !== scope.roomId) return false;
    return true;
  };
  return navigatorItems().filter(it => {
    if (q ? !it.search.includes(q) : !inScope(it)) return false;
    return navMatchesFilters(it);
  });
}

/* Build labelled groups in physical order: campus plant, then each
   building (floor plant, rooms), then the rooftop plant. */
function navigatorGroups(items) {
  const groups = new Map();
  const add = (key, label) => {
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    return groups.get(key);
  };
  for (const it of items) {
    if (it.aggregate) {
      add("campus", "Campus plant").items.push(it);
    } else if (it.roof) {
      add("roof:" + it.buildingId, (it.building ? it.building.name + " · " : "") + "Rooftop PV").items.push(it);
    } else if (it.room) {
      add([it.buildingId, it.floorId, it.roomId].join(":"),
          `${it.building.name} · ${it.floor.name} · ${it.room.name}`).items.push(it);
    } else if (it.floor) {
      add([it.buildingId, it.floorId, "plant"].join(":"),
          `${it.building.name} · ${it.floor.name} · Floor plant`).items.push(it);
    } else {
      add([it.buildingId, "plant"].join(":"),
          (it.building ? it.building.name + " · " : "") + "Building plant").items.push(it);
    }
  }
  const order = new Map();
  let i = 0;
  order.set("campus", i++);
  for (const b of S.snap.buildings || []) {
    for (const f of b.floors || []) {
      order.set([b.id, f.id, "plant"].join(":"), i++);
      for (const r of f.rooms || []) order.set([b.id, f.id, r.id].join(":"), i++);
    }
    order.set([b.id, "plant"].join(":"), i++);
    order.set("roof:" + b.id, i++);
  }
  return [...groups.values()].sort(
    (a, b) => (order.has(a.key) ? order.get(a.key) : 999) - (order.has(b.key) ? order.get(b.key) : 999));
}

/* ---------------- breadcrumbs ---------------- */

function navigatorCrumbs() {
  const s = NAV.scope;
  const b = navBuilding(s.buildingId);
  const f = navFloor(b, s.floorId);
  const r = navRoom(b, f, s.roomId);
  const sel = S.selection;
  const chain = [{ label: "Campus", go: navGoCampus }];
  if (b) chain.push({ label: b.name, go: () => navGoBuilding(b.id) });
  if (f) chain.push({ label: f.name, go: () => navGoFloor(b.id, f.id) });
  if (r) chain.push({ label: r.name, go: () => navGoRoom(b.id, f.id, r.id) });
  if (s.roof) chain.push({ label: "Rooftop PV", go: () => navGoRoof(b.id) });
  if (sel && sel.kind === "device") {
    const thing = typeof findTwinThing === "function" ? findTwinThing(sel.id) : null;
    chain.push({
      label: thing && thing.kind === "device" ? thing.d.name : sel.id,
      go: () => navigatorPick(sel.id),
    });
  }
  return chain;
}

function renderNavigatorCrumbs() {
  const el = navEls().crumbs;
  const chain = navigatorCrumbs();
  el.textContent = "";
  chain.forEach((seg, i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "nav-sep";
      sep.textContent = "›";
      el.append(sep);
    }
    const current = i === chain.length - 1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-crumb" + (current ? " current" : "");
    btn.textContent = seg.label;
    if (current) btn.setAttribute("aria-current", "page");
    else btn.addEventListener("click", seg.go);
    el.append(btn);
  });
}

/* ---------------- selectors + floor pills ---------------- */

function navOption(value, label, disabled) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  if (disabled) o.disabled = true;
  return o;
}

function rebuildNavigatorSelectors() {
  const els = navEls();
  const s = NAV.scope;
  const b = navBuilding(s.buildingId);

  // building
  els.building.textContent = "";
  els.building.append(navOption("", "All buildings (campus)"));
  for (const bb of S.snap.buildings || []) els.building.append(navOption(bb.id, bb.name));
  els.building.value = b ? b.id : "";

  // floor
  els.floor.textContent = "";
  if (!b) {
    els.floor.append(navOption("", "Choose a building", true));
    els.floor.disabled = true;
  } else {
    els.floor.disabled = false;
    els.floor.append(navOption("", "All floors"));
    for (const f of b.floors || []) els.floor.append(navOption(f.id, f.name));
    els.floor.value = s.floorId || "";
  }

  // room / zone
  els.room.textContent = "";
  if (!b) {
    els.room.append(navOption("", "Choose a building", true));
    els.room.disabled = true;
  } else if (!s.floorId) {
    els.room.disabled = false;
    els.room.append(navOption("", "All rooms / zones"));
    for (const f of b.floors || []) {
      if (!(f.rooms || []).length) continue;
      const g = document.createElement("optgroup");
      g.label = f.name;
      for (const r of f.rooms) g.append(navOption(r.id, r.name));
      els.room.append(g);
    }
    els.room.value = s.roomId || "";
  } else {
    const f = navFloor(b, s.floorId);
    els.room.disabled = false;
    els.room.append(navOption("", "All rooms / zones"));
    for (const r of (f && f.rooms) || []) els.room.append(navOption(r.id, r.name));
    els.room.value = s.roomId || "";
  }
}

function navigatorSelectSignature() {
  const s = NAV.scope;
  const b = navBuilding(s.buildingId);
  return [
    s.buildingId || "", s.floorId || "", s.roomId || "",
    ((S.snap && S.snap.buildings) || []).map(x => x.id).join(","),
    b ? (b.floors || []).map(f => f.id).join(",") : "",
  ].join("|");
}

function renderNavigatorFloors() {
  const el = navEls().floors;
  const b = navBuilding(NAV.scope.buildingId);
  el.textContent = "";
  if (!b) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const mk = (label, active, go, title) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-floor-pill" + (active ? " selected" : "");
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.addEventListener("click", go);
    el.append(btn);
  };
  mk("All", !NAV.scope.floorId, navOverview, "Building overview");
  for (const f of b.floors || []) {
    mk("F" + f.level, NAV.scope.floorId === f.id, () => navGoFloor(b.id, f.id), f.name);
  }
}

function updateOverviewAction() {
  const els = navEls();
  const b = navBuilding(NAV.scope.buildingId);
  els.overview.textContent = b ? "⌂ Building overview" : "⌂ Campus overview";
  els.overview.title = b
    ? "Return to the " + b.name + " overview"
    : "Return to the campus overview";
}

/* ---------------- navigation actions ---------------- */

function navGoCampus() {
  closeDrawer();
  setView("campus");
}

function navGoBuilding(id) {
  if (!id) { navGoCampus(); return; }
  if (typeof openLevel === "function") openLevel(id);
  else setView("building", { buildingId: id });
}

function navGoFloor(buildingId, floorId) {
  if (typeof openLevel === "function") openLevel(floorId);
  else setView("floor", { buildingId, floorId });
}

function navGoRoom(buildingId, floorId, roomId) {
  if (typeof openLevel === "function") openLevel(roomId);
  else setView("room", { buildingId, floorId, roomId });
}

function navGoRoof(buildingId) {
  closeDrawer();
  setView("roof", { buildingId });
}

/* Explicit return-to-overview action (also used by the "All" floor pill). */
function navOverview() {
  const bId = NAV.scope.buildingId || (S.view && S.view.buildingId);
  closeDrawer();
  if (bId) setView("building", { buildingId: bId });
  else setView("campus");
}

/* ---------------- equipment list ---------------- */

function navRowElement(it) {
  const li = document.createElement("li");
  li.className = "nav-item";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-row";
  btn.dataset.device = it.d.id;

  const dot = document.createElement("span");
  dot.className = "nav-dot";
  const main = document.createElement("span");
  main.className = "nav-row-main";
  const name = document.createElement("span");
  name.className = "nav-row-name";
  name.textContent = it.d.name;
  const sub = document.createElement("span");
  sub.className = "nav-row-sub";
  const kw = document.createElement("span");
  kw.className = "nav-row-kw";
  const alert = document.createElement("span");
  alert.className = "nav-row-alert hidden";
  alert.setAttribute("aria-label", "Active anomaly");
  main.append(name, sub);
  btn.append(dot, main, kw, alert);
  li.append(btn);

  const row = { btn, dot, sub, kw, alert, item: it, name };
  patchNavigatorRow(row, it.d);
  NAV.rowEls.set(it.d.id, row);
  return li;
}

function patchNavigatorRow(row, d) {
  const st = navStatus(d);
  row.dot.style.background = cssVar(st.color);
  row.dot.title = st.label;
  const where = row.item.room ? row.item.room.name
    : row.item.floor ? row.item.floor.name
    : row.item.roof ? "Rooftop"
    : row.item.aggregate ? "Campus aggregate"
    : (row.item.building ? row.item.building.name : "");
  // the group heading already names the location; keep the row compact
  row.sub.textContent = navKindLabel(d) + " · " + st.label;
  row.kw.textContent = navKw(d.actual);
  row.btn.title = `${d.name} — ${navKindLabel(d)} · ${st.label}${where ? " · " + where : ""}`;
  row.btn.setAttribute("aria-label", row.btn.title);
  const flagged = (d.status || "ok") !== "ok";
  row.alert.classList.toggle("hidden", !flagged);
  row.alert.textContent = flagged ? "⚠" : "";
  row.alert.title = flagged ? st.label : "";
  row.btn.classList.toggle("has-anomaly", flagged);
}

function navigatorScopeLabel(count) {
  const s = NAV.scope;
  const b = navBuilding(s.buildingId);
  const q = NAV.query.trim();
  const suffix = navFiltersSuffix();
  if (q) return `${count} match${count === 1 ? "" : "es"} for “${q}” · all buildings${suffix}`;
  if (!b) return `All buildings · ${count} items${suffix}`;
  const f = navFloor(b, s.floorId);
  const r = navRoom(b, f, s.roomId);
  let path = b.name;
  if (s.roof) path += " · Rooftop PV";
  else {
    path += " · " + (f ? f.name : "All floors");
    if (r) path += " · " + r.name;
  }
  return `${path} · ${count} item${count === 1 ? "" : "s"}${suffix}`;
}

function renderNavigatorList(items) {
  const els = navEls();
  els.list.textContent = "";
  NAV.rowEls.clear();

  for (const g of navigatorGroups(items)) {
    const head = document.createElement("li");
    head.className = "nav-group-label";
    const label = document.createElement("span");
    label.className = "nav-group-name";
    label.textContent = g.label;
    const count = document.createElement("span");
    count.className = "nav-group-count";
    count.textContent = String(g.items.length);
    head.append(label, count);
    els.list.append(head);
    for (const it of g.items) els.list.append(navRowElement(it));
  }

  els.scope.textContent = navigatorScopeLabel(items.length);
  els.empty.classList.toggle("hidden", items.length > 0);
  els.list.classList.toggle("hidden", items.length === 0);
  if (!items.length) {
    const q = NAV.query.trim();
    if (q && navFiltersActive()) {
      els.emptyText.textContent = `No equipment matches “${q}” with the active filters.`;
    } else if (q) {
      els.emptyText.textContent = `No equipment matches “${q}”.`;
    } else if (navFiltersActive()) {
      els.emptyText.textContent = "No equipment matches the active filters.";
    } else {
      els.emptyText.textContent = "No equipment in this scope.";
    }
    els.clearSearch.textContent = (q || navFiltersActive())
      ? "Clear search & filters" : "Clear";
  }
}

function scrollNavigatorToSelection() {
  const sel = S.selection && S.selection.id;
  if (!sel) return;
  const row = NAV.rowEls.get(sel);
  if (!row) return;
  const wrap = navEls().listWrap;
  const rr = row.btn.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  if (rr.top < wr.top + 2 || rr.bottom > wr.bottom - 2) {
    wrap.scrollTop += rr.top - wr.top - Math.max(0, (wrap.clientHeight - rr.height) / 2);
  }
}

function highlightNavigatorSelection(forceScroll) {
  const selId = (S.selection && S.selection.id) || null;
  for (const [id, row] of NAV.rowEls) {
    const on = id === selId;
    row.btn.classList.toggle("selected", on);
    if (on) row.btn.setAttribute("aria-current", "true");
    else row.btn.removeAttribute("aria-current");
  }
  if (selId && (forceScroll || selId !== NAV.highlighted)) scrollNavigatorToSelection();
  NAV.highlighted = selId;
}

function renderNavigatorSelected() {
  const els = navEls();
  const sel = S.selection;
  if (!sel || !S.snap) {
    els.selected.classList.add("hidden");
    return;
  }
  let name = sel.id;
  let kind = sel.kind;
  const thing = typeof findTwinThing === "function" ? findTwinThing(sel.id) : null;
  if (thing) {
    if (thing.kind === "device") {
      name = thing.d.name;
      kind = navKindLabel(thing.d);
    } else if (thing.kind === "roof") {
      name = thing.building.name + " Rooftop";
      kind = "Rooftop PV";
    } else {
      name = thing.data.name;
      kind = thing.kind.charAt(0).toUpperCase() + thing.kind.slice(1);
    }
  }
  els.selectedName.textContent = name;
  els.selectedKind.textContent = kind;
  els.selected.classList.remove("hidden");
}

/* ---------------- filter bar ---------------- */

function updateNavigatorFilterControls() {
  const els = navEls();
  if (!els.filterType || !els.filterStatus) return;
  if (!els.filterType.options.length) {
    for (const f of NAV_TYPE_FILTERS) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.label;
      els.filterType.append(o);
    }
    for (const f of NAV_STATUS_FILTERS) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.label;
      els.filterStatus.append(o);
    }
    for (const f of NAV_SOURCE_FILTERS) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.label;
      els.filterSource.append(o);
    }
  }
  els.filterType.value = NAV.filters.type;
  els.filterStatus.value = NAV.filters.status;
  els.filterSource.value = NAV.filters.source;
  const anomaliesOn = !!NAV.filters.anomaliesOnly;
  els.filterAnomalies.classList.toggle("active", anomaliesOn);
  els.filterAnomalies.setAttribute("aria-pressed", anomaliesOn ? "true" : "false");
  els.filterClear.classList.toggle("hidden", !navFiltersActive());
}

function clearNavigatorFilters(includeQuery) {
  const els = navEls();
  if (includeQuery) {
    NAV.query = "";
    if (els.search) els.search.value = "";
  }
  NAV.filters = { type: "", status: "", source: "", anomaliesOnly: false };
  if (els.filterType) els.filterType.value = "";
  if (els.filterStatus) els.filterStatus.value = "";
  if (els.filterSource) els.filterSource.value = "";
  if (els.search && includeQuery) els.search.focus();
  renderNavigator(false);
}

/* ---------------- render entry points ---------------- */

function navigatorSignature() {
  const s = NAV.scope;
  const snap = S.snap || {};
  return [
    s.buildingId || "", s.floorId || "", s.roomId || "", s.roof ? "r" : "",
    NAV.query,
    NAV.filters.type, NAV.filters.status, NAV.filters.source, NAV.filters.anomaliesOnly ? "a" : "",
    (snap.buildings || []).length,
    (snap.equipment || []).length,
    (snap.panels || []).length,
    (snap.devices || []).length,
  ].join("|");
}

function renderNavigator(forceScroll) {
  if (!NAV.open || !S.snap) return;
  const els = navEls();

  const selectSig = navigatorSelectSignature();
  if (selectSig !== NAV.selectSig) {
    NAV.selectSig = selectSig;
    rebuildNavigatorSelectors();
  } else {
    // scope may have changed without changing the option lists
    const b = navBuilding(NAV.scope.buildingId);
    els.building.value = b ? b.id : "";
    if (b) {
      els.floor.value = NAV.scope.floorId || "";
      els.room.value = NAV.scope.roomId || "";
    }
  }

  renderNavigatorCrumbs();
  renderNavigatorFloors();
  updateOverviewAction();
  updateNavigatorFilterControls();

  const items = navigatorFilteredItems();
  renderNavigatorList(items);
  renderNavigatorSelected();
  highlightNavigatorSelection(forceScroll !== false);
  NAV.sig = navigatorSignature();
}

/* Called once per snapshot poll: patch values in place so the list
   does not lose its scroll position or keyboard focus. */
function updateNavigator() {
  if (!NAV.open || !S.snap) return;
  if (navigatorSignature() !== NAV.sig) {
    renderNavigator(false);
    highlightNavigatorSelection(true);
    return;
  }
  const byId = new Map();
  for (const d of S.snap.devices || []) byId.set(d.id, d);
  for (const d of S.snap.panels || []) byId.set(d.id, d);
  for (const d of S.snap.equipment || []) byId.set(d.id, d);
  for (const [id, row] of NAV.rowEls) {
    const d = byId.get(id);
    if (d) patchNavigatorRow(row, d);
  }
  highlightNavigatorSelection(false);
  renderNavigatorSelected();
}

/* ---------------- panel open / close ---------------- */

function openNavigator(force, opts) {
  opts = opts || {};
  const els = navEls();
  if (!els.panel) return;
  const open = force != null ? force : !NAV.open;
  NAV.open = open;
  els.panel.classList.toggle("hidden", !open);
  const rb = $("#rail-buildings");
  if (rb) {
    rb.classList.toggle("active", open);
    rb.setAttribute("aria-pressed", open ? "true" : "false");
  }
  if (typeof shellSyncLaunchers === "function") shellSyncLaunchers();

  if (!open) {
    NAV.highlighted = null;
    return;
  }
  if (typeof toggleSimPop === "function") toggleSimPop(false);
  syncNavigator("open");
  renderNavigator(true);
  if (opts.focusSearch) {
    els.search.focus();
    els.search.select();
  }
}

function toggleNavigator(force, opts) {
  openNavigator(force, opts);
}

function isNavigatorOpen() {
  return NAV.open;
}

/* Selecting a row focuses the same object in the 3D scene (camera moves
   to its room/floor/building) and opens its details panel. */
function navigatorPick(id) {
  if (!id || typeof openDrawer !== "function") return;
  openDrawer(id);
  if (typeof focusSelection === "function") focusSelection();
  highlightNavigatorSelection(true);
}

/* ---------------- wiring ---------------- */

function initNavigator() {
  const els = navEls();
  if (!els.panel) return;

  els.close.addEventListener("click", () => openNavigator(false));

  els.search.addEventListener("input", () => {
    NAV.query = els.search.value;
    renderNavigator(false);
  });
  els.search.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (els.search.value) {
      els.search.value = "";
      NAV.query = "";
      renderNavigator(false);
    } else {
      // On the Assets page the panel is the page's content — keep it open.
      if (typeof SHELL !== "undefined" && SHELL.page === "assets") return;
      openNavigator(false);
    }
  });
  els.clearSearch.addEventListener("click", () => clearNavigatorFilters(true));

  if (els.filterType) {
    els.filterType.addEventListener("change", () => {
      NAV.filters.type = els.filterType.value;
      renderNavigator(false);
    });
  }
  if (els.filterStatus) {
    els.filterStatus.addEventListener("change", () => {
      NAV.filters.status = els.filterStatus.value;
      renderNavigator(false);
    });
  }
  if (els.filterSource) {
    els.filterSource.addEventListener("change", () => {
      NAV.filters.source = els.filterSource.value;
      renderNavigator(false);
    });
  }
  if (els.filterAnomalies) {
    els.filterAnomalies.addEventListener("click", () => {
      NAV.filters.anomaliesOnly = !NAV.filters.anomaliesOnly;
      renderNavigator(false);
    });
  }
  if (els.filterClear) {
    els.filterClear.addEventListener("click", () => clearNavigatorFilters(true));
  }

  // selectors drive the 3D view (and open the matching level details)
  els.building.addEventListener("change", () => {
    const id = els.building.value;
    if (id) navGoBuilding(id);
    else navGoCampus();
  });
  els.floor.addEventListener("change", () => {
    const b = navBuilding(NAV.scope.buildingId);
    if (!b) return;
    const id = els.floor.value;
    if (id) navGoFloor(b.id, id);
    else navOverview();
  });
  els.room.addEventListener("change", () => {
    const b = navBuilding(NAV.scope.buildingId);
    if (!b) return;
    const id = els.room.value;
    if (!id) {
      const f = navFloor(b, NAV.scope.floorId);
      if (f) navGoFloor(b.id, f.id);
      else navOverview();
      return;
    }
    const thing = typeof findTwinThing === "function" ? findTwinThing(id) : null;
    if (thing && thing.kind === "room") navGoRoom(b.id, thing.floor.id, id);
  });

  els.overview.addEventListener("click", navOverview);
  els.focus.addEventListener("click", () => {
    if (typeof focusSelection === "function") focusSelection();
  });

  els.list.addEventListener("click", (e) => {
    const row = e.target.closest(".nav-row");
    if (row) navigatorPick(row.dataset.device);
  });
  // Rows are buttons, so Tab already works; arrows move within the list and
  // Home / End jump to the ends, as users expect from a listbox.
  els.list.addEventListener("keydown", (e) => {
    const rows = Array.from(els.list.querySelectorAll(".nav-row"));
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    if (next < 0 || next === i) return;
    e.preventDefault();
    rows[next].focus();
  });

  els.selectedBtn.addEventListener("click", () => {
    const sel = S.selection;
    if (!sel) return;
    if (sel.kind === "device") openDrawer(sel.id);
    else if (typeof openLevel === "function") openLevel(sel.id);
  });

  // "/" focuses the equipment search from anywhere outside a field, but
  // never steals focus from an open modal dialog.
  window.addEventListener("keydown", (e) => {
    const tag = ((e.target && e.target.tagName) || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (e.key !== "/") return;
    if (typeof KB !== "undefined" && KB.helpOpen) return;
    if (typeof kbExternalModalOpen === "function" && kbExternalModalOpen()) return;
    e.preventDefault();
    if (!NAV.open) openNavigator(true);
    els.search.focus();
    els.search.select();
  });
}

initNavigator();
