/* ============================================================
   Step 10 — network resilience
   ------------------------------------------------------------
   Every dashboard request goes through netFetch / netJSON:

     - a hard timeout so a dead server cannot leave the UI waiting
     - abort-all on page hide (no orphaned requests)
     - a shared NET state so the UI can show "last data" and retry
       instead of silently freezing on the previous snapshot

   Failures keep the last good snapshot on screen.  The UI is told via
   a `net-state` event; it never has to guess from an empty DOM.
   ============================================================ */

"use strict";

const NET = {
  online: true,
  lastOk: 0,
  lastError: null,
  consecutiveFailures: 0,
  requests: 0,
  timeouts: 0,
  aborted: 0,
  inflight: new Set(),
  lastState: "init",
};

function netEmit(state) {
  NET.lastState = state;
  try {
    window.dispatchEvent(new CustomEvent("net-state", {
      detail: {
        state,
        online: NET.online,
        failures: NET.consecutiveFailures,
        error: NET.lastError,
        lastOk: NET.lastOk,
      },
    }));
  } catch (_) { /* CustomEvent unavailable in very old engines */ }
}

function netAbortAll(reason) {
  for (const ctl of NET.inflight) {
    try { ctl.abort(reason || "pagehide"); } catch (_) { /* already aborted */ }
  }
  NET.inflight.clear();
}

async function netFetch(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout == null ? 8000 : opts.timeout;
  const { timeout: _ignored, ...init } = opts;
  const ctl = new AbortController();
  NET.inflight.add(ctl);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { ctl.abort("timeout"); } catch (_) { /* ignore */ }
  }, timeout);

  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    NET.requests += 1;
    NET.online = true;
    NET.lastOk = Date.now();
    NET.lastError = null;
    NET.consecutiveFailures = 0;
    netEmit("ok");
    return res;
  } catch (err) {
    // A deliberate abort (page hide, superseded request) is not an outage.
    const aborted = err && err.name === "AbortError" && !timedOut;
    if (aborted) {
      NET.aborted += 1;
      throw err;
    }
    if (timedOut) NET.timeouts += 1;
    NET.consecutiveFailures += 1;
    NET.online = false;
    NET.lastError = timedOut ? "Request timed out" : (err && err.message ? err.message : String(err));
    netEmit("error");
    throw err;
  } finally {
    clearTimeout(timer);
    NET.inflight.delete(ctl);
  }
}

async function netJSON(url, opts) {
  const res = await netFetch(url, opts);
  try {
    return await res.json();
  } catch (err) {
    NET.online = false;
    NET.lastError = "Invalid JSON response";
    netEmit("error");
    throw err;
  }
}

window.addEventListener("pagehide", () => netAbortAll("pagehide"));
