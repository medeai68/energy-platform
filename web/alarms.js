/* ============================================================
   Alarm center — simulated alarm & event management
   ------------------------------------------------------------
   The anomaly detector already persists every alarm (open/recovered).
   This panel adds the operator workflow on top of it:

     open        an anomaly is active, nobody has taken it yet
     acknowledged  an operator owns it; the condition is still active
     recovered   the detector says the condition cleared (automatic)
     resolved    an operator closed the record after recovery, with note

   Resolve is refused by the server while a condition is still active,
   so the UI can never hide a live abnormal device behind a done record.

   Every row is clearly marked SIMULATED: alarms come from virtual
   sensors, not physical hardware.
   ============================================================ */

"use strict";

const AL = {
  open: false,
  items: [],
  counts: { open: 0, acknowledged: 0, recovered: 0, resolved: 0, active: 0, total: 0 },
  filters: { status: "active", severity: "", building: "" },
  busy: false,
  editingKey: null,
  timer: 0,
  reqId: 0,
  els: null,
  returnFocus: null,
};

const AL_STATE_LABELS = {
  open: "Open",
  acknowledged: "Acknowledged",
  recovered: "Recovered",
  resolved: "Resolved",
};

const AL_SEVERITY_LABELS = {
  warning: "Warning",
  serious: "Serious",
  critical: "Critical",
};

const AL_OPERATOR_KEY = "efi.operator";

function alEls() {
  if (AL.els) return AL.els;
  AL.els = {
    panel: $("#alarm-center"),
    close: $("#alarm-close"),
    list: $("#alarm-list"),
    empty: $("#alarm-empty"),
    emptyText: $("#alarm-empty-text"),
    status: $("#alarm-status"),
    filters: $("#alarm-filters"),
    severity: $("#alarm-severity"),
    building: $("#alarm-building"),
    operator: $("#alarm-operator"),
    note: $("#alarm-note"),
    manage: $("#alert-manage"),
    badge: $("#alert-manage-badge"),
  };
  return AL.els;
}

function alKey(item) {
  return item.equipment_id + "|" + item.event_key;
}

function alOperator() {
  const els = alEls();
  const value = els.operator ? els.operator.value.trim() : "";
  return (value || "Operator").slice(0, 40);
}

function alRememberOperator() {
  const els = alEls();
  if (!els.operator) return;
  try {
    localStorage.setItem(AL_OPERATOR_KEY, els.operator.value.trim().slice(0, 40));
  } catch (_) { /* storage may be unavailable */ }
}

/* Absolute simulation minutes -> "Day 3 · 14:20". */
function alSimLabel(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return "—";
  const day = Math.floor(m / 1440) + 1;
  const rem = m % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, "0");
  const mm = String(Math.floor(rem % 60)).padStart(2, "0");
  return `Day ${day} · ${hh}:${mm}`;
}

/* SQLite datetime('now') is UTC: "YYYY-MM-DD HH:MM:SS". */
function alWallLabel(text) {
  if (!text) return "";
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(text));
  return m ? `${m[1]} ${m[2]} UTC` : String(text);
}

function alLocation(item) {
  const buildings = (S.snap && Array.isArray(S.snap.buildings)) ? S.snap.buildings : [];
  const b = buildings.find((x) => x.id === item.building_id);
  if (!b) return item.building_id || "Campus";
  const parts = [b.name || b.id];
  const f = (b.floors || []).find((x) => x.id === item.floor_id);
  if (f) parts.push(f.name || f.id);
  const r = f && (f.rooms || []).find((x) => x.id === item.room_id);
  if (r) parts.push(r.name || r.id);
  else if (item.room_id && !f) parts.push(item.room_id);
  return parts.join(" · ");
}

function alSetStatus(message, tone) {
  const els = alEls();
  if (!els.status) return;
  els.status.textContent = message || "";
  els.status.dataset.tone = tone || "";
}

