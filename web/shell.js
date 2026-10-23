/* ============================================================
   Phase 2 — application shell and hash router
   ------------------------------------------------------------
   This module adds the enterprise frame around the existing single-page
   application. It deliberately does not rewrite the dashboard, twin,
   navigator, inspector, alarm center or intelligence modules. Legacy
   elements are moved into the shell, not removed or cloned.

   Routes:
     #/overview
     #/twin/campus | building/:id | floor/:id | room/:id | roof/:id
     #/assets | #/assets/:deviceId
     #/analytics/production|consumption|heatmap
     #/alarms
     #/intelligence
     #/settings
   Legacy #campus / #roof / #b1 / #b1f2 / #b1f2r2 resolve to these.
   ============================================================ */

"use strict";

const SHELL = {
  initialized: false,
  applying: false,
  page: "overview",
  route: null,
  lastHash: "",
  historyOnView: true,
  sidebarOpen: false,
};

const SHELL_PAGES = {
  overview: {
    title: "Overview",
    subtitle: "Portfolio summary and live operating state for the simulated campus.",
    nav: "shell-nav-overview",
    compat: null,
  },
  twin: {
    title: "Digital Twin",
    subtitle: "Campus, building, floor and room navigation in the existing interactive twin.",
    nav: "rail-home",
    compat: null,
  },
  assets: {
    title: "Assets & Equipment",
    subtitle: "Search, filter and inspect the equipment registry; a row opens the device inspector.",
    // The rail equipment icon is a window toggle: it opens /assets when the
    // page is elsewhere, then opens or closes the equipment window in place.
    // Its pressed state comes from actual visibility (shellSyncLaunchers), so
    // it must not receive route-active styling independent of the window.
    nav: null,
    compat: null,
  },
  analytics: {
    title: "Energy Analytics",
    subtitle: "Production, consumption, grid exchange, playback and heatmap summaries.",
    nav: "shell-nav-analytics",
    compat: null,
  },
  alarms: {
    title: "Alarms",
    subtitle: "Simulated alarm lifecycle, filters and operator close-out.",
    // Phase 10: the rail alarm icon toggles the floating Alarm Center instead
    // of owning a page route, so it must not receive route-active styling.
    nav: null,
    compat: null,
  },
  fleet: {
    title: "Fleet",
    subtitle: "Sites, sources and equipment across the monitored portfolio.",
    nav: "shell-nav-fleet",
    compat: null,
  },
  intelligence: {
    title: "Energy Intelligence",
    subtitle: "Health, waste impact, priority issues and recommended actions.",
    nav: "rail-trend",
    compat: {
      kicker: "Data provenance",
      title: "Simulated campus data",
      text: "Health scores, waste and cost projections are calculated from simulated sensor readings with the documented formulas — nothing here is metered or measured from physical equipment. The offline rule engine is deterministic; the optional Claude enrichment falls back to it when unavailable.",
      actions: [],
    },
  },
  settings: {
    title: "Settings",
    subtitle: "Simulation, display and operator controls.",
    nav: "rail-settings",
    compat: null,
  },
  notfound: {
    title: "Page not found",
    subtitle: "The requested route does not exist.",
    nav: null,
    compat: null,
  },
};

const SHELL_NAV_PAGES = ["overview", "twin", "fleet", "alarms", "analytics", "intelligence", "assets", "settings"];
const SHELL_ROUTE_CLASSES = SHELL_NAV_PAGES.concat(["notfound"]).map(p => "route-" + p);

function shellEl(id) { return document.getElementById(id); }
function shellEscape(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function shellHashPath(h) {
  return String(h || "").replace(/^#/, "").trim();
}
function shellSameView(a, b) {
  return !!a && !!b && a.mode === b.mode
    && (a.buildingId || null) === (b.buildingId || null)
    && (a.floorId || null) === (b.floorId || null)
    && (a.roomId || null) === (b.roomId || null);
}
function shellCurrentView() {
  return typeof S !== "undefined" && S.view ? S.view : VIEW;
}

/* ---------------- legacy and view route mapping ---------------- */

function shellLegacyToPath(path) {
  const p = String(path || "").replace(/^#/, "");
  if (!p) return "/overview";
  if (p === "campus") return "/twin/campus";
  if (p === "roof") return "/twin/roof/b1";
  if (p === "b1" || p === "b2") return "/twin/building/" + p;
  if (typeof findTwinThing === "function") {
    const thing = findTwinThing(p);
    if (thing && thing.kind === "building") return "/twin/building/" + p;
    if (thing && thing.kind === "floor") return "/twin/floor/" + p;
    if (thing && thing.kind === "room") return "/twin/room/" + p;
  }
  if (/^b[12]f[1-3]$/.test(p)) return "/twin/floor/" + p;
  if (/^b[12]f[1-3]r[1-4]$/.test(p)) return "/twin/room/" + p;
  return null;
}

function shellPathFromView(view) {
  const v = view || {};
  if (!v.mode || v.mode === "campus") return "/twin/campus";
  if (v.mode === "roof") return "/twin/roof/" + (v.buildingId || "b1");
  if (v.mode === "building" && v.buildingId) return "/twin/building/" + v.buildingId;
  if (v.mode === "floor" && v.floorId) return "/twin/floor/" + v.floorId;
  if (v.mode === "room" && v.roomId) return "/twin/room/" + v.roomId;
  return "/overview";
}

function shellHashForPath(path) {
  return "#" + (String(path || "/overview").replace(/^#/, "").replace(/^\/?/, "/"));
}

function shellParseHash(hash) {
  let raw = shellHashPath(hash);
  if (!raw) raw = "/overview";
  if (!raw.startsWith("/")) {
    const legacy = shellLegacyToPath(raw);
    if (legacy) return { legacy: true, path: legacy, page: "twin", view: raw };
    raw = "/" + raw;
  }
  const parts = raw.split("/").filter(Boolean);
  const page = parts[0] || "overview";
  if (page === "overview" && parts.length === 1) return { path: "/overview", page: "overview" };
  if (page === "twin") {
    const kind = parts[1] || "campus";
    if (kind === "campus") return { path: "/twin/campus", page: "twin", mode: "campus" };
    if (kind === "building" && parts[2]) return { path: raw, page: "twin", mode: "building", buildingId: parts[2] };
    if (kind === "floor" && parts[2]) return { path: raw, page: "twin", mode: "floor", floorId: parts[2] };
    if (kind === "room" && parts[2]) return { path: raw, page: "twin", mode: "room", roomId: parts[2] };
    if (kind === "roof" && parts[2]) return { path: raw, page: "twin", mode: "roof", buildingId: parts[2] };
    return { path: raw, page: "notfound" };
  }
  if (page === "assets") {
    return { path: parts[1] ? "/assets/" + parts[1] : "/assets", page: "assets", deviceId: parts[1] || null };
  }
  if (page === "analytics") {
    const tab = parts[1] || "production";
    if (["production", "consumption", "heatmap"].includes(tab)) {
      return { path: raw, page: "analytics", analyticsTab: tab };
    }
    return { path: raw, page: "notfound" };
  }
  if (page === "alarms" && parts.length === 1) return { path: "/alarms", page: "alarms" };
  if (page === "fleet" && parts.length === 1) return { path: "/fleet", page: "fleet" };
  if (page === "intelligence" && parts.length === 1) return { path: "/intelligence", page: "intelligence" };
  if (page === "settings" && parts.length === 1) return { path: "/settings", page: "settings" };
  return { path: raw, page: "notfound" };
}

function shellViewFromRoute(route) {
  if (!route) return null;
  if (route.page !== "twin") return null;
  if (route.mode === "campus") return { mode: "campus" };
  if (route.mode === "building") return { mode: "building", buildingId: route.buildingId };
  if (route.mode === "floor") {
    const f = (typeof PRESENT !== "undefined" && PRESENT.floors && PRESENT.floors[route.floorId])
      || (typeof findTwinThing === "function" ? findTwinThing(route.floorId) : null);
    const buildingId = (typeof PRESENT !== "undefined" && PRESENT.floors && PRESENT.floors[route.floorId])
      ? PRESENT.floors[route.floorId].towerId
      : (f && f.building ? f.building.id : null);
    return { mode: "floor", buildingId, floorId: route.floorId };
  }
  if (route.mode === "room") {
    const r = (typeof PRESENT !== "undefined" && PRESENT.rooms && PRESENT.rooms[route.roomId])
      || (typeof findTwinThing === "function" ? findTwinThing(route.roomId) : null);
    const buildingId = (typeof PRESENT !== "undefined" && PRESENT.rooms && PRESENT.rooms[route.roomId])
      ? PRESENT.rooms[route.roomId].towerId
      : (r && r.building ? r.building.id : null);
    const floorId = (typeof PRESENT !== "undefined" && PRESENT.rooms && PRESENT.rooms[route.roomId])
      ? PRESENT.rooms[route.roomId].floorId
      : (r && r.floor ? r.floor.id : null);
    return { mode: "room", buildingId, floorId, roomId: route.roomId };
  }
  if (route.mode === "roof") return { mode: "roof", buildingId: route.buildingId || "b1" };
  return null;
}

/* ---------------- shell construction ---------------- */

function shellIcon(name) {
  if (name === "overview") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>';
  }
  if (name === "alertsFeed") {
    // a live feed list — deliberately distinct from the alarm-center bell
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4.5 6.5h15"/><path d="M4.5 12h9.5"/><path d="M4.5 17.5h6"/><circle cx="18.4" cy="16.8" r="2.4"/></svg>';
  }
  if (name === "repair") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 4.2l1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6L5.2 10.5l4.6-1.7z"/><path d="M18.5 3.5v3"/><path d="M17 5h3"/></svg>';
  }
  if (name === "trendPanel") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3.1l2.2-5.6 3.2 11 2.5-7.1 1.6 3.6H21"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M6.5 15.5l4-5 3.5 2.5 4.5-6"/></svg>';
}

function shellAddLabel(btn, text) {
  if (!btn || btn.querySelector(".rail-label")) return;
  const span = document.createElement("span");
  span.className = "rail-label";
  span.textContent = text;
  btn.append(span);
}

function shellMakeNavButton(id, label, iconName) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = id;
  btn.className = "rail-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = shellIcon(iconName);
  shellAddLabel(btn, label);
  return btn;
}

function shellGroup(label, buttons) {
  const group = document.createElement("div");
  group.className = "nav-group";
  const heading = document.createElement("span");
  heading.className = "nav-group-label";
  heading.textContent = label;
  group.append(heading);
  buttons.forEach(b => b && group.append(b));
  return group;
}

function shellBuildSidebar() {
  const rail = document.querySelector(".rail");
  const slot = shellEl("app-sidebar-slot");
  if (!rail || !slot) return;
  slot.appendChild(rail);
  rail.classList.add("app-sidebar");
  rail.setAttribute("aria-label", "Primary navigation");

  const logo = rail.querySelector("#rail-logo");
  const icons = rail.querySelector(".rail-icons");
  const foot = rail.querySelector(".rail-foot");
  const home = rail.querySelector("#rail-home");
  const buildings = rail.querySelector("#rail-buildings");
  const trend = rail.querySelector("#rail-trend");
  const alerts = rail.querySelector("#rail-alerts");
  const equipment = rail.querySelector("#rail-equipment");
  const settings = rail.querySelector("#rail-settings");
  if (home) shellAddLabel(home, "Digital Twin");
  if (trend) shellAddLabel(trend, "Energy Intelligence");
  if (alerts) shellAddLabel(alerts, "Alarms");
  if (equipment) shellAddLabel(equipment, "Assets & Equipment");
  if (settings) shellAddLabel(settings, "Settings");
  if (buildings) shellAddLabel(buildings, "Scene navigator");
  // Phase 10: the two existing scene windows are toggle controls. Their
  // aria-pressed state mirrors the actual window visibility (shell.js).
  if (buildings) {
    buildings.setAttribute("aria-pressed", "false");
    buildings.title = "Show / hide the building navigator";
  }
  if (alerts) {
    alerts.setAttribute("aria-pressed", "false");
    alerts.setAttribute("aria-label", "Alarm center");
    alerts.title = "Show / hide the alarm center";
  }
  // Phase 11: Assets & Equipment is the page-fill navigator card on /assets.
  // The rail icon follows the same toggle convention as the scene windows.
  if (equipment) {
    equipment.setAttribute("aria-pressed", "false");
    equipment.setAttribute("aria-label", "Assets & Equipment");
    equipment.title = "Show / hide the Assets & Equipment window";
  }

  const brand = document.createElement("div");
  brand.className = "sidebar-brand";
  if (logo) {
    brand.append(logo);
    const text = document.createElement("span");
    text.className = "sidebar-brand-text";
    text.innerHTML = "<b>Energy AI</b><span>Operations platform</span>";
    brand.append(text);
  }
  rail.insertBefore(brand, rail.firstChild);

  const nav = document.createElement("div");
  nav.className = "sidebar-nav";
  nav.id = "shell-sidebar-nav";
  const overview = shellMakeNavButton("shell-nav-overview", "Overview", "overview");
  const analytics = shellMakeNavButton("shell-nav-analytics", "Energy Analytics", "analytics");
  const fleet = shellMakeNavButton("shell-nav-fleet", "Fleet", "analytics");
  // Phase 10: permanent launchers for the three floating windows that have no
  // existing rail destination. Distinct icons and labels keep them apart from
  // the Alarm Center bell and the Energy Intelligence page.
  const winAlerts = shellMakeNavButton("shell-win-alerts", "Alerts", "alertsFeed");
  winAlerts.title = "Show / hide the Alerts card";
  winAlerts.setAttribute("aria-pressed", "false");
  const winRepair = shellMakeNavButton("shell-win-repair", "Repair matching", "repair");
  winRepair.title = "Show / hide the Repair matching panel";
  winRepair.setAttribute("aria-pressed", "false");
  const winTrend = shellMakeNavButton("shell-win-trend", "Trend analysis", "trendPanel");
  winTrend.title = "Show / hide the Trend analysis panel";
  winTrend.setAttribute("aria-pressed", "false");
  nav.append(
    shellGroup("Operate", [overview, home, fleet, alerts]),
    shellGroup("Analyze", [analytics, trend]),
    shellGroup("Manage", [equipment, settings]),
    shellGroup("Workspace tools", [buildings]),
    shellGroup("Windows", [winAlerts, winRepair, winTrend])
  );
  if (icons) icons.remove();
  rail.insertBefore(nav, brand.nextSibling);
  if (foot) rail.append(foot);

  // Capture-phase click owner. Page destinations go through the shell router;
  // the window launchers are true toggles (open / close) and never navigate
  // unless the current page cannot display a floating window.
  rail.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!btn || !rail.contains(btn)) return;
    if (btn.id === "rail-buildings") {
      e.preventDefault();
      e.stopPropagation();
      shellToggleNavigatorWindow();
      shellCloseSidebar();
      return;
    }
    if (btn.id === "rail-alerts") {
      e.preventDefault();
      e.stopPropagation();
      shellToggleAlarmCenterWindow();
      shellCloseSidebar();
      return;
    }
    if (btn.id === "rail-equipment") {
      e.preventDefault();
      e.stopPropagation();
      shellToggleAssetsWindow();
      shellCloseSidebar();
      return;
    }
    if (btn.id === "shell-win-alerts" || btn.id === "shell-win-repair" || btn.id === "shell-win-trend") {
      e.preventDefault();
      e.stopPropagation();
      shellToggleWindowLauncher(btn.id);
      shellCloseSidebar();
      return;
    }
    const routes = {
      "shell-nav-overview": "/overview",
      "shell-nav-analytics": "/analytics/production",
      "shell-nav-fleet": "/fleet",
      "rail-home": "/twin/campus",
      "rail-trend": "/intelligence",
      "rail-settings": "/settings",
    };
    const path = routes[btn.id];
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    shellNavigate(path);
    shellCloseSidebar();
  }, true);

  // Keep the logo as the existing camera reset action; its accessible name
  // now describes both roles rather than adding a second logo destination.
  if (logo) {
    logo.setAttribute("aria-label", "Energy AI Platform — reset camera");
    logo.title = "Energy AI Platform — reset camera";
  }
}

