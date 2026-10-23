/* Energy Intelligence UI - consumes /api/intelligence and /api/intelligence/report. */
"use strict";

const EI = { data: null };

function ei$(id) { return document.getElementById(id); }
function eiEsc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function eiScoreClass(score) {
  return score >= 85 ? "ei-good" : score >= 65 ? "ei-warn" : "ei-critical";
}

function ensurePanel() {
  if (ei$("energy-intelligence")) return;
  // Phase 2: the legacy below-fold region is a section inside the application
  // main, not a nested <main> landmark.
  const main = document.getElementById("below-fold")
    || document.querySelector(".layout.below-fold");
  if (!main) return;
  const section = document.createElement("section");
  section.id = "energy-intelligence";
  section.className = "card ei-panel";
  section.innerHTML = `
    <div class="card-head ei-head">
      <div>
        <h2>Energy Intelligence</h2>
        <p class="sub">Operational health, energy waste and AI-driven priorities</p>
      </div>
      <div class="ei-actions">
        <button id="ei-report" class="btn">AI Energy Report</button>
      </div>
    </div>
    <div class="ei-grid">
      <div class="ei-score">
        <div class="ei-score-label">Energy Health</div>
        <div id="ei-score" class="ei-score-value">—</div>
        <div id="ei-score-status" class="ei-score-status">Loading…</div>
      </div>
      <div class="ei-metric"><b id="ei-waste">—</b><span>Waste now</span></div>
      <div class="ei-metric"><b id="ei-daily">—</b><span>Projected waste/day</span></div>
      <div class="ei-metric"><b id="ei-cost">—</b><span>Projected cost/day</span></div>
      <div class="ei-metric"><b id="ei-co2">—</b><span>Projected CO₂/day</span></div>
    </div>
    <div class="ei-components" id="ei-components"></div>
    <div class="ei-columns">
      <div><h3>Priority issues</h3><div id="ei-issues"></div></div>
      <div><h3>Recommended actions</h3><div id="ei-recommendations"></div></div>
    </div>
  `;
  main.append(section);
  ei$("ei-report").addEventListener("click", showReport);
}

function eiIssuesHTML(issues) {
  return issues.length ? issues.slice(0, 4).map(e => `
    <div class="ei-item">
      <div><strong>${eiEsc(e.device_name)}</strong> <span class="ei-badge">${eiEsc(e.severity)}</span></div>
      <div>${eiEsc(e.message)}</div>
      <small>Impact ${Number(e.impact_kw || 0).toFixed(2)} kW · priority ${Number(e.priority_score || 0).toFixed(0)}/100</small>
    </div>`).join("") : `<div class="ei-empty">No active priority issues.</div>`;
}

function eiRecsHTML(recs) {
  return recs.length ? recs.slice(0, 4).map(r => `
    <div class="ei-item">
      <strong>${eiEsc(r.priority)} · ${eiEsc(r.device_name || r.device_id)}</strong>
      <div>${eiEsc(r.action)}</div>
      <small>${eiEsc(r.reason)}</small>
    </div>`).join("") : `<div class="ei-empty">No corrective actions required.</div>`;
}

function renderIntelligence(data) {
  EI.data = data;
  ensurePanel();
  if (!ei$("ei-score")) return;

  // scalar readouts: patched in place, no DOM teardown (keeps scroll position stable)
  const score = Number(data.health_score || 0);
  ei$("ei-score").textContent = `${score.toFixed(0)}/100`;
  ei$("ei-score").className = `ei-score-value ${eiScoreClass(score)}`;
  ei$("ei-score-status").textContent =
    score >= 85 ? "Healthy" : score >= 65 ? "Attention required" : "High risk";

  ei$("ei-waste").textContent = `${Number(data.instantaneous_waste_kw || 0).toFixed(2)} kW`;
  ei$("ei-daily").textContent = `${Number(data.projected_daily_waste_kwh || 0).toFixed(1)} kWh`;
  ei$("ei-cost").textContent = `$${Number(data.projected_daily_waste_cost || 0).toFixed(2)}`;
  ei$("ei-co2").textContent = `${Number(data.projected_daily_waste_co2_kg || 0).toFixed(1)} kg`;

  // health bars: built once, widths patched
  if (!EI.bars) {
    const wrap = ei$("ei-components");
    wrap.textContent = "";
    EI.bars = ["Efficiency", "Equipment", "Renewable", "Grid independence", "Sensors"].map(name => {
      const div = document.createElement("div");
      div.className = "ei-bar";
      const sp = document.createElement("span"); sp.textContent = name;
      const b = document.createElement("b");
      const i = document.createElement("i");
      const em = document.createElement("em");
      i.append(em);
      div.append(sp, b, i);
      wrap.append(div);
      return { b, em };
    });
  }
  const components = data.health_components || {};
  const comps = ["efficiency", "equipment", "renewable", "grid", "sensors"].map(k => components[k]);
  EI.bars.forEach((bar, k) => {
    const v = Number(comps[k] || 0);
    bar.b.textContent = v.toFixed(0);
    bar.em.style.width = `${Math.max(0, Math.min(100, v))}%`;
  });

  // lists: rebuilt only when their content actually changes
  const issues = data.prioritized_events || [];
  const recs = data.recommendations || [];
  const issuesJson = JSON.stringify(issues.slice(0, 4));
  const recsJson = JSON.stringify(recs.slice(0, 4));
  if (EI.issuesJson !== issuesJson) {
    EI.issuesJson = issuesJson;
    ei$("ei-issues").innerHTML = eiIssuesHTML(issues);
  }
  if (EI.recsJson !== recsJson) {
    EI.recsJson = recsJson;
    ei$("ei-recommendations").innerHTML = eiRecsHTML(recs);
  }
}