function alUpdateBadge() {
  const els = alEls();
  if (!els.badge) return;
  const live = S.snap && S.snap.kpis ? Number(S.snap.kpis.anomalies) || 0 : 0;
  const count = AL.open ? AL.counts.active : live;
  els.badge.textContent = count > 99 ? "99+" : String(count);
  els.badge.hidden = count === 0;
  if (els.manage) {
    els.manage.setAttribute(
      "aria-label",
      count ? `Open the alarm center (${count} active alarm${count === 1 ? "" : "s"})`
            : "Open the alarm center");
  }
}

/* Kept for app.js: the floating alerts card tells the panel how many
   anomalies the live snapshot currently reports. */
function updateAlarmBadge() {
  alUpdateBadge();
}

/* ---------------- data ---------------- */

function alQueryString() {
  const p = new URLSearchParams();
  p.set("status", AL.filters.status);
  if (AL.filters.severity) p.set("severity", AL.filters.severity);
  if (AL.filters.building) p.set("building", AL.filters.building);
  p.set("limit", "100");
  return p.toString();
}

async function fetchAlarms(opts) {
  opts = opts || {};
  const els = alEls();
  const reqId = ++AL.reqId;
  if (!opts.silent) alSetStatus("Loading alarms…");
  try {
    const data = await netJSON("/api/alarms?" + alQueryString());
    if (reqId !== AL.reqId) return;  // a newer request won
    if (!data || !Array.isArray(data.items)) throw new Error("bad alarm payload");
    const before = AL.counts;
    AL.items = data.items;
    AL.counts = data.counts || AL.counts;
    // A silent background refresh must not wipe a success message, but a
    // recovered connection should clear a stale error.  A condition that
    // clears while the panel is open drops out of the Active view; say so,
    // otherwise the last message ("still active") is left standing.
    if (reqId === AL.reqId) {
      if (!opts.silent || (els.status && els.status.dataset.tone === "error")) {
        alSetStatus("");
      } else {
        const cleared = Number(AL.counts.recovered) - Number(before && before.recovered || 0);
        if (cleared > 0) {
          alSetStatus(cleared === 1
            ? "1 alarm condition cleared and is waiting for close-out in the Recovered view."
            : `${cleared} alarm conditions cleared and are waiting for close-out in the Recovered view.`,
          "ok");
        }
      }
    }
    renderAlarmList();
    renderAlarmCounts();
    alUpdateBadge();
  } catch (err) {
    if (reqId !== AL.reqId) return;
    const why = err && err.message ? err.message : "request failed";
    alSetStatus(`Could not load alarms (${why}). Retrying automatically.`, "error");
  }
}

/* Counts on the status chips come from the server (full table), not from
   the filtered page of rows the panel happens to show. */
function renderAlarmCounts() {
  const els = alEls();
  if (!els.filters) return;
  els.filters.querySelectorAll("[data-status]").forEach((btn) => {
    const key = btn.dataset.status;
    const value = key === "all" ? AL.counts.total : AL.counts[key];
    const b = btn.querySelector("b");
    if (b) b.textContent = Number(value) || 0;
    btn.classList.toggle("selected", AL.filters.status === key);
    btn.setAttribute("aria-pressed", AL.filters.status === key ? "true" : "false");
  });
}

function alEmptyMessage() {
  const f = AL.filters;
  if (f.severity || f.building) return "No alarm records match the selected filters.";
  switch (f.status) {
    case "active": return "No active alarms. All simulated equipment is within its expected band.";
    case "open": return "No unacknowledged alarms. Every active alarm has an owner.";
    case "acknowledged": return "No acknowledged alarms are still active.";
    case "recovered": return "No recovered alarms waiting to be resolved.";
    case "resolved": return "No resolved alarm records yet.";
    default: return "No alarm records.";
  }
}

/* ---------------- rendering ---------------- */