/* ---------------- Phase 10: window launchers and state sync ----------------
   Every floating window keeps its sidebar launcher permanently visible. The
   launcher's pressed state is derived from the window's actual rendered
   visibility, so closing a window with its own ×, Escape, a dock pill, a
   route change or a poll leaves the control in sync. Launchers never hide:
   only the window changes state. */

const SHELL_ALERTS = { closed: false };

function shellIsMobileLayout() {
  return !window.matchMedia("(min-width: 761px)").matches;
}

function shellElementVisible(el) {
  if (!el) return false;
  if (el.classList.contains("hidden")) return false;
  return el.getClientRects().length > 0;
}

function shellStageVisible() {
  return shellElementVisible(document.getElementById("stage"));
}

function shellRouteShowsSidePanels() {
  return SHELL.page === "overview" || SHELL.page === "twin";
}

function shellAlertsCard() {
  return document.getElementById("alerts-card");
}

function shellAlertsOpen() {
  return shellElementVisible(shellAlertsCard());
}

function shellSyncLaunchers() {
  const set = (id, open) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.classList.toggle("active", !!open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
  };
  // The navigator card is shared: on /assets it is the Assets & Equipment
  // window, everywhere else it is the floating scene navigator. Only the
  // launcher for the current role mirrors its visibility, so closing the
  // equipment window never lights the scene-navigator icon (or vice versa).
  const navVisible = shellElementVisible(document.getElementById("navigator"));
  set("rail-buildings", SHELL.page !== "assets" && navVisible);
  set("rail-equipment", SHELL.page === "assets" && navVisible);
  set("rail-alerts", shellElementVisible(document.getElementById("alarm-center")));
  set("shell-win-alerts", shellAlertsOpen());
  set("shell-win-repair", shellElementVisible(shellSidePanel("repair")));
  set("shell-win-trend", shellElementVisible(shellSidePanel("trend")));
  // The alarm center and the device drawer are both docked top-right. When
  // they are open together the drawer sits above the center and would cover
  // its header close. Drop the drawer below the alarm header so both ×
  // controls stay visible and independently usable.
  const alarmEl = document.getElementById("alarm-center");
  const drawerEl = document.getElementById("device-drawer");
  const bothWindows = !!alarmEl && !!drawerEl
    && shellElementVisible(alarmEl) && shellElementVisible(drawerEl);
  if (drawerEl) drawerEl.classList.toggle("clear-alarm-head", bothWindows);
  // Phones stack both windows as bottom sheets. An alarm center with no rows
  // is short enough for the (taller) drawer to cover its header ×; keep the
  // center tall while the drawer is open so both independent closes stay
  // reachable, mirroring the desktop clearance above.
  if (alarmEl) alarmEl.classList.toggle("clear-drawer-head", bothWindows);
  shellSyncBannerClearance();
}

/* Phase 10 — the connection notice floats above every window. When a
   top-right window (Repair / Trend cards, alarm center, device drawer) is
   open, its header close control and the notice occupy the same corner; the
   notice wins on z-index, so clicks meant for the window's × hit the
   notice's own ×. Tuck the notice to the left of the rightmost such window
   so both controls stay visible and hit-testable. */
function shellSyncBannerClearance() {
  let right = 16;
  if (window.matchMedia("(min-width: 761px)").matches) {
    const clear = (el, gap) => {
      if (!shellElementVisible(el)) return;
      const r = el.getBoundingClientRect();
      right = Math.max(right, Math.round(window.innerWidth - r.left + gap));
    };
    clear(document.getElementById("alarm-center"), 12);
    clear(document.getElementById("device-drawer"), 12);
    for (const id of ["repair-card", "trend-card"]) {
      const card = document.getElementById(id);
      if (!shellElementVisible(card)) continue;
      // Only a card sharing the notice's corner needs clearance; once the
      // user drags it lower the notice can use the normal top-right spot.
      if (card.getBoundingClientRect().top < 180) clear(card, 16);
    }
  }
  document.documentElement.style.setProperty("--shell-banner-right", right + "px");
}

/* Phones show one bottom sheet at a time: opening one window tucks the other
   sheet windows away (the device drawer keeps its independent life). */
function shellPrepareMobileSheet(except) {
  if (!shellIsMobileLayout()) return;
  if (except !== "alerts" && shellAlertsOpen()) shellSetAlertsOpen(false);
  if (except !== "alarm" && typeof isAlarmsOpen === "function" && isAlarmsOpen()) {
    try { closeAlarms(); } catch (_) { /* ignore */ }
  }
  for (const key of ["repair", "trend"]) {
    if (key === except) continue;
    if (shellElementVisible(shellSidePanel(key))) shellSideSetOpen(key, false);
  }
}

function shellSetAlertsOpen(open) {
  const card = shellAlertsCard();
  if (!card) return;
  const mobile = shellIsMobileLayout();
  if (open && mobile) shellPrepareMobileSheet("alerts");
  card.classList.toggle("hidden", !open);
  card.classList.toggle("sheet-open", !!open && mobile);
  SHELL_ALERTS.closed = !open;
  shellSyncLaunchers();
}

function shellToggleAlertsCard() {
  if (shellAlertsOpen()) { shellSetAlertsOpen(false); return; }
  if (!shellStageVisible()) shellNavigate("/overview");
  shellSetAlertsOpen(true);
}

function shellToggleNavigatorWindow() {
  if (SHELL.page === "assets") {
    // The scene navigator owns a different window from the Assets page card.
    // Leave the assets route and open the scene navigator in the same action;
    // route application closes transient panels, so it must be reopened here.
    shellNavigate("/overview");
    if (typeof openNavigator === "function") openNavigator(true);
    shellSyncLaunchers();
    return;
  }
  if (shellElementVisible(document.getElementById("navigator"))) {
    if (typeof openNavigator === "function") openNavigator(false);
    shellSyncLaunchers();
    return;
  }
  if (!shellStageVisible()) shellNavigate("/overview");
  if (typeof openNavigator === "function") openNavigator(true);
  shellSyncLaunchers();
}

