/* ============================================================
   Historical energy playback (Step 9)
   ------------------------------------------------------------
   Fetches /api/playback (one simulation day, fixed buckets) and lets
   the user scrub/play through it.  Every value is calculated from
   simulated device history by the server - never a meter reading.

   Live mode (PLAYBACK.active === false) leaves the heatmap showing
   accumulated energy for today, matching the Energy mode.  Pressing
   play, moving the slider or opening a bucket switches to history.

   This module is intentionally independent of the scene renderer: it
   only owns state, fetching and the small control strip.  viz.js reads
   the state through playbackActive() / playbackSpaceValue().
   ============================================================ */

"use strict";

const PLAYBACK = {
  active: false,      // history mode vs live "today" mode
  playing: false,
  index: 0,
  bucket: 60,
  data: null,
  byId: null,
  rev: 0,             // increments when data or the visible bucket changes
  loading: false,
  error: null,
  fetchedAt: 0,
  promise: null,
  timer: null,
};

/* ---------- state helpers (used by viz.js and the harness) ---------- */

function playbackActive() {
  return !!(PLAYBACK.active && PLAYBACK.data);
}

function playbackBucketCount() {
  return PLAYBACK.data && PLAYBACK.data.bucket_count > 0
    ? PLAYBACK.data.bucket_count : 0;
}

function playbackRevision() {
  if (!PLAYBACK.data) return "none";
  return `${PLAYBACK.data.day}:${PLAYBACK.active ? PLAYBACK.index : "live"}:${PLAYBACK.rev}`;
}

function playbackSpaceValue(spaceOrId) {
  if (!playbackActive()) return null;
  const id = typeof spaceOrId === "string" ? spaceOrId : spaceOrId && spaceOrId.id;
  if (!id) return null;
  if (!PLAYBACK.byId) {
    PLAYBACK.byId = new Map();
    for (const space of PLAYBACK.data.spaces || []) PLAYBACK.byId.set(space.id, space);
  }
  const record = PLAYBACK.byId.get(id);
  return record ? (record.series || [])[PLAYBACK.index] || null : null;
}

/* Global day-max intensity, so colours stay comparable while scrubbing. */
function playbackMaxIntensity() {
  return PLAYBACK.data ? PLAYBACK.data.max_intensity_kwh_m2 || 0 : 0;
}