/* This panel is refreshed by app.js's pollIntelligence() from the shared
   /api/intelligence payload.  It intentionally runs no timer of its own:
   the previous second poll loop doubled every intelligence request. */

/* ---------------- AI Energy Report dialog ---------------- */

/* Accessible in-page dialog (replaces the blocking native alert()): the
   report is presentation material, so it must be themed, readable on a
   projector and on a phone, announced to assistive technology, and it must
   not block the page. Content is inserted with textContent only. */
let EI_REPORT = { dialog: null, close: null, title: null, status: null,
                  summary: null, grid: null, opener: null };

function ensureReportDialog() {
  if (EI_REPORT.dialog) return EI_REPORT;
  const backdrop = document.createElement("div");
  backdrop.className = "ei-report-backdrop hidden";
  backdrop.id = "ei-report-dialog";
  backdrop.innerHTML = `
    <div class="ei-report-card" role="dialog" aria-modal="true"
         aria-labelledby="ei-report-title" aria-describedby="ei-report-summary">
      <div class="ei-report-head">
        <div>
          <span class="ei-report-kicker">Simulated · Energy Intelligence</span>
          <h2 id="ei-report-title">AI Energy Report</h2>
        </div>
        <button type="button" class="btn" id="ei-report-close"
                title="Close the report" aria-label="Close the report">&times;</button>
      </div>
      <p class="ei-report-status" id="ei-report-status">Generating…</p>
      <p class="ei-report-summary" id="ei-report-summary"></p>
      <dl class="ei-report-grid" id="ei-report-grid"></dl>
      <p class="ei-report-note">Calculated from simulated sensor history with the
        documented formulas — not metered. No physical devices are connected.</p>
    </div>`;
  document.body.append(backdrop);
  const close = backdrop.querySelector("#ei-report-close");
  close.addEventListener("click", () => closeReport());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeReport(); });
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeReport();
    } else if (e.key === "Tab") {
      // single focusable control: keep focus inside the dialog
      e.preventDefault();
      close.focus();
    } else {
      // keep page-level shortcuts (A, E, 1-6, /, …) from firing behind the
      // aria-modal report
      e.stopPropagation();
    }
  });
  EI_REPORT = {
    dialog: backdrop, close,
    title: backdrop.querySelector("#ei-report-title"),
    status: backdrop.querySelector("#ei-report-status"),
    summary: backdrop.querySelector("#ei-report-summary"),
    grid: backdrop.querySelector("#ei-report-grid"),
    opener: null,
  };
  return EI_REPORT;
}

function openReportDialog(opener) {
  const d = ensureReportDialog();
  // a programmatic .click() does not move focus, so the trigger button is
  // passed explicitly; fall back to whatever held focus.
  d.opener = opener || document.activeElement;
  d.dialog.classList.remove("hidden");
  d.close.focus();
}

function closeReport() {
  const d = EI_REPORT;
  if (!d || !d.dialog) return;
  d.dialog.classList.add("hidden");
  if (d.opener && typeof d.opener.focus === "function" && document.contains(d.opener)) {
    try { d.opener.focus({ preventScroll: true }); } catch (_) { /* detached */ }
  }
  d.opener = null;
}

function eiReportRow(label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  return [dt, dd];
}

async function showReport() {
  ensurePanel();
  const btn = ei$("ei-report");
  const d = ensureReportDialog();
  openReportDialog(btn);
  d.title.textContent = "AI Energy Report";
  d.status.textContent = "Generating…";
  d.summary.textContent = "";
  d.grid.textContent = "";
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    const report = await netJSON("/api/intelligence/report", { timeout: 8000 });
    d.status.textContent = report.status || "Report";
    d.summary.textContent = report.summary || "";
    d.grid.textContent = "";
    const rows = [
      ["Daily projected waste", `${report.waste.projected_daily_kwh} kWh`],
      ["Projected cost", `$${report.waste.projected_daily_cost}`],
      ["Projected CO₂", `${report.waste.projected_daily_co2_kg} kg`],
      ["Top issue", (report.top_issues && report.top_issues[0] && report.top_issues[0].message) || "None"],
    ];
    for (const [label, value] of rows) {
      const [dt, dd] = eiReportRow(label, String(value));
      d.grid.append(dt, dd);
    }
  } catch (err) {
    d.title.textContent = "Report unavailable";
    d.status.textContent = "Could not generate the report.";
    d.summary.textContent =
      (err && err.message ? err.message : "The server is unreachable.")
      + " — the panel keeps working and the report can be retried.";
    d.grid.textContent = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "AI Energy Report";
  }
}

window.addEventListener("DOMContentLoaded", ensurePanel);