/* Assets & Equipment uses the same navigator card in page mode. Its rail icon
   is a true toggle: open the /assets destination when the page is elsewhere,
   otherwise open or close the card in place without navigating (so closing it
   never blanks the route or removes the launcher). */
function shellToggleAssetsWindow() {
  const nav = document.getElementById("navigator");
  if (SHELL.page !== "assets") {
    shellNavigate("/assets");
    if (!shellElementVisible(nav) && typeof openNavigator === "function") openNavigator(true);
    shellSyncLaunchers();
    return;
  }
  if (shellElementVisible(nav)) {
    if (typeof openNavigator === "function") openNavigator(false);
    shellSyncLaunchers();
    return;
  }
  if (typeof openNavigator === "function") openNavigator(true);
  shellSyncLaunchers();
}

function shellToggleAlarmCenterWindow() {
  const center = document.getElementById("alarm-center");
  if (!center) return;
  if (shellElementVisible(center)) {
    if (typeof closeAlarms === "function") closeAlarms();
    shellSyncLaunchers();
    return;
  }
  if (!shellStageVisible()) {
    // Settings / Intelligence hide the stage; the alarms page can host the
    // floating center, so use that existing destination instead of opening
    // an invisible overlay.
    shellNavigate("/alarms");
    return;
  }
  if (typeof openAlarms === "function") openAlarms(true);
  shellSyncLaunchers();
}

function shellToggleSideWindow(key) {
  if (shellElementVisible(shellSidePanel(key))) {
    shellSideSetOpen(key, false);
    return;
  }
  if (!shellRouteShowsSidePanels()) {
    // The right-side stack only exists on the scene pages; navigate there
    // rather than opening a panel the current page would not show.
    shellNavigate("/overview");
  }
  shellSideSetOpen(key, true);
  shellSyncLaunchers();
}

function shellToggleWindowLauncher(id) {
  if (id === "shell-win-alerts") shellToggleAlertsCard();
  else if (id === "shell-win-repair") shellToggleSideWindow("repair");
  else if (id === "shell-win-trend") shellToggleSideWindow("trend");
}

function shellInitWindowLaunchers() {
  const card = shellAlertsCard();
  if (card) {
    if (shellIsMobileLayout()) {
      card.classList.add("hidden");
      card.classList.remove("sheet-open");
    } else {
      card.classList.toggle("hidden", SHELL_ALERTS.closed);
    }
    const close = document.getElementById("alerts-close");
    if (close) close.addEventListener("click", () => shellSetAlertsOpen(false));
  }
  let wasMobile = shellIsMobileLayout();
  window.addEventListener("resize", () => {
    const nowMobile = shellIsMobileLayout();
    if (nowMobile !== wasMobile) {
      wasMobile = nowMobile;
      const c = shellAlertsCard();
      if (c) {
        c.classList.remove("sheet-open");
        c.classList.toggle("hidden", nowMobile ? true : SHELL_ALERTS.closed);
      }
    }
    shellSyncLaunchers();
  });
  shellSyncLaunchers();
}

/* ---------------- page and compatibility content ---------------- */

function shellSetText(id, text) {
  const el = shellEl(id);
  if (el) el.textContent = text;
}

function shellBreadcrumb(items) {
  const el = shellEl("shell-breadcrumb");
  if (!el) return;
  el.textContent = "";
  items.forEach((item, i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "shell-sep";
      sep.textContent = "/";
      el.append(sep);
    }
    const label = typeof item === "string" ? item : item.label;
    const path = typeof item === "object" ? item.path : null;
    const current = i === items.length - 1;
    const node = document.createElement(current || !path ? "span" : "button");
    node.className = "shell-crumb" + (current ? " current" : "") + (path && !current ? " shell-crumb-link" : "");
    node.textContent = label;
    if (node.tagName === "BUTTON") {
      node.type = "button";
      node.dataset.shellCrumb = path;
    }
    el.append(node);
  });
}

function shellLocationLabel(view) {
  if (!view) return "";
  if (view.mode === "campus") return "Campus";
  if (view.mode === "roof") return "Rooftop";
  if (view.mode === "building" && view.buildingId) {
    const t = typeof findTwinThing === "function" ? findTwinThing(view.buildingId) : null;
    return t && t.data ? t.data.name : view.buildingId;
  }
  if (view.mode === "floor" && view.floorId) {
    const t = typeof findTwinThing === "function" ? findTwinThing(view.floorId) : null;
    return t && t.data ? t.data.name : view.floorId;
  }
  if (view.mode === "room" && view.roomId) {
    const t = typeof findTwinThing === "function" ? findTwinThing(view.roomId) : null;
    return t && t.data ? t.data.name : view.roomId;
  }
  return "";
}

function shellSetPageActions(html) {
  const el = shellEl("page-actions");
  if (el) el.innerHTML = html || "";
}

function shellCompat(meta) {
  const el = shellEl("shell-compat");
  if (!el) return;
  if (!meta) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = `<div class="shell-compat-copy">
      <div class="shell-compat-kicker">${shellEscape(meta.kicker || "Phase 2 compatibility")}</div>
      <h2 class="shell-compat-title">${shellEscape(meta.title || "")}</h2>
      <p>${shellEscape(meta.text || "")}</p>
    </div>`;
  if (meta.actions && meta.actions.length) {
    const actions = document.createElement("div");
    actions.className = "shell-compat-actions";
    for (const a of meta.actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "shell-btn";
      b.textContent = a.label;
      b.dataset.shellAction = a.action;
      actions.append(b);
    }
    el.append(actions);
  }
}
/* Phase 4: the compatibility banners are gone, so their actions
   (focus-chart / open-heatmap / open-sim) were removed with them. The
   not-found page's go-overview / go-twin actions are handled in
   initShell's compat click listener. */

/* ---------------- overlay coordination ---------------- */

function shellCloseSidebar() {
  const shell = shellEl("app-shell");
  if (!shell) return;
  shell.classList.remove("sidebar-open");
  SHELL.sidebarOpen = false;
  const btn = shellEl("shell-sidebar-toggle");
  if (btn) btn.setAttribute("aria-expanded", "false");
  const scrim = shellEl("shell-scrim");
  if (scrim) scrim.classList.add("hidden");
}

function shellCloseTransientPanels() {
  if (typeof isNavigatorOpen === "function" && isNavigatorOpen()) {
    try { openNavigator(false); } catch (_) { /* ignore */ }
  }
  if (typeof isAlarmsOpen === "function" && isAlarmsOpen()) {
    try { closeAlarms(); } catch (_) { /* ignore */ }
  }
  try {
    if (typeof toggleSimPop === "function") {
      const pop = document.getElementById("sim-pop");
      if (pop && !pop.classList.contains("hidden")) toggleSimPop(false);
    }
  } catch (_) { /* ignore */ }
  if (typeof closeDrawer === "function") {
    try { closeDrawer(); } catch (_) { /* ignore */ }
  }
}

function shellCloseSidebarOnly() {
  shellCloseSidebar();
}

/* ---------------- route application ---------------- */

/* The navigator card doubles as the Assets & Equipment window. Name it for
   the role it currently plays so its header and × describe the right window. */
function shellSyncNavigatorLabels() {
  const onAssets = typeof SHELL !== "undefined" && SHELL.page === "assets";
  const panel = document.getElementById("navigator");
  const kicker = document.getElementById("nav-kicker");
  const close = document.getElementById("nav-close");
  if (panel) panel.setAttribute("aria-label", onAssets ? "Assets & Equipment" : "Building navigator");
  if (kicker) kicker.textContent = onAssets ? "Assets & Equipment" : "Building navigator";
  if (close) {
    const label = onAssets ? "Close Assets & Equipment window" : "Close building navigator";
    close.title = label;
    close.setAttribute("aria-label", label);
  }
}