function playbackClock(totalMinutes) {
  const m = Math.round(totalMinutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function playbackBucketLabel() {
  if (!PLAYBACK.data) return "—";
  const bucket = PLAYBACK.data.bucket_minutes || PLAYBACK.bucket;
  const index = Math.max(0, Math.min(playbackBucketCount() - 1, PLAYBACK.index));
  const start = index * bucket;
  const end = Math.min(1440, start + bucket);
  return `${playbackClock(start)}–${playbackClock(end)}`;
}

/* Time shown for the current state: bucket range in history, clock in live. */
function playbackTimeLabel() {
  if (playbackActive()) return `D${PLAYBACK.data.day} ${playbackBucketLabel()}`;
  if (typeof S !== "undefined" && S.snap && S.snap.sim) {
    return `Live · D${S.snap.sim.day} ${S.snap.sim.time}`;
  }
  return "Live";
}

function playbackStatusText() {
  if (PLAYBACK.error) return `Playback unavailable — ${PLAYBACK.error}`;
  if (PLAYBACK.loading) return "Loading simulated history…";
  if (!PLAYBACK.data) return "Simulated history · calculated, not metered";
  if (PLAYBACK.active) return "History · calculated, not metered";
  return "Live today · simulated counters";
}

/* ---------- live clock → bucket ---------- */

function playbackLiveIndex() {
  const count = playbackBucketCount();
  if (!count || typeof S === "undefined" || !S.snap || !S.snap.sim) return 0;
  const parts = String(S.snap.sim.time || "00:00").split(":");
  const minutes = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  return Math.max(0, Math.min(count - 1, Math.floor(minutes / (PLAYBACK.data.bucket_minutes || 60))));
}

/* ---------- fetching ---------- */

function playbackEnsureData(force) {
  if (PLAYBACK.loading && PLAYBACK.promise) return PLAYBACK.promise;
  if (!force && PLAYBACK.data && Date.now() - PLAYBACK.fetchedAt < 5000) {
    return Promise.resolve(PLAYBACK.data);
  }
  PLAYBACK.loading = true;
  PLAYBACK.error = null;
  playbackUpdateUI();
  const promise = netFetch(`/api/playback?bucket=${encodeURIComponent(PLAYBACK.bucket)}`, { timeout: 8000 })
    .then((r) => r.json())
    .then((data) => {
      const previousDay = PLAYBACK.data ? PLAYBACK.data.day : data.day;
      PLAYBACK.data = data;
      PLAYBACK.byId = null;
      PLAYBACK.fetchedAt = Date.now();
      PLAYBACK.rev += 1;
      if (!PLAYBACK.active || previousDay !== data.day) {
        PLAYBACK.index = PLAYBACK.active ? 0 : playbackLiveIndex();
      }
      const count = playbackBucketCount();
      PLAYBACK.index = Math.max(0, Math.min(count - 1, PLAYBACK.index));
      return data;
    })
    .catch((err) => {
      PLAYBACK.error = err && err.message ? err.message : String(err);
      return null;
    })
    .finally(() => {
      PLAYBACK.loading = false;
      PLAYBACK.promise = null;
      playbackUpdateUI();
    });
  PLAYBACK.promise = promise;
  return promise;
}

/* ---------- controls ---------- */

function playbackSetIndex(value) {
  const count = playbackBucketCount();
  if (!count) return;
  const index = Math.max(0, Math.min(count - 1, Math.round(Number(value) || 0)));
  PLAYBACK.active = true;
  PLAYBACK.index = index;
  PLAYBACK.playing = false;
  PLAYBACK.rev += 1;
  playbackUpdateUI();
}

function playbackGoLive() {
  PLAYBACK.active = false;
  PLAYBACK.playing = false;
  PLAYBACK.index = playbackLiveIndex();
  PLAYBACK.rev += 1;
  playbackUpdateUI();
}

function playbackTogglePlay() {
  if (!PLAYBACK.data) {
    PLAYBACK.active = true;
    playbackEnsureData();
    return;
  }
  if (!PLAYBACK.active) {
    PLAYBACK.active = true;
    PLAYBACK.index = 0;
    PLAYBACK.rev += 1;
  }
  if (!PLAYBACK.playing && PLAYBACK.index >= playbackBucketCount() - 1) {
    PLAYBACK.index = 0;  // replay from the start of the day
  }
  PLAYBACK.playing = !PLAYBACK.playing;
  playbackUpdateUI();
}

function playbackStep(delta) {
  const count = playbackBucketCount();
  if (!count) return;
  const base = PLAYBACK.active ? PLAYBACK.index : playbackLiveIndex();
  PLAYBACK.active = true;
  PLAYBACK.index = Math.max(0, Math.min(count - 1, base + delta));
  PLAYBACK.playing = false;
  PLAYBACK.rev += 1;
  playbackUpdateUI();
}

function playbackTick() {
  if (!PLAYBACK.playing || !playbackActive()) return;
  const count = playbackBucketCount();
  if (PLAYBACK.index >= count - 1) {
    PLAYBACK.playing = false;
    playbackUpdateUI();
    return;
  }
  PLAYBACK.index += 1;
  PLAYBACK.rev += 1;
  playbackUpdateUI();
}

function playbackUpdateUI() {
  const panel = document.getElementById("viz-playback");
  if (!panel) return;
  const visible = typeof VIZ !== "undefined" && VIZ.mode === "heatmap";
  panel.classList.toggle("hidden", !visible);
  if (typeof renderVizLegend === "function") renderVizLegend();
  if (!visible) return;

  const play = document.getElementById("pb-play");
  const slider = document.getElementById("pb-slider");
  const live = document.getElementById("pb-live");
  const time = document.getElementById("pb-time");
  const status = document.getElementById("pb-status");
  const count = playbackBucketCount();

  if (play) {
    play.textContent = PLAYBACK.playing ? "❚❚" : "▶";
    play.setAttribute("aria-label", PLAYBACK.playing ? "Pause playback" : "Play history");
    play.setAttribute("aria-pressed", PLAYBACK.playing ? "true" : "false");
    play.disabled = PLAYBACK.loading && !PLAYBACK.data;
  }
  if (slider) {
    slider.disabled = !count;
    slider.max = String(Math.max(0, count - 1));
    if (count) {
      const index = PLAYBACK.active ? PLAYBACK.index : playbackLiveIndex();
      if (slider.value !== String(index)) slider.value = String(index);
      slider.setAttribute("aria-valuetext", playbackTimeLabel());
    }
  }
  if (live) {
    live.classList.toggle("selected", !PLAYBACK.active);
    live.setAttribute("aria-pressed", PLAYBACK.active ? "false" : "true");
  }
  if (time) time.textContent = playbackTimeLabel();
  if (status) {
    status.textContent = playbackStatusText();
    status.title = PLAYBACK.data
      ? PLAYBACK.data.note
      : "Trapezoidal integration of simulated device history — not metered.";
    status.classList.toggle("pb-error", !!PLAYBACK.error);
  }
  panel.dataset.active = PLAYBACK.active ? "true" : "false";
  panel.dataset.playing = PLAYBACK.playing ? "true" : "false";
  panel.dataset.day = PLAYBACK.data ? String(PLAYBACK.data.day) : "";
  panel.dataset.bucket = playbackActive() ? String(PLAYBACK.index) : "";
  // the heatmap overlay reads the scrub position: repaint without waiting
  // for the next state poll
  if (typeof sceneInvalidate === "function") sceneInvalidate();
}

function initPlayback() {
  const play = document.getElementById("pb-play");
  const slider = document.getElementById("pb-slider");
  const live = document.getElementById("pb-live");
  if (play) play.addEventListener("click", playbackTogglePlay);
  if (slider) {
    slider.addEventListener("input", (e) => playbackSetIndex(e.target.value));
  }
  if (live) live.addEventListener("click", playbackGoLive);
  PLAYBACK.timer = setInterval(playbackTick, 900);
  playbackUpdateUI();
}

/* Called from app.js when the visualization mode changes. */
function playbackOnModeChange(mode) {
  if (mode === "heatmap") {
    if (!PLAYBACK.data) playbackEnsureData();
  } else {
    PLAYBACK.playing = false;
  }
  playbackUpdateUI();
}

/* Called once per state poll.  Refreshes today's history while the heatmap
   is visible, and keeps the live scrub position in sync with the clock. */
function playbackOnPoll() {
  if (typeof VIZ === "undefined" || VIZ.mode !== "heatmap") {
    if (PLAYBACK.playing) playbackTick();
    return;
  }
  const sim = typeof S !== "undefined" && S.snap ? S.snap.sim : null;
  const stale = !PLAYBACK.data || Date.now() - PLAYBACK.fetchedAt > 30000;
  const dayChanged = PLAYBACK.data && sim && PLAYBACK.data.day !== sim.day;
  if (stale || dayChanged) playbackEnsureData(true);
  if (!PLAYBACK.active && PLAYBACK.data) PLAYBACK.index = playbackLiveIndex();
  playbackUpdateUI();
}