function alarmRowElement(item) {
  const li = document.createElement("li");
  li.className = `alarm-row sev-${item.severity} state-${item.state}`;
  li.dataset.key = alKey(item);

  const top = document.createElement("div");
  top.className = "alarm-row-top";

  const sev = document.createElement("span");
  sev.className = "alarm-sev";
  sev.textContent = AL_SEVERITY_LABELS[item.severity] || item.severity;
  const source = document.createElement("span");
  source.className = "alarm-source";
  source.textContent = "SIMULATED";
  source.title = "Derived from virtual sensor anomalies — no physical devices are connected";
  const when = document.createElement("span");
  when.className = "alarm-when";
  when.textContent = alSimLabel(item.opened_at);
  const state = document.createElement("span");
  state.className = "alarm-state";
  state.textContent = AL_STATE_LABELS[item.state] || item.state;
  top.append(sev, state, when, source);

  const msg = document.createElement("p");
  msg.className = "alarm-msg";
  msg.textContent = item.message || "Anomaly detected";

  const meta = document.createElement("div");
  meta.className = "alarm-meta";
  const device = document.createElement("button");
  device.type = "button";
  device.className = "alarm-device";
  device.textContent = `${item.device_name} →`;
  device.title = "Open this equipment's details";
  device.dataset.action = "open-device";
  const where = document.createElement("span");
  where.className = "alarm-where";
  where.textContent = alLocation(item);
  meta.append(device, where);

  if (item.acknowledged_at) {
    const ack = document.createElement("div");
    ack.className = "alarm-history";
    ack.textContent = `Acknowledged by ${item.acknowledged_by || "operator"} · ${alWallLabel(item.acknowledged_at)}`;
    meta.append(ack);
  }
  if (item.resolved_at) {
    const res = document.createElement("div");
    res.className = "alarm-history";
    res.textContent = `Resolved by ${item.resolved_by || "operator"} · ${alWallLabel(item.resolved_at)}` +
      (item.resolution_note ? ` · “${item.resolution_note}”` : "");
    meta.append(res);
  }
  if (!item.active && !item.resolved_at && item.closed_at != null) {
    const rec = document.createElement("div");
    rec.className = "alarm-history";
    rec.textContent = `Condition cleared ${alSimLabel(item.closed_at)} · awaiting operator close-out`;
    meta.append(rec);
  }

  const actions = document.createElement("div");
  actions.className = "alarm-actions";
  if (item.state === "open" || item.state === "acknowledged") {
    const ackBtn = document.createElement("button");
    ackBtn.type = "button";
    ackBtn.className = "alarm-action alarm-ack";
    ackBtn.textContent = item.state === "open" ? "Acknowledge" : "Acknowledged";
    ackBtn.dataset.action = "ack";
    ackBtn.disabled = item.state !== "open" || AL.busy;
    actions.append(ackBtn);
  }
  if (item.state === "recovered") {
    const resBtn = document.createElement("button");
    resBtn.type = "button";
    resBtn.className = "alarm-action alarm-resolve";
    resBtn.textContent = "Resolve…";
    resBtn.dataset.action = "resolve";
    resBtn.disabled = AL.busy;
    actions.append(resBtn);
  }
  if (actions.childElementCount) li.append(top, msg, meta, actions);
  else li.append(top, msg, meta);

  if (AL.editingKey === alKey(item)) {
    const form = document.createElement("div");
    form.className = "alarm-resolve-form";
    const label = document.createElement("label");
    label.textContent = "Resolution note (optional)";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 500;
    input.placeholder = "What was done? e.g. connector reseated";
    input.className = "alarm-note-input";
    label.append(input);
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "alarm-action alarm-confirm";
    confirm.textContent = "Confirm resolve";
    confirm.dataset.action = "confirm-resolve";
    confirm.disabled = AL.busy;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "alarm-action alarm-cancel";
    cancel.textContent = "Cancel";
    cancel.dataset.action = "cancel-resolve";
    form.append(label, confirm, cancel);
    li.append(form);
    requestAnimationFrame(() => input.focus());
  }
  return li;
}

function renderAlarmList() {
  const els = alEls();
  if (!els.list) return;
  const scrollTop = els.list.scrollTop;
  els.list.textContent = "";
  const frag = document.createDocumentFragment();
  for (const item of AL.items) frag.append(alarmRowElement(item));
  els.list.append(frag);
  els.list.scrollTop = scrollTop;
  const empty = AL.items.length === 0;
  if (els.empty) {
    els.empty.classList.toggle("hidden", !empty);
    if (els.emptyText) els.emptyText.textContent = alEmptyMessage();
  }
  renderAlarmCounts();
}