function shellSetActive(page) {
  SHELL.page = page;
  shellSyncNavigatorLabels();
  document.querySelectorAll(".app-sidebar-slot .rail-btn").forEach((btn) => {
    const active = btn.id === (SHELL_PAGES[page] && SHELL_PAGES[page].nav);
    btn.classList.toggle("route-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  const shell = shellEl("app-shell");
  if (shell) {
    for (const cls of SHELL_ROUTE_CLASSES) shell.classList.remove(cls);
    shell.classList.add("route-" + page);
    shell.dataset.page = page;
  }
}

function shellHeaderFor(route, view) {
  const page = route.page;
  const meta = SHELL_PAGES[page] || SHELL_PAGES.notfound;
  const viewLabel = shellLocationLabel(view);
  let title = meta.title;
  let subtitle = meta.subtitle || "";
  const base = { label: "Energy Platform" };
  const twinHome = { label: "Digital Twin", path: "/twin/campus" };
  let crumbs = [base, { label: meta.title }];
  if (page === "twin") {
    if (view && view.mode === "building" && view.buildingId) {
      const t = typeof findTwinThing === "function" ? findTwinThing(view.buildingId) : null;
      const b = t && t.data ? t.data.name : view.buildingId;
      subtitle = `${b} · existing twin workspace`;
      crumbs = [base, twinHome, { label: b }];
    } else if (view && view.mode === "floor" && view.floorId) {
      const f = typeof findTwinThing === "function" ? findTwinThing(view.floorId) : null;
      const b = f && f.building ? f.building.name : null;
      const bid = f && f.building ? f.building.id : null;
      subtitle = `${viewLabel} · existing twin workspace`;
      crumbs = [base, twinHome];
      if (b && bid) crumbs.push({ label: b, path: "/twin/building/" + bid });
      crumbs.push({ label: viewLabel });
    } else if (view && view.mode === "room" && view.roomId) {
      const r = typeof findTwinThing === "function" ? findTwinThing(view.roomId) : null;
      const b = r && r.building ? r.building.name : null;
      const bid = r && r.building ? r.building.id : null;
      const f = r && r.floor ? r.floor.name : null;
      const fid = r && r.floor ? r.floor.id : null;
      subtitle = `${viewLabel} · existing twin workspace`;
      crumbs = [base, twinHome];
      if (b && bid) crumbs.push({ label: b, path: "/twin/building/" + bid });
      if (f && fid) crumbs.push({ label: f, path: "/twin/floor/" + fid });
      crumbs.push({ label: viewLabel });
    } else if (view && view.mode === "roof") {
      subtitle = "Rooftop solar plant · existing twin workspace";
      crumbs = [base, twinHome, { label: "Rooftop" }];
    } else {
      subtitle = "Campus overview · existing twin workspace";
      crumbs = [base, { label: "Digital Twin" }];
    }
  } else if (page === "assets") {
    if (route.deviceId) {
      const thing = typeof findTwinThing === "function" ? findTwinThing(route.deviceId) : null;
      const assetName = thing && thing.data ? thing.data.name : route.deviceId;
      subtitle = `${assetName} · existing inspector`;
      crumbs = [base, { label: meta.title, path: "/assets" }, { label: assetName }];
    } else {
      subtitle = meta.subtitle;
      crumbs = [base, { label: meta.title }];
    }
  } else if (page === "analytics") {
    const labels = { production: "Production", consumption: "Consumption", heatmap: "Heatmap playback" };
    subtitle = (labels[route.analyticsTab] || "Production") + " · existing analytics surfaces";
    crumbs = [base, { label: meta.title, path: "/analytics/production" },
      { label: labels[route.analyticsTab] || "Production" }];
  } else if (page === "alarms") {
    crumbs = [base, { label: meta.title }];
  } else if (page === "intelligence") {
    crumbs = [base, { label: meta.title }];
  } else if (page === "settings") {
    crumbs = [base, { label: meta.title }];
  } else if (page === "notfound") {
    crumbs = [base, { label: "Page not found" }];
  }
  shellSetText("page-title", title);
  shellSetText("page-subtitle", subtitle);
  shellBreadcrumb(crumbs);
  document.title = `${meta.title} · Energy AI Platform`;
  shellSetPageActions(page === "overview"
    ? '<span class="shell-badge info">Simulated · campus overview</span>'
    : page === "twin"
      ? `<span class="shell-badge info">${shellEscape(viewLabel || "Campus")}</span>`
      : page === "assets"
        ? '<span class="shell-badge warning">SIMULATED · equipment registry</span>'
        : page === "analytics"
          ? '<span class="shell-badge warning">SIMULATED · calculated estimates</span>'
          : page === "alarms"
            ? '<span class="shell-badge warning">SIMULATED alarms</span>'
            : page === "fleet"
              ? '<span class="shell-badge warning">SIMULATED · mock MQTT + imported dataset feeds</span>'
              : page === "intelligence"
              ? '<span class="shell-badge warning">SIMULATED · calculated estimates</span>'
              : page === "settings"
                ? '<span class="shell-badge warning">Affects the shared simulated state</span>'
                : "");
  shellCompat(meta.compat);
}

/* Deep links under /twin must name real scene objects. The assets routes
   already validate their ids; the twin routes must do the same instead of
   painting a header over an unresolved scene. */
function shellTwinRouteExists(route) {
  if (!route || route.page !== "twin") return false;
  const v = shellViewFromRoute(route);
  if (!v) return false;
  if (v.mode === "campus") return true;
  if (typeof findTwinThing !== "function") return true;
  if (v.mode === "roof") {
    const b = findTwinThing(v.buildingId || "b1");
    return !!b && b.kind === "building";
  }
  const id = v.mode === "room" ? v.roomId : v.mode === "floor" ? v.floorId : v.buildingId;
  if (!id) return false;
  const thing = findTwinThing(id);
  return !!thing && thing.kind === v.mode;
}

function shellApplyViewFromRoute(route) {
  const target = shellViewFromRoute(route);
  if (!target || typeof setView !== "function") return;
  const cur = shellCurrentView();
  if (shellSameView(cur, target)) return;
  try { setView(target.mode, target, { fromRoute: true }); } catch (_) { /* data not ready */ }
}

function shellApplyRoute(route, opts) {
  if (!route) return;
  const o = opts || {};
  const shell = shellEl("app-shell");
  if (!shell) return;
  SHELL.applying = true;
  SHELL.route = route;
  SHELL.lastHash = shellHashForPath(route.path);
  shellSyncPanelDragMode();
  shellSetActive(route.page);

  const view = shellCurrentView();
  shellHeaderFor(route, view);

  if (route.page === "overview") {
    shellCloseTransientPanels();
    if (typeof setView === "function") {
      const cur = shellCurrentView();
      if (!shellSameView(cur, { mode: "campus" })) setView("campus", {});
    }
  } else if (route.page === "twin") {
    if (!shellTwinRouteExists(route)) {
      SHELL.applying = false;
      return shellApplyRoute({ path: route.path, page: "notfound" }, { replace: true });
    }
    shellCloseTransientPanels();
    shellApplyViewFromRoute(route);
  } else if (route.page === "assets") {
    if (typeof closeAlarms === "function" && typeof isAlarmsOpen === "function" && isAlarmsOpen()) closeAlarms();
    try {
      if (typeof toggleSimPop === "function") {
        const pop = document.getElementById("sim-pop");
        if (pop && !pop.classList.contains("hidden")) toggleSimPop(false);
      }
    } catch (_) { /* ignore */ }
    if (route.deviceId) {
      const thing = typeof findTwinThing === "function" ? findTwinThing(route.deviceId) : null;
      if (!thing) {
        SHELL.applying = false;
        return shellApplyRoute({ path: route.path, page: "notfound" }, { replace: true });
      }
      let ctx = null;
      if (thing.kind === "device" && typeof deviceContext === "function") ctx = deviceContext(route.deviceId);
      if (thing.kind === "panel" || (thing.d && thing.d.kind === "panel")) {
        if (typeof setView === "function") setView("roof", { buildingId: "b1" });
      } else if (ctx && ctx.room) {
        if (typeof setView === "function") setView("room", {
          buildingId: ctx.building.id, floorId: ctx.floor.id, roomId: ctx.room.id,
        });
      } else if (ctx && ctx.floor) {
        if (typeof setView === "function") setView("floor", { buildingId: ctx.building.id, floorId: ctx.floor.id });
      } else if (ctx && ctx.building) {
        if (typeof setView === "function") setView(ctx.roof ? "roof" : "building", { buildingId: ctx.building.id });
      }
      if (typeof openDrawer === "function") openDrawer(route.deviceId);
      if (typeof openNavigator === "function") openNavigator(true);
    } else {
      if (typeof closeDrawer === "function") closeDrawer();
      if (typeof openNavigator === "function") openNavigator(true);
    }
    shellSetPageActions('<span class="shell-badge warning">SIMULATED · equipment registry</span>');
  } else if (route.page === "analytics") {
    shellCloseTransientPanels();
    if (route.analyticsTab === "heatmap") {
      const btn = document.querySelector('#viz-modes .viz-mode[data-mode="heatmap"]');
      if (btn) btn.click();
      if (typeof sceneInvalidate === "function") sceneInvalidate();
    }
    if (typeof renderAnalyticsPage === "function") renderAnalyticsPage(route.analyticsTab || "production");
  } else if (route.page === "fleet") {
    shellCloseTransientPanels();
    if (typeof renderFleetPage === "function") renderFleetPage();
  } else if (route.page === "alarms") {
    // Keep the stage behind the existing alarm center, but never leave the
    // device drawer underneath it.
    if (typeof closeDrawer === "function") closeDrawer();
    if (typeof openNavigator === "function" && typeof isNavigatorOpen === "function" && isNavigatorOpen()) openNavigator(false);
    try {
      if (typeof toggleSimPop === "function") {
        const pop = document.getElementById("sim-pop");
        if (pop && !pop.classList.contains("hidden")) toggleSimPop(false);
      }
    } catch (_) { /* ignore */ }
    if (typeof openAlarms === "function") openAlarms(true);
  } else if (route.page === "intelligence") {
    shellCloseTransientPanels();
    if (typeof renderIntelligence === "function" && S.intel) renderIntelligence(S.intel);
    else if (typeof pollIntelligence === "function") pollIntelligence();
    window.scrollTo({ top: 0, behavior: "auto" });
  } else if (route.page === "settings") {
    if (typeof closeAlarms === "function" && typeof isAlarmsOpen === "function" && isAlarmsOpen()) closeAlarms();
    if (typeof openNavigator === "function" && typeof isNavigatorOpen === "function" && isNavigatorOpen()) openNavigator(false);
    if (typeof closeDrawer === "function") closeDrawer();
    if (typeof renderSettingsPage === "function") renderSettingsPage();
  } else if (route.page === "notfound") {
    shellCloseTransientPanels();
    shellCompat(null);
    const el = shellEl("shell-compat");
    if (el) {
      el.classList.remove("hidden");
      el.innerHTML = `<div class="shell-notfound">
        <span class="shell-empty-code">404 · UNKNOWN ROUTE</span>
        <h2 class="shell-compat-title">Page not found</h2>
        <p>This destination is not implemented. Phase 2 defines the route boundary but not this page. Return to Overview or the existing Digital Twin.</p>
        <div class="shell-compat-actions">
          <button type="button" class="shell-btn primary" data-shell-action="go-overview">Open Overview</button>
          <button type="button" class="shell-btn" data-shell-action="go-twin">Open Digital Twin</button>
        </div>
      </div>`;
    }
    shellSetPageActions("");
    shellSetText("page-title", "Page not found");
    shellSetText("page-subtitle", "The requested route could not be resolved. No data was changed.");
    shellBreadcrumb(["Energy Platform", "Page not found"]);
    document.title = "Page not found · Energy AI Platform";
  }

  // The destination view may have changed after the route's first header
  // pass (setView is synchronous but the shell guard suppresses its hook).
  if (route.page === "twin" || route.page === "overview" || route.page === "assets") {
    shellHeaderFor(route, shellCurrentView());
  }

  if (!o.suppressHistory && !o.fromHistory) {
    const hash = shellHashForPath(route.path);
    if (hash !== location.hash) {
      try {
        if (o.replace) history.replaceState({ shell: true }, "", hash);
        else history.pushState({ shell: true }, "", hash);
      } catch (_) { /* file:// or restricted history */ }
    }
  }
  SHELL.lastHash = shellHashForPath(route.path);
  shellSyncLaunchers();
  SHELL.applying = false;
  shellSyncStatus();
}

/* ---------------- hash integration ---------------- */

/* Called by app.js applyHashView. Handles both new and legacy hashes. */
function shellApplyHash() {
  if (SHELL.applying) return true;
  if (location.hash === SHELL.lastHash) return true;
  const parsed = shellParseHash(location.hash);
  if (parsed.legacy) {
    const route = shellParseHash("#" + parsed.path);
    shellApplyRoute(route, { replace: true, suppressHistory: true });
    if (location.hash !== shellHashForPath(route.path)) {
      try { history.replaceState({ shell: true }, "", shellHashForPath(route.path)); } catch (_) { /* ignore */ }
    }
    return true;
  }
  shellApplyRoute(parsed, { fromHistory: true });
  return true;
}

/* Called on first snapshot before the legacy hash fallback. */
function shellResolveInitialRoute() {
  if (!location.hash || location.hash === "#") {
    shellApplyRoute(shellParseHash("#/overview"), { replace: true });
    return true;
  }
  return shellApplyHash();
}

/* ---------------- view/status synchronization ---------------- */

function shellOnViewChange(view) {
  if (!SHELL.initialized) return;
  const currentPage = SHELL.page;
  if (!SHELL.applying && (currentPage === "overview" || currentPage === "twin")) {
    const path = shellPathFromView(view || shellCurrentView());
    if (currentPage === "overview" && path !== "/twin/campus" && path !== "/overview") {
      // A scene interaction from Overview enters the Twin workspace.
      const route = shellParseHash("#" + path);
      if (route.page === "twin") {
        SHELL.page = "twin";
        SHELL.route = route;
        shellSetActive("twin");
        shellHeaderFor(route, view || shellCurrentView());
      }
    } else if (currentPage === "twin") {
      const route = shellParseHash("#" + path);
      SHELL.route = route;
      shellHeaderFor(route, view || shellCurrentView());
    }
    // Resetting the camera to campus on Overview must not silently rewrite
    // the URL to a Twin route: the page, title and active nav stay Overview.
    const staysOverview = currentPage === "overview" && path === "/twin/campus";
    const nextHash = staysOverview ? "#/overview" : shellHashForPath(path);
    if (nextHash !== location.hash && SHELL.historyOnView && !staysOverview) {
      try { history.pushState({ shell: true }, "", nextHash); } catch (_) { /* ignore */ }
    }
    SHELL.lastHash = nextHash;
  } else if (!SHELL.applying && currentPage !== "assets" && currentPage !== "notfound") {
    shellHeaderFor(SHELL.route || shellParseHash(location.hash), view || shellCurrentView());
  }
  shellSyncStatus();
}

function shellOnDrawerChange(id, open) {
  if (!SHELL.initialized || SHELL.applying) return;
  shellSyncLaunchers();
  if (SHELL.page !== "assets") return;
  const path = open && id ? "/assets/" + encodeURIComponent(id) : "/assets";
  const route = shellParseHash("#" + path);
  SHELL.route = route;
  shellHeaderFor(route, shellCurrentView());
  if (location.hash !== shellHashForPath(path)) {
    try { history.replaceState({ shell: true }, "", shellHashForPath(path)); } catch (_) { /* ignore */ }
  }
  SHELL.lastHash = shellHashForPath(path);
}

function shellSyncStatus() {
  const el = shellEl("shell-status");
  const text = shellEl("shell-status-text");
  if (!el || !text) return;
  const online = typeof NET !== "undefined" ? NET.online !== false : true;
  const snap = typeof S !== "undefined" ? S.snap : null;
  el.classList.toggle("online", online);
  el.classList.toggle("offline", !online);
  el.classList.toggle("simulated", !!snap);
  if (!snap) {
    text.textContent = online ? "Connecting…" : "Offline";
    return;
  }
  const sim = snap.sim || {};
  const paused = sim.paused ? " · paused" : "";
  text.textContent = `SIMULATED · ${online ? "Online" : "Offline"} · Day ${sim.day ?? "—"} ${sim.time ?? "—"}${paused}`;
}

/* ---------------- navigation ---------------- */

function shellNavigate(path, opts) {
  const o = opts || {};
  const route = shellParseHash("#" + String(path || "/overview").replace(/^#/, ""));
  shellApplyRoute(route, { replace: !!o.replace });
  shellCloseSidebar();
  return route;
}

function shellToggleSidebar(force) {
  const shell = shellEl("app-shell");
  const btn = shellEl("shell-sidebar-toggle");
  if (!shell) return;
  const open = force == null ? !SHELL.sidebarOpen : !!force;
  SHELL.sidebarOpen = open;
  shell.classList.toggle("sidebar-open", open);
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  const scrim = shellEl("shell-scrim");
  if (scrim) scrim.classList.toggle("hidden", !open);
}

function initShell() {
  if (SHELL.initialized) return;
  const shell = shellEl("app-shell");
  const stage = shellEl("stage");
  const below = shellEl("below-fold");
  if (!shell || !stage) return;
  document.body.classList.add("shell-mode");
  shellBuildSidebar();
  const stageHost = shellEl("stage-host");
  const belowHost = shellEl("belowfold-host");
  if (stageHost) stageHost.appendChild(stage);
  if (belowHost && below) belowHost.appendChild(below);
  // Phase 9: the repair and trend cards stay inside their left-stack, which
  // the scene-route CSS turns into the fixed right-side panel stack. No
  // re-parenting is needed anymore (the Phase 3 bottom-dock parking is gone).
  // Phase 8: the transient notification must be visible on every route and
  // never clipped by the stage (which is hidden on Settings/Intelligence).
  const notice = document.getElementById("conn-banner");
  if (notice && notice.parentElement !== document.body) document.body.appendChild(notice);
  SHELL.initialized = true;
  SHELL.applying = true;
  shellSetActive("overview");
  shellHeaderFor(shellParseHash("#/overview"), shellCurrentView());
  shellCompat(null);
  shellSyncStatus();
  SHELL.applying = false;

  const toggle = shellEl("shell-sidebar-toggle");
  if (toggle) toggle.addEventListener("click", () => shellToggleSidebar());
  const scrim = shellEl("shell-scrim");
  if (scrim) scrim.addEventListener("click", shellCloseSidebar);
  const breadcrumb = shellEl("shell-breadcrumb");
  if (breadcrumb) breadcrumb.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest("[data-shell-crumb]") : null;
    if (!b || !b.dataset.shellCrumb) return;
    shellNavigate(b.dataset.shellCrumb);
  });
  const compat = shellEl("shell-compat");
  if (compat) compat.addEventListener("click", (e) => {
    const action = e.target && e.target.closest ? e.target.closest("[data-shell-action]") : null;
    if (!action) return;
    const a = action.dataset.shellAction;
    if (a === "go-overview") shellNavigate("/overview", { replace: true });
    else if (a === "go-twin") shellNavigate("/twin/campus", { replace: true });
  });
  window.addEventListener("popstate", () => {
    if (!shellEl("app-shell")) return;
    shellApplyHash();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && SHELL.sidebarOpen) {
      e.preventDefault();
      shellCloseSidebar();
    }
  });
  window.addEventListener("net-state", shellSyncStatus);
  window.addEventListener("resize", () => {
    if (innerWidth > 1180) shellCloseSidebar();
  });
  shellInitPanelDrag();
  shellInitPanelResize();
  shellInitWindowRaise();
  shellInitSidePanels();
  shellInitWindowLaunchers();
}

/* ---------------- Phase 8: draggable floating panels ----------------
   The floating workspace panels (navigator, simulation popover, alerts
   card, alarm center overlay) can be dragged by their header so they stop
   covering the scene. Dragging is desktop-only (>760 px), never starts on
   a button/field, keeps the panel fully inside the viewport (and clear of
   the main navigation and shell topbar), and is disabled for the route
   modes where a panel is page content. Ordinary page sections are
   untouched.

   Phase 9 adds the device drawer, the repair and trend side panels to the
   same window set, raises the window the user last interacted with, and
   gives every floating window resize strips (right / bottom edges and a
   visible bottom-right grip) with per-window minimum sizes. */

const SHELL_PANEL_IDS = ["navigator", "sim-pop", "alerts-card", "alarm-center",
                         "device-drawer", "repair-card", "trend-card"];

const SHELL_RESIZE_MIN = {
  "navigator": [300, 240],
  "sim-pop": [248, 200],
  "alerts-card": [280, 140],
  "alarm-center": [320, 280],
  "device-drawer": [320, 240],
  "repair-card": [300, 160],
  "trend-card": [300, 160],
};

function shellPanelPageMode(el) {
  if (!el) return false;
  // Phase 10: the Alarm Center is a floating window on every route (it can
  // be closed without leaving the Alarms destination). Only the Assets
  // navigator is genuine page content.
  if (el.id === "navigator") return typeof SHELL !== "undefined" && SHELL.page === "assets";
  return false;
}

function shellResetPanelDrag(ids) {
  for (const id of ids || SHELL_PANEL_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    for (const prop of ["position", "left", "top", "right", "bottom",
                        "width", "height", "max-width", "max-height"]) {
      el.style.removeProperty(prop);
    }
    el.classList.remove("panel-dragged");
  }
}

/* Route changes toggle page modes: drop inline drag geometry when a panel
   becomes page content (or when the viewport drops to the mobile layout). */
function shellSyncPanelDragMode() {
  if (!window.matchMedia("(min-width: 761px)").matches) {
    shellResetPanelDrag();
    return;
  }
  const nav = document.getElementById("navigator");
  if (nav && shellPanelPageMode(nav)) shellResetPanelDrag(["navigator"]);
  const alarms = document.getElementById("alarm-center");
  if (alarms && shellPanelPageMode(alarms)) shellResetPanelDrag(["alarm-center"]);
}

/* Keep a dragged panel's header below the shell topbar: the topbar is a
   sibling stacking context above the stage, so anything dragged under it
   would lose its controls. */
function shellPanelMinTop() {
  if (!document.body.classList.contains("shell-mode")) return 0;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-topbar-h"));
  return (isFinite(v) ? v : 62) + 8;
}

/* Windows must not cover the main navigation either: the shell sidebar
   (full rail or the compact icon rail) keeps its left strip reserved. */
function shellPanelMinLeft() {
  if (!document.body.classList.contains("shell-mode")) return 8;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--shell-sidebar-w"));
  return (isFinite(v) ? v : 64) + 8;
}

function shellClampPanel(el) {
  if (!el || !el.classList.contains("panel-dragged")) return;
  const r = el.getBoundingClientRect();
  const maxX = Math.max(shellPanelMinLeft(), innerWidth - r.width);
  const maxY = Math.max(0, innerHeight - r.height);
  // the topbar/sidebar bounds win: a window taller than the free band keeps
  // its header below the topbar instead of sliding under it
  el.style.left = Math.max(shellPanelMinLeft(), Math.min(r.left, maxX)) + "px";
  el.style.top = Math.max(shellPanelMinTop(), Math.min(r.top, maxY)) + "px";
  // ...and a window that is now taller than the space below its header
  // shrinks to fit the viewport so its bottom controls (resize grip) stay
  // reachable instead of hanging off-screen
  const top = parseFloat(el.style.top) || 0;
  const availH = innerHeight - top - 8;
  if (r.height > availH && availH > 0) {
    const min = SHELL_RESIZE_MIN[el.id] || [260, 140];
    el.style.height = Math.max(min[1], availH) + "px";
  }
}

function shellInitPanelDrag() {
  const handles = [
    ["navigator", ".card-top"],
    ["sim-pop", ".card-top"],
    ["alerts-card", ".alerts-head"],
    ["alarm-center", ".alarm-head"],
    ["device-drawer", ".drawer-head"],
    ["repair-card", ".card-top"],
    ["trend-card", ".card-top"],
  ];
  for (const [id, handleSel] of handles) {
    const el = document.getElementById(id);
    if (!el) continue;
    const handle = el.querySelector(handleSel);
    if (!handle) continue;
    handle.classList.add("panel-drag-handle");
    handle.addEventListener("pointerdown", (e) => {
      if (!window.matchMedia("(min-width: 761px)").matches) return;
      if (e.button !== 0 || e.pointerType === "touch") return;
      if (shellPanelPageMode(el)) return;
      if (el.classList.contains("hidden")) return;
      // never drag from controls inside the header
      if (e.target.closest("button, input, select, textarea, a, [role='button']")) return;
      const rect = el.getBoundingClientRect();
      el.style.position = "fixed";
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.width = rect.width + "px";
      el.style.height = rect.height + "px";
      el.classList.add("panel-dragged");
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      document.body.classList.add("panel-dragging");

      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const move = (ev) => {
        const maxX = Math.max(shellPanelMinLeft(), innerWidth - rect.width);
        const maxY = Math.max(0, innerHeight - rect.height);
        // the topbar/sidebar bounds win so a tall window's header stays reachable
        el.style.left = Math.max(shellPanelMinLeft(), Math.min(ev.clientX - offX, maxX)) + "px";
        el.style.top = Math.max(shellPanelMinTop(), Math.min(ev.clientY - offY, maxY)) + "px";
      };
      const up = () => {
        document.body.classList.remove("panel-dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        shellClampPanel(el);
        shellSyncBannerClearance();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  window.addEventListener("resize", () => {
    shellSyncPanelDragMode();
    for (const id of SHELL_PANEL_IDS) shellClampPanel(document.getElementById(id));
  });
}

/* ---------------- Phase 9: window raise, resize, side panels ----------------
   The floating windows behave like one workspace: interacting with a window
   raises it above its siblings (it never climbs over the alarm center,
   drawer, topbar or notification, which keep their deliberate layers), and
   every window can be resized from its right/bottom edges or the visible
   bottom-right grip. Resizing works with mouse and touch (>=761 px); on
   phones the windows use the full-width sheet layout instead of resizing. */

const SHELL_Z_TOP_MAX = 54;   // below the alarm center (55), drawer (60), notice (80)
let SHELL_Z_TOP = 45;

function shellRaiseWindow(el) {
  if (!el) return;
  SHELL_Z_TOP = Math.min(SHELL_Z_TOP_MAX, SHELL_Z_TOP + 1);
  el.style.zIndex = String(SHELL_Z_TOP);
}

function shellInitWindowRaise() {
  // The repair/trend cards live in the fixed left-stack, so the whole stack
  // is raised as one unit until a card is dragged out on its own.
  const targets = ["navigator", "sim-pop", "alerts-card", "left-stack"];
  for (const id of targets) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("pointerdown", () => shellRaiseWindow(el), true);
  }
}

function shellAddResizeHandles(el) {
  for (const dir of ["e", "s", "se"]) {
    const h = document.createElement("div");
    h.className = "shell-resize shell-resize-" + dir;
    h.dataset.resizeDir = dir;
    h.setAttribute("aria-hidden", "true");
    el.append(h);
  }
}

function shellBeginResize(el, dir, e) {
  const rect = el.getBoundingClientRect();
  // freeze the window as a fixed box at its current spot (a card still in
  // the side stack detaches here, exactly like a dragged window)
  el.style.position = "fixed";
  el.style.left = rect.left + "px";
  el.style.top = rect.top + "px";
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.width = rect.width + "px";
  el.style.height = rect.height + "px";
  // CSS caps that keep a card compact in the dashboard (alerts card
  // max-height, navigator max-height, drawer max-width) must not fight an
  // explicit user resize; the viewport clamp below still bounds the result
  el.style.maxWidth = "none";
  el.style.maxHeight = "none";
  el.classList.add("panel-dragged");
  e.preventDefault();
  try { e.target.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  document.body.classList.add("panel-resizing");
  // the captured pointer keeps the resize cursor for the whole gesture
  document.body.style.cursor =
    dir === "e" ? "ew-resize" : dir === "s" ? "ns-resize" : "nwse-resize";

  const min = SHELL_RESIZE_MIN[el.id] || [260, 140];
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = rect.width;
  const startH = rect.height;
  const maxW = innerWidth - shellPanelMinLeft() - 8;
  const maxH = innerHeight - rect.top - 8;
  const move = (ev) => {
    let w = startW;
    let h = startH;
    if (dir.indexOf("e") >= 0) w = Math.min(Math.max(min[0], startW + ev.clientX - startX), maxW);
    if (dir.indexOf("s") >= 0) h = Math.min(Math.max(min[1], startH + ev.clientY - startY), maxH);
    el.style.width = w + "px";
    el.style.height = h + "px";
  };
  const up = () => {
    document.body.classList.remove("panel-resizing");
    document.body.style.cursor = "";
    e.target.removeEventListener("pointermove", move);
    e.target.removeEventListener("pointerup", up);
    e.target.removeEventListener("pointercancel", up);
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    shellClampPanel(el);
    shellSyncBannerClearance();
  };
  e.target.addEventListener("pointermove", move);
  e.target.addEventListener("pointerup", up);
  e.target.addEventListener("pointercancel", up);
}

function shellInitPanelResize() {
  for (const id of SHELL_PANEL_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    shellAddResizeHandles(el);
    for (const h of el.querySelectorAll(".shell-resize")) {
      h.addEventListener("pointerdown", (e) => {
        if (!window.matchMedia("(min-width: 761px)").matches) return;
        if (e.button !== 0 && e.pointerType === "mouse") return;
        if (shellPanelPageMode(el) || el.classList.contains("hidden")) return;
        shellBeginResize(el, h.dataset.resizeDir || "se", e);
      });
    }
  }
}

/* Repair Matching + Trend Analysis open/close state. The panels start open
   on the scene routes at desktop widths (matching the always-visible cards
   they replaced) and closed on phones, where the dock pills open them as
   near-full-width bottom sheets. */
const SHELL_SIDE = { closed: { repair: false, trend: false } };

function shellSidePanel(key) {
  return document.getElementById(key === "repair" ? "repair-card" : "trend-card");
}

function shellSideSync() {
  const stack = document.getElementById("left-stack");
  const anyOpen = shellElementVisible(shellSidePanel("repair"))
    || shellElementVisible(shellSidePanel("trend"));
  if (stack) stack.classList.toggle("sidepanels-open", anyOpen);
  for (const key of ["repair", "trend"]) {
    const card = shellSidePanel(key);
    const pill = document.getElementById("dock-" + key);
    const open = shellElementVisible(card);
    if (pill) {
      pill.setAttribute("aria-pressed", open ? "true" : "false");
      pill.classList.toggle("active", open);
    }
  }
  if (typeof shellSyncLaunchers === "function") shellSyncLaunchers();
}

function shellSideSetOpen(key, open) {
  const card = shellSidePanel(key);
  if (!card) return;
  if (open && shellIsMobileLayout()) {
    // one sheet at a time on phones
    const other = shellSidePanel(key === "repair" ? "trend" : "repair");
    if (other) other.classList.add("hidden");
    shellPrepareMobileSheet(key);
  }
  card.classList.toggle("hidden", !open);
  SHELL_SIDE.closed[key] = !open;
  shellSideSync();
}

function shellInitSidePanels() {
  const mobile = () => !window.matchMedia("(min-width: 761px)").matches;
  if (mobile()) {
    shellSidePanel("repair").classList.add("hidden");
    shellSidePanel("trend").classList.add("hidden");
  }
  const closeRepair = document.getElementById("repair-close");
  if (closeRepair) closeRepair.addEventListener("click", () => shellSideSetOpen("repair", false));
  const closeTrend = document.getElementById("trend-close");
  if (closeTrend) closeTrend.addEventListener("click", () => shellSideSetOpen("trend", false));
  const pillRepair = document.getElementById("dock-repair");
  if (pillRepair) pillRepair.addEventListener("click", () => {
    shellSideSetOpen("repair", shellSidePanel("repair").classList.contains("hidden"));
  });
  const pillTrend = document.getElementById("dock-trend");
  if (pillTrend) pillTrend.addEventListener("click", () => {
    shellSideSetOpen("trend", shellSidePanel("trend").classList.contains("hidden"));
  });
  let wasMobile = mobile();
  window.addEventListener("resize", () => {
    const nowMobile = mobile();
    if (nowMobile !== wasMobile) {
      wasMobile = nowMobile;
      // crossing into the phone layout closes both panels; crossing back
      // reopens only the ones the user had not closed themselves
      for (const key of ["repair", "trend"]) {
        shellSidePanel(key).classList.toggle("hidden", nowMobile ? true : SHELL_SIDE.closed[key]);
      }
    }
    shellSideSync();
  });
  shellSideSync();
  shellSyncLaunchers();
}

/* Hooks consumed by app.js. */
function shellAfterPoll() {
  if (!SHELL.initialized) initShell();
  shellSyncStatus();
  if (typeof analyticsAfterPoll === "function") analyticsAfterPoll();
  if (typeof settingsAfterPoll === "function") settingsAfterPoll();
  if (typeof fleetAfterPoll === "function") fleetAfterPoll();
}

/* ============================================================
   Phase 4 — Analytics page
   ------------------------------------------------------------
   A structured summary below the live scene for the three analytics
   destinations:

     production   live/today/yesterday solar production and grid export
     consumption  live/today/yesterday load, grid import, per-building table
     heatmap      per-building playback totals + day timeline buckets

   Every value comes from the existing /api/state snapshot (kpis +
   buildings) and /api/playback — calculated from the simulated sensor
   history, never metered. Unavailable or empty data stays "—"; nothing is
   invented. The page is refreshed from the same poll as the dashboard.
   ============================================================ */

const ANALYTICS = {
  tab: "production",
  built: false,
  playback: null,
  playbackDay: null,
  playbackError: false,
};

function anlEl() {
  return document.getElementById("analytics-page");
}

function anlKpi(label, id, unit) {
  return `<div class="anl-kpi">
    <span class="anl-kpi-label">${label}</span>
    <b class="anl-kpi-value" id="${id}">—</b>
    <span class="anl-kpi-unit">${unit}</span>
  </div>`;
}

function anlSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function anlBuild() {
  if (ANALYTICS.built || anlEl()) return;
  const host = document.getElementById("belowfold-host");
  if (!host) return;
  const sec = document.createElement("section");
  sec.id = "analytics-page";
  sec.className = "shell-panel anl-page";
  sec.innerHTML = `
    <div class="anl-head">
      <div>
        <span class="shell-compat-kicker">Energy Analytics</span>
        <h2 class="shell-compat-title">Today's energy picture</h2>
      </div>
      <div class="anl-tabs" role="group" aria-label="Analytics tab">
        <button type="button" class="shell-btn anl-tab" data-tab="production" aria-pressed="true">Production</button>
        <button type="button" class="shell-btn anl-tab" data-tab="consumption" aria-pressed="false">Consumption</button>
        <button type="button" class="shell-btn anl-tab" data-tab="heatmap" aria-pressed="false">Heatmap playback</button>
      </div>
    </div>
    <div class="anl-kpis" id="anl-kpis"></div>
    <div class="anl-detail" id="anl-detail"></div>
    <p class="anl-note" id="anl-note"></p>`;
  host.append(sec);
  sec.querySelectorAll(".anl-tab").forEach((b) => {
    b.addEventListener("click", () => {
      if (typeof shellNavigate === "function") {
        shellNavigate("/analytics/" + b.dataset.tab);
      }
    });
  });
  ANALYTICS.built = true;
}

function anlPausedLine(snap) {
  const sim = snap.sim || {};
  if (sim.paused) {
    return `Simulation paused at Day ${sim.day ?? "—"} · ${sim.time ?? "—"}. Today's totals cover the elapsed simulated hours; buckets after the current hour have no data.`;
  }
  return `Live simulation · Day ${sim.day ?? "—"} · ${sim.time ?? "—"}.`;
}

function anlNoteLine() {
  return "All values are calculated from the simulated sensor history with the documented formulas — not metered, no physical devices are connected.";
}

function anlBuildingTable(snap) {
  const rows = (snap.buildings || []).map((b) => `
    <tr>
      <th scope="row">${String(b.name || b.id).replace(/[<>&]/g, "")}</th>
      <td>${Number.isFinite(b.actual) ? b.actual.toFixed(2) + " kW" : "—"}</td>
      <td>${Number.isFinite(b.expected) ? b.expected.toFixed(2) + " kW" : "—"}</td>
      <td>${Number.isFinite(b.energy_today_kwh) ? b.energy_today_kwh.toFixed(1) + " kWh" : "—"}</td>
      <td>${Number.isFinite(b.anomalies) ? b.anomalies : "—"}</td>
    </tr>`).join("");
  return `<h3 class="section-heading">By building</h3>
    <table class="anl-table">
      <thead><tr>
        <th>Building</th><th>Actual now</th><th>Expected now</th>
        <th>Energy today</th><th>Anomalies</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No building data.</td></tr>'}</tbody>
    </table>`;
}

function anlPlaybackBlock() {
  const pb = ANALYTICS.playback;
  const body = document.getElementById("anl-detail");
  if (!body) return;
  if (ANALYTICS.playbackError) {
    body.innerHTML = `<p class="anl-empty">Playback data is currently unavailable. Retrying automatically.</p>`;
    return;
  }
  if (!pb) {
    body.innerHTML = `<p class="anl-empty">Loading playback data…</p>`;
    return;
  }
  const buildings = {};
  for (const s of pb.spaces || []) {
    if (s.kind !== "building" || !Number.isFinite(s.total_energy_kwh)) continue;
    buildings[s.id] = { name: s.name, kwh: s.total_energy_kwh };
  }
  const rows = Object.entries(buildings).map(([id, v]) => `
    <tr><th scope="row">${String(v.name || id).replace(/[<>&]/g, "")}</th>
    <td>${v.kwh.toFixed(1)} kWh</td></tr>`).join("");
  const tl = (pb.timeline || []).map((t) => `
    <span class="anl-bucket ${t.has_data ? "" : "empty"}">
      ${t.time}${t.has_data ? " · " + Number(t.max_energy_kwh).toFixed(0) + " kWh" : " · no data"}
    </span>`).join("");
  const covered = Math.round((pb.covered_minutes || 0) / 60);
  body.innerHTML = `
    <h3 class="section-heading">Day ${pb.day ?? "—"} playback — consumption by building</h3>
    <table class="anl-table">
      <thead><tr><th>Building</th><th>Calculated consumption</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="2">No playback data.</td></tr>'}</tbody>
    </table>
    <h3 class="section-heading">Day timeline</h3>
    <div class="anl-timeline">${tl || "—"}</div>
    <p class="anl-empty">Coverage: ${covered} of 24 simulated hours · ${pb.note || ""}</p>`;
}

function anlRenderKpis(snap) {
  const k = snap.kpis || {};
  const today = k.today || {};
  const yesterday = k.yesterday || {};
  const grid = document.getElementById("anl-kpis");
  const detail = document.getElementById("anl-detail");
  if (!grid || !detail) return;
  const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d != null ? d : 1) : "—");

  if (ANALYTICS.tab === "production") {
    grid.innerHTML =
      anlKpi("Solar production now", "anl-prod-now", "kW") +
      anlKpi("Solar production today", "anl-prod-today", "kWh") +
      anlKpi("Solar production yesterday", "anl-prod-yesterday", "kWh") +
      anlKpi("Grid export today", "anl-export-today", "kWh") +
      anlKpi("Solar self-sufficiency", "anl-suff", "% of load") +
      anlKpi("Battery flow now", "anl-storage-now", "kW") +
      anlKpi("Battery state of charge", "anl-soc", "%") +
      anlKpi("Charged today", "anl-charge-today", "kWh") +
      anlKpi("Discharged today", "anl-discharge-today", "kWh");
    anlSetText("anl-prod-now", num(k.solar_kw, 1));
    anlSetText("anl-prod-today", num(today.solar_kwh, 1));
    anlSetText("anl-prod-yesterday", num(yesterday.solar_kwh, 1));
    anlSetText("anl-export-today", num(today.export_kwh, 1));
    anlSetText("anl-suff", k.sufficiency != null ? Math.round(k.sufficiency * 100) : "—");
    anlSetText("anl-storage-now", num(k.storage_kw, 1));
    anlSetText("anl-soc", k.soc_pct != null ? Math.round(k.soc_pct) : "—");
    anlSetText("anl-charge-today", num(today.storage_charge_kwh, 1));
    anlSetText("anl-discharge-today", num(today.storage_discharge_kwh, 1));
    detail.innerHTML = anlBuildingTable(snap);
  } else if (ANALYTICS.tab === "consumption") {
    grid.innerHTML =
      anlKpi("Load now", "anl-load-now", "kW") +
      anlKpi("Consumption today", "anl-load-today", "kWh") +
      anlKpi("Consumption yesterday", "anl-load-yesterday", "kWh") +
      anlKpi("Grid import today", "anl-import-today", "kWh") +
      anlKpi("Active anomalies", "anl-anom", "");
    anlSetText("anl-load-now", num(k.load_kw, 1));
    anlSetText("anl-load-today", num(today.load_kwh, 1));
    anlSetText("anl-load-yesterday", num(yesterday.load_kwh, 1));
    anlSetText("anl-import-today", num(today.import_kwh, 1));
    anlSetText("anl-anom", k.anomalies != null ? String(k.anomalies) : "—");
    detail.innerHTML = anlBuildingTable(snap);
  } else {
    grid.innerHTML =
      anlKpi("Calculated today (buildings)", "anl-pb-total", "kWh") +
      anlKpi("Coverage", "anl-pb-covered", "hours") +
      anlKpi("Day", "anl-pb-day", "") +
      anlKpi("Bucket size", "anl-pb-bucket", "min") +
      anlKpi("Scene heatmap", "anl-pb-scene", "");
    const pb = ANALYTICS.playback;
    if (pb) {
      const total = (pb.spaces || []).reduce(
        (acc, s) => acc + (s.kind === "building" && Number.isFinite(s.total_energy_kwh) ? s.total_energy_kwh : 0), 0);
      anlSetText("anl-pb-total", num(total, 1));
      anlSetText("anl-pb-covered", num((pb.covered_minutes || 0) / 60, 0));
      anlSetText("anl-pb-day", String(pb.day ?? "—"));
      anlSetText("anl-pb-bucket", String(pb.bucket_minutes ?? "—"));
    }
    anlSetText("anl-pb-scene", "active");
    anlPlaybackBlock();
  }
  const note = document.getElementById("anl-note");
  if (note) note.textContent = `${anlPausedLine(snap)} ${anlNoteLine()}`;
}

async function anlFetchPlayback() {
  const snap = (typeof S !== "undefined") ? S.snap : null;
  if (!snap) return;
  const day = (snap.sim && snap.sim.day) || null;
  if (ANALYTICS.playback && ANALYTICS.playbackDay === day) return;
  ANALYTICS.playbackDay = day;
  try {
    ANALYTICS.playback = await netJSON("/api/playback?bucket=360&day=" + (day == null ? "" : day));
    ANALYTICS.playbackError = false;
  } catch (err) {
    ANALYTICS.playback = null;
    ANALYTICS.playbackError = true;
  }
  if (ANALYTICS.tab === "heatmap") anlRenderKpis(snap);
}

/* Route entry point (called by shellApplyRoute). */
function renderAnalyticsPage(tab) {
  anlBuild();
  if (tab) ANALYTICS.tab = tab;
  const sec = anlEl();
  if (!sec) return;
  sec.querySelectorAll(".anl-tab").forEach((b) => {
    const on = b.dataset.tab === ANALYTICS.tab;
    b.classList.toggle("route-active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const snap = (typeof S !== "undefined") ? S.snap : null;
  if (snap) {
    anlRenderKpis(snap);
    if (ANALYTICS.tab === "heatmap") anlFetchPlayback();
  }
}

/* Called from shellAfterPoll so the page follows the same poll cadence. */
function analyticsAfterPoll() {
  const sec = anlEl();
  if (!sec) return;
  const snap = (typeof S !== "undefined") ? S.snap : null;
  if (!snap) return;
  if (ANALYTICS.tab === "heatmap") anlFetchPlayback().then(() => {});
  anlRenderKpis(snap);
}

/* ============================================================
   Phase 4 — Settings page
   ------------------------------------------------------------
   Hosts the existing simulation and display controls as a page. Every
   control mirrors the existing element and re-dispatches its event, so
   the original handlers (postControl, theme rebuild, perfSetQuality,
   operator persistence) stay the single source of truth — no competing
   implementations.

   Safety: the page controls merely forward to the existing handlers.
   Pause/resume and reset are intentionally NOT triggered by this module;
   the user (or a test) must activate them.
   ============================================================ */

const SETTINGS = { built: false };

function setEl() {
  return document.getElementById("settings-page");
}

function setBuild() {
  if (SETTINGS.built || setEl()) return;
  const host = document.getElementById("belowfold-host");
  if (!host) return;
  const sec = document.createElement("section");
  sec.id = "settings-page";
  sec.className = "shell-panel set-page";
  sec.innerHTML = `
    <div class="set-head">
      <div>
        <span class="shell-compat-kicker">Settings</span>
        <h2 class="shell-compat-title">Simulation &amp; display</h2>
      </div>
      <span class="shell-badge warning" id="set-status">SIMULATED</span>
    </div>

    <h3 class="section-heading">Simulation <span class="set-group-note">affects the shared simulated state</span></h3>
    <div class="set-grid">
      <label class="set-field">Simulation speed
        <select id="set-speed" aria-label="Simulation speed">
          <option value="1">1× real time</option>
          <option value="10">10×</option>
          <option value="60">60×</option>
          <option value="300">300×</option>
        </select>
      </label>
      <label class="set-field">Weather
        <select id="set-weather" aria-label="Weather">
          <option value="auto">Auto</option>
          <option value="clear">Clear</option>
          <option value="partly">Partly cloudy</option>
          <option value="cloudy">Cloudy</option>
          <option value="overcast">Overcast</option>
        </select>
      </label>
      <div class="set-field set-actions">
        <button type="button" class="shell-btn" id="set-pause">—</button>
        <button type="button" class="shell-btn" id="set-reset" title="Reset clears all faults and alerts and restarts the simulation">Reset simulation</button>
      </div>
    </div>
    <p class="set-note" id="set-sim-note"></p>

    <h3 class="section-heading">Display</h3>
    <div class="set-grid">
      <label class="set-field">Visual effects
        <select id="set-effects" aria-label="Visual effects quality">
          <option value="full">Full (animated)</option>
          <option value="reduced">Reduced (static, saves power)</option>
        </select>
      </label>
      <div class="set-field set-actions">
        <button type="button" class="shell-btn" id="set-theme">Theme: —</button>
      </div>
    </div>
    <p class="set-note">The theme applies immediately and is not persisted across reloads. The
      effects quality is saved on this device and also auto-selected for
      reduced-motion / data-saver / low-power devices.</p>

    <h3 class="section-heading">Operator</h3>
    <div class="set-grid">
      <label class="set-field">Operator name
        <input id="set-operator" type="text" maxlength="40" placeholder="Operator"
               autocomplete="off" spellcheck="false"
               aria-label="Operator name used for acknowledge and resolve">
      </label>
    </div>
    <p class="set-note">Saved on this device and used as the operator for alarm
      acknowledgement and resolution.</p>`;
  host.append(sec);

  const mirrorSelect = (pageSel, originSel) => {
    const page = sec.querySelector(pageSel);
    const origin = document.getElementById(originSel);
    if (!page || !origin) return;
    page.addEventListener("change", () => {
      origin.value = page.value;
      origin.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  mirrorSelect("#set-speed", "speed");
  mirrorSelect("#set-weather", "weather");
  mirrorSelect("#set-effects", "effects");

  const forwardClick = (pageSel, originSel) => {
    const page = sec.querySelector(pageSel);
    const origin = document.getElementById(originSel);
    if (!page || !origin) return;
    page.addEventListener("click", () => {
      origin.click();
      if (originSel === "theme-btn") renderSettingsPage();  // label follows immediately
    });
  };
  forwardClick("#set-pause", "pause-btn");
  forwardClick("#set-reset", "reset-btn");
  forwardClick("#set-theme", "theme-btn");

  const op = sec.querySelector("#set-operator");
  const originOp = document.getElementById("alarm-operator");
  if (op && originOp) {
    op.value = originOp.value;
    op.addEventListener("input", () => { originOp.value = op.value; });
    op.addEventListener("blur", () => {
      originOp.value = op.value;
      originOp.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  SETTINGS.built = true;
}

/* Route entry point (called by shellApplyRoute). */
function renderSettingsPage() {
  setBuild();
  const sec = setEl();
  if (!sec) return;
  const snap = (typeof S !== "undefined") ? S.snap : null;
  const sim = (snap && snap.sim) || {};
  const speed = sec.querySelector("#set-speed");
  const weather = sec.querySelector("#set-weather");
  const effects = sec.querySelector("#set-effects");
  if (speed) speed.value = String(sim.speed || 60);
  if (weather) weather.value = String(sim.weather || "auto");
  if (effects && typeof PERF !== "undefined") effects.value = PERF.quality;
  const pause = sec.querySelector("#set-pause");
  if (pause) {
    pause.textContent = sim.paused ? "▶ Resume simulation" : "❚❚ Pause simulation";
    pause.title = sim.paused
      ? "Resume the simulation (it is currently paused)"
      : "Pause the simulation";
  }
  const themeBtn = sec.querySelector("#set-theme");
  if (themeBtn) {
    themeBtn.textContent = "Theme: " + ((document.documentElement.dataset.theme || "dark") === "dark" ? "dark" : "light");
  }
  const note = sec.querySelector("#set-sim-note");
  if (note) {
    note.textContent = sim.paused
      ? `The simulation is paused · Day ${sim.day ?? "—"} · ${sim.time ?? "—"}. Resume to continue the simulated day; reset clears all faults and alerts and restarts the simulation.`
      : `Simulation running · Day ${sim.day ?? "—"} · ${sim.time ?? "—"} · ${sim.speed ?? "—"}×. Reset clears all faults and alerts and restarts the simulation.`;
  }
}

/* Called from shellAfterPoll so the status line follows the poll cadence. */
function settingsAfterPoll() {
  if (!setEl()) return;
  renderSettingsPage();
}

/* ============================================================
   Phase 6 — Fleet page
   ------------------------------------------------------------
   Portfolio-level monitoring: one card per site (the simulated campus
   buildings plus the external sites fed by the imported dataset and the
   simulated in-process MQTT broker). All values come from the existing
   /api/equipment registry + latest measurements. External sites have no
   3D twin; their rows are display-only monitoring data. Nothing here is
   real hardware — every feed is simulated and labelled.
   ============================================================ */

const FLEET = { built: false, data: null, error: false, selected: null };

function fleetEl() {
  return document.getElementById("fleet-page");
}

function fleetSourceLabel(source) {
  if (source === "live") return "SIMULATED MQTT feed";
  if (source === "imported") return "Imported dataset";
  return "Simulated twin";
}

function fleetBuild() {
  if (FLEET.built || fleetEl()) return;
  const host = document.getElementById("belowfold-host");
  if (!host) return;
  const sec = document.createElement("section");
  sec.id = "fleet-page";
  sec.className = "shell-panel set-page";
  sec.innerHTML = `
    <div class="set-head">
      <div>
        <span class="shell-compat-kicker">Fleet monitoring</span>
        <h2 class="shell-compat-title">Sites and data sources</h2>
      </div>
    </div>
    <div class="fleet-sites" id="fleet-sites" role="list"></div>
    <div class="fleet-detail" id="fleet-detail"></div>
    <p class="set-note" id="fleet-note"></p>`;
  host.append(sec);
  sec.querySelector("#fleet-sites").addEventListener("click", (e) => {
    const card = e.target.closest("[data-fleet-site]");
    if (!card) return;
    FLEET.selected = FLEET.selected === card.dataset.fleetSite ? null : card.dataset.fleetSite;
    fleetRenderList();
  });
  FLEET.built = true;
}

function fleetSites() {
  const sites = new Map();
  for (const item of (FLEET.data && FLEET.data.equipment) || []) {
    const bid = (item.parent && item.parent.building) || "campus";
    if (!sites.has(bid)) {
      sites.set(bid, { id: bid, name: bid, source: null, count: 0, kw: 0, age: null, noData: 0 });
    }
    const s = sites.get(bid);
    s.count += 1;
    const latest = item.latest || {};
    if (Number.isFinite(latest.actual_kw)) s.kw += latest.actual_kw;
    if (!s.source) s.source = item.source || "simulated";
    // Only wall-clock feeds have a meaningful sample age; the simulated
    // campus uses sim-minutes and is reported as paused instead.
    if (item.source !== "simulated" && latest.measured_at != null) {
      const age = Date.now() / 1000 - Number(latest.measured_at);
      if (age >= 0 && (s.age === null || age < s.age)) s.age = age;
    }
  }
  const snap = (typeof S !== "undefined") ? S.snap : null;
  for (const b of (snap && snap.buildings) || []) {
    if (sites.has(b.id)) sites.get(b.id).name = b.name;
  }
  const names = { "ext-a": "Warehouse 12", "ext-b": "Office 3" };
  for (const [id, s] of sites) if (names[id]) s.name = names[id];
  return [...sites.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function fleetFreshness(site) {
  if (site.source === "simulated") return "Simulation paused · sim-time samples";
  if (site.age == null) return "No samples yet";
  return `Last sample ${Math.round(site.age)} s ago`;
}

function fleetRender() {
  if (!fleetEl()) return;
  const box = document.getElementById("fleet-sites");
  if (!box) return;
  if (FLEET.error) {
    box.innerHTML = `<p class="anl-empty">Fleet data is currently unavailable. Retrying automatically.</p>`;
    return;
  }
  if (!FLEET.data) {
    box.innerHTML = `<p class="anl-empty">Loading fleet data…</p>`;
    return;
  }
  const sites = fleetSites();
  box.textContent = "";
  for (const s of sites) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "fleet-card" + (FLEET.selected === s.id ? " selected" : "");
    card.dataset.fleetSite = s.id;
    card.setAttribute("role", "listitem");
    card.innerHTML = `
      <span class="fleet-card-name">${s.name.replace(/[<>&]/g, "")}</span>
      <span class="shell-badge info">${fleetSourceLabel(s.source).replace(/[<>&]/g, "")}</span>
      <span class="fleet-card-stats">${s.count} equipment · ${s.kw.toFixed(1)} kW</span>
      <span class="fleet-card-age">${fleetFreshness(s).replace(/[<>&]/g, "")}</span>`;
    box.append(card);
  }
  const note = document.getElementById("fleet-note");
  if (note) {
    note.textContent = "All fleet feeds are simulated: the imported dataset and the in-process "
      + "MQTT mock publish deterministic values — no real devices, brokers or networks are involved. "
      + "External sites have no 3D twin; their rows are monitoring data only.";
  }
  fleetRenderList();
}

function fleetRenderList() {
  const detail = document.getElementById("fleet-detail");
  if (!detail || !FLEET.data) return;
  if (!FLEET.selected) {
    detail.innerHTML = `<p class="anl-empty">Select a site to list its equipment.</p>`;
    return;
  }
  const items = FLEET.data.equipment.filter(
    (i) => (i.parent && i.parent.building) === FLEET.selected);
  const rows = items.map((i) => {
    const latest = i.latest || {};
    const kw = Number.isFinite(latest.actual_kw) ? latest.actual_kw.toFixed(2) + " kW" : "—";
    const age = i.source !== "simulated" && latest.measured_at != null
      ? `${Math.max(0, Math.round(Date.now() / 1000 - Number(latest.measured_at)))} s ago` : "paused";
    return `<tr>
      <th scope="row">${String(i.name).replace(/[<>&]/g, "")}</th>
      <td>${String(i.category_label || i.category).replace(/[<>&]/g, "")}</td>
      <td>${fleetSourceLabel(i.source).replace(/[<>&]/g, "")}</td>
      <td>${kw}</td>
      <td>${age}</td>
    </tr>`;
  }).join("");
  const site = fleetSites().find((s) => s.id === FLEET.selected);
  const siteName = (site && site.name) || FLEET.selected;
  detail.innerHTML = `
    <h3 class="section-heading">${siteName.replace(/[<>&]/g, "")} — equipment</h3>
    <div class="anl-detail">
      <table class="anl-table">
        <thead><tr><th>Name</th><th>Type</th><th>Source</th><th>Latest reading</th><th>Freshness</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">No equipment for this site.</td></tr>'}</tbody>
      </table>
    </div>`;
}

/* Route entry point (called by shellApplyRoute). */
function renderFleetPage() {
  fleetBuild();
  FLEET.selected = null;
  fleetFetch();
}

async function fleetFetch() {
  try {
    FLEET.data = await netJSON("/api/equipment");
    FLEET.error = false;
  } catch (err) {
    FLEET.error = true;
  }
  fleetRender();
}

/* Called from shellAfterPoll so the page follows the poll cadence. */
function fleetAfterPoll() {
  if (!fleetEl() || !(typeof SHELL !== "undefined" && SHELL.page === "fleet")) return;
  fleetFetch();
}
