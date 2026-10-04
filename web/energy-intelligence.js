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
  const main = document.querySelector("main.layout");
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
  main.insertBefore(section, main.firstElementChild);
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

async function pollIntelligence() {
  try {
    const r = await fetch("/api/intelligence");
    if (r.ok) renderIntelligence(await r.json());
  } catch (_) {}
}

async function showReport() {
  ensurePanel();
  const btn = ei$("ei-report");
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    const r = await fetch("/api/intelligence/report");
    const report = await r.json();
    alert(
      `${report.status}\n\n${report.summary}\n\n` +
      `Daily projected waste: ${report.waste.projected_daily_kwh} kWh\n` +
      `Projected cost: $${report.waste.projected_daily_cost}\n` +
      `Projected CO₂: ${report.waste.projected_daily_co2_kg} kg\n\n` +
      `Top issue: ${report.top_issues[0]?.message || "None"}`
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "AI Energy Report";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  ensurePanel();
  pollIntelligence();
  setInterval(pollIntelligence, 5000);
});