function syncAlarmFilterControls() {
  const els = alEls();
  if (els.severity) els.severity.value = AL.filters.severity;
  if (els.building) els.building.value = AL.filters.building;
  const bSel = els.building;
  if (bSel && bSel.options.length <= 1 && S.snap && Array.isArray(S.snap.buildings)) {
    for (const b of S.snap.buildings) {
      const o = document.createElement("option");
      o.value = b.id;
      o.textContent = b.name || b.id;
      bSel.append(o);
    }
    bSel.value = AL.filters.building;
  }
}

/* ---------------- actions ---------------- */

async function postAlarmAction(action, item, extra) {
  const payload = {
    equipment_id: item.equipment_id,
    event_key: item.event_key,
    operator: alOperator(),
    ...(extra || {}),
  };
  return netJSON(`/api/alarms/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeout: 10000,
  });
}

async function acknowledgeAlarm(item) {
  if (AL.busy) return;
  AL.busy = true;
  alSetStatus(`Acknowledging ${item.device_name}…`);
  renderAlarmList();
  try {
    const data = await postAlarmAction("acknowledge", item);
    if (data && data.alarm) alReplaceItem(data.alarm);
    if (data && data.counts) AL.counts = data.counts;
    alSetStatus(`Acknowledged ${item.device_name}. The condition is still active and remains visible.`, "ok");
    AL.editingKey = null;
    await fetchAlarms({ silent: true });
  } catch (err) {
    alSetStatus(`Could not acknowledge: ${err && err.message ? err.message : "request failed"}`, "error");
  } finally {
    AL.busy = false;
    if (!AL.editingKey) renderAlarmList();
  }
}

async function resolveAlarm(item, note) {
  if (AL.busy) return;
  AL.busy = true;
  alSetStatus(`Resolving ${item.device_name}…`);
  renderAlarmList();
  try {
    const data = await postAlarmAction("resolve", item, { note: note || "" });
    if (data && data.alarm) alReplaceItem(data.alarm);
    if (data && data.counts) AL.counts = data.counts;
    AL.editingKey = null;
    alSetStatus(`Resolved ${item.device_name}.`, "ok");
    await fetchAlarms({ silent: true });
  } catch (err) {
    alSetStatus(`Could not resolve: ${err && err.message ? err.message : "request failed"}`, "error");
  } finally {
    AL.busy = false;
    renderAlarmList();
  }
}

function alReplaceItem(updated) {
  const key = alKey(updated);
  const i = AL.items.findIndex((x) => alKey(x) === key);
  if (i >= 0) AL.items[i] = updated;
  else AL.items.unshift(updated);
}

function alFindItem(key) {
  return AL.items.find((x) => alKey(x) === key) || null;
}

/* ---------------- open / close ---------------- */

function openAlarms(force) {
  const els = alEls();
  if (!els.panel) return;
  const open = force != null ? force : !AL.open;
  if (open === AL.open) {
    if (open) fetchAlarms();
    if (typeof shellSyncLaunchers === "function") shellSyncLaunchers();
    return;
  }
  AL.open = open;
  els.panel.classList.toggle("hidden", !open);
  const rail = $("#rail-alerts");
  if (rail) rail.classList.toggle("active", open);
  if (!open) {
    if (AL.timer) { clearInterval(AL.timer); AL.timer = 0; }
    AL.editingKey = null;
    AL.reqId += 1;  // ignore any in-flight response
    alUpdateBadge();
    const back = AL.returnFocus;
    AL.returnFocus = null;
    if (back && typeof back.focus === "function" && document.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch (_) { /* detached */ }
    }
    if (typeof shellSyncLaunchers === "function") shellSyncLaunchers();
    return;
  }
  // Phones show one bottom sheet at a time; the alarm center tucks the other
  // sheet windows away without touching the device drawer.
  if (typeof shellPrepareMobileSheet === "function") shellPrepareMobileSheet("alarm");
  if (typeof toggleSimPop === "function") toggleSimPop(false);
  // Assets uses the navigator as the page's equipment table. Keep it in
  // place behind the floating center so closing the center reveals the table
  // again instead of leaving a blank scene on the same route.
  if (typeof isNavigatorOpen === "function" && isNavigatorOpen()
      && !(typeof SHELL !== "undefined" && SHELL.page === "assets")) {
    openNavigator(false);
  }
  AL.returnFocus = document.activeElement;
  syncAlarmFilterControls();
  alUpdateBadge();
  alSetStatus("Loading alarms…");
  fetchAlarms();
  AL.timer = setInterval(() => {
    if (!AL.open || document.hidden) return;
    if (AL.editingKey || AL.busy) return;  // never replace a form mid-edit
    fetchAlarms({ silent: true });
  }, 5000);
  if (typeof shellSyncLaunchers === "function") shellSyncLaunchers();
}

function closeAlarms() {
  openAlarms(false);
}

function toggleAlarms(force) {
  openAlarms(force);
}

function isAlarmsOpen() {
  return AL.open;
}

/* Selecting an alarm's device opens the normal equipment drawer.
   The alarm center always stays open behind it: closing the overlay on a
   device jump made the "detail window" vanish on a second click and left
   the operator without the alarm list. The drawer (z-index above the
   center) carries its own explicit ✕ close button. */
function alOpenDevice(item) {
  if (!item || typeof openDrawer !== "function") return;
  openDrawer(item.equipment_id);
}

/* ---------------- wiring ---------------- */

function initAlarms() {
  const els = alEls();
  if (!els.panel) return;

  try {
    const saved = localStorage.getItem(AL_OPERATOR_KEY);
    if (saved && els.operator) els.operator.value = saved.slice(0, 40);
  } catch (_) { /* storage may be unavailable */ }

  if (els.close) els.close.addEventListener("click", () => closeAlarms());
  if (els.manage) {
    els.manage.addEventListener("click", () => {
      const card = $("#alerts-card");
      if (card && card.classList.contains("collapsed")) card.classList.remove("collapsed");
      openAlarms(true);
    });
  }
  if (els.operator) {
    els.operator.addEventListener("change", alRememberOperator);
    els.operator.addEventListener("blur", alRememberOperator);
  }

  if (els.filters) {
    els.filters.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-status]");
      if (!btn) return;
      AL.filters.status = btn.dataset.status;
      AL.editingKey = null;
      fetchAlarms();
    });
  }
  if (els.severity) {
    els.severity.addEventListener("change", () => {
      AL.filters.severity = els.severity.value;
      AL.editingKey = null;
      fetchAlarms();
    });
  }
  if (els.building) {
    els.building.addEventListener("change", () => {
      AL.filters.building = els.building.value;
      AL.editingKey = null;
      fetchAlarms();
    });
  }

  if (els.list) {
    els.list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const row = btn.closest(".alarm-row");
      const item = row ? alFindItem(row.dataset.key) : null;
      if (!item) return;
      const action = btn.dataset.action;
      if (action === "ack") acknowledgeAlarm(item);
      else if (action === "resolve") {
        AL.editingKey = alKey(item);
        renderAlarmList();
      } else if (action === "cancel-resolve") {
        AL.editingKey = null;
        renderAlarmList();
      } else if (action === "confirm-resolve") {
        const input = row.querySelector(".alarm-note-input");
        resolveAlarm(item, input ? input.value : "");
      } else if (action === "open-device") {
        alOpenDevice(item);
      }
    });
    els.list.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.classList.contains("alarm-note-input")) return;
      const row = e.target.closest(".alarm-row");
      const item = row ? alFindItem(row.dataset.key) : null;
      if (!item) return;
      e.preventDefault();
      resolveAlarm(item, e.target.value);
    });
  }

  alUpdateBadge();
}

initAlarms();
