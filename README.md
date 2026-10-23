# Energy AI Platform

**Digital twin, virtual-sensor diagnostics, and energy intelligence for a simulated commercial campus.**

Energy AI Platform is a self-contained browser application for monitoring a small commercial estate and investigating equipment anomalies. It combines an interactive 3D Smart Building digital twin, room-level equipment and 48 rooftop PV modules, expected-vs-actual telemetry, a labeled sensor-fault dataset, an explainable diagnostic agent, an operator alarm workflow, and an Energy Intelligence layer that quantifies health, waste, cost, CO₂ and recommended actions.

> **Data provenance:** every reading in the default deployment is simulated. External sites are deterministic imported/mock feeds, not live hardware. The UI labels these sources explicitly. No physical devices, real MQTT broker, or utility meter are required.

---

## At a glance

| Area | Current implementation |
|---|---|
| Campus | 2 simulated buildings, 5 floors, 18 rooms; Tower A has the detailed 3D treatment and rooftop PV |
| PV plant | 48 modules (12 × 4), a 50 kWp array, and a 50 kW inverter |
| Equipment registry | 100 simulated assets, including room lighting/plug circuits, FCUs, building systems, elevator, UPS, EV charger, water heater, battery, inverter, and PV modules; 9 external monitoring points |
| Storage | 40 kW / 120 kWh campus battery |
| 3D renderer | Three.js r186 WebGL renderer by default; Canvas 2D fallback; `?render=canvas` force-option |
| UI | Vanilla HTML, CSS, and JavaScript; responsive desktop, tablet, and phone layouts |
| Server | Python standard library `ThreadingHTTPServer` bound to loopback |
| Persistence | SQLite (WAL) with versioned, append-only migrations; schema version 5 |
| Diagnostics | Deterministic rule engine by default; optional Claude enrichment |
| Core run dependencies | Python standard library only; Three.js is vendored locally and loaded from the repository, not a CDN; optional extras are listed below |

---

## Quick start

### Prerequisites

- **Python 3.10+** (the core server uses only the Python standard library).
- A modern browser. WebGL2 is recommended for the detailed 3D view; if unavailable, the app falls back to the Canvas renderer.
- A free local TCP port and a writable directory for the SQLite database.
- No Node.js, npm build step, database server, MQTT broker, or hardware is required.

Only the optional Claude enrichment needs an extra package (`anthropic`). Only `dataset/visualize_data.py` needs `matplotlib`, listed in `dataset/requirements.txt`; the server and web UI do not.

### Clone and run

```bash
git clone https://github.com/medeai68/energy-platform.git
cd energy-platform
python server.py --port 8080
```

The server binds only to `127.0.0.1`. Open:

```text
http://127.0.0.1:8080/
```

**Port note:** the built-in default is `8000`, but a different process or an older checkout may already use it. This guide uses `8080`, which was free during verification; pass any free port with `--port <number>`. `--port` is the server's only command-line option. The terminal banner prints the URL that was started.

The simulation **boots paused by design**. To start the demo, open **Settings → Resume simulation**. Time does not advance until it is resumed; the fleet's external feeds continue on wall-clock time.

Stop the server with `Ctrl+C` in the terminal.

### Database location

On first run the server creates:

```text
data/energy_intelligence.db
```

This file is runtime state and is ignored by Git. To use a separate database — for a clean demo, a test, or an isolated run — set `ENERGY_DB_PATH` before starting the server. The path is relative to the working directory unless absolute.

Bash / macOS:

```bash
ENERGY_DB_PATH=data/demo.db python server.py --port 8080
```

Windows PowerShell:

```powershell
$env:ENERGY_DB_PATH = "data/demo.db"
python server.py --port 8080
```

The parent directory is created automatically. Both the intelligence store and the equipment store use the same configured database and schema.

---

## Five-minute demo

The simulation must be running for values and detector states to change. Use **Settings → Resume simulation** first.

1. **Resume the simulation.** Open **Settings** in the sidebar and click **Resume simulation**. The status line changes from paused to running.
2. **Review the Overview.** Go to **Overview** (`#/overview`). The dashboard shows campus KPIs, the live scene, and the Energy Intelligence panel with health, waste, priorities, and recommendations.
3. **Explore the Smart Building.** Open **Digital Twin** (`#/twin/campus`). Click Tower A, then a floor band, then a room. Click equipment such as a light, a plug circuit, an FCU, the Server UPS, the elevator, or a rooftop PV module to open the inspector. Press `?` for the shortcut list; `Esc` goes back up or closes the drawer.
4. **Inject a controlled fault.** Open **Assets & Equipment**, search for **HVAC plant**, and click its row. In the inspector, scroll to **Virtual fault injection** and click **Inject** beside **Excessive consumption**. Wait a few simulation ticks while the detector builds a sustained deviation.
5. **Inspect the alert and diagnosis.** Open **Alarms** (or press `A`). The new alarm appears with its device, severity, and event state. In the equipment drawer, click **Ask AI to diagnose** to see probable causes, confidence, and corrective actions. The offline **RULE ENGINE** is used unless Claude is configured.
6. **Inspect Energy Intelligence.** Open **Energy Intelligence** (`#/intelligence`) to see the Energy Health Score, instantaneous and projected waste, cost and CO₂ impact, priority issues, and recommended actions. Click **AI Energy Report** for the in-page operator report.
7. **Work the alarm lifecycle.** In **Alarms**, acknowledge the condition. Return to the inspector, click **Clear** beside the active fault, and wait for the detector to mark the condition recovered. Then resolve the alarm with an optional note. The server refuses resolution while the condition is still active.
8. **Show history and portfolio context.** Use **Energy Analytics** (`#/analytics/production`, `consumption`, or `heatmap`) for production, consumption, grid exchange, battery flow, and historical heatmap playback. Use **Fleet** for the portfolio sites and their data sources.
9. **Reset when finished (optional).** **Settings → Reset simulation** clears faults and alerts and restarts the simulation. This is a state-changing action, so use it only when you intend to start over.

### Claims to make — and not make

**Say:** “A simulated campus with virtual sensors and a labeled sensor-fault dataset, plus an imported dataset feed and an in-process mock MQTT path. Energy, cost, and CO₂ figures are calculated estimates using documented formulas.”

**Do not claim:** real hardware, metered utility data, a real MQTT broker, a production-ready authentication boundary, or that the default rules engine is an LLM. The optional Claude path is explicitly optional; the deterministic rule engine is always the fallback.

---

## Application map

The shell uses hash routing. The following routes are implemented:

| Route | Purpose |
|---|---|
| `#/overview` | Campus overview, KPIs, 3D scene, Energy Intelligence panel |
| `#/twin/campus` | Campus-level digital twin |
| `#/twin/building/<id>` | Building view (for example `b1` or `b2`) |
| `#/twin/floor/<id>` | Floor view (for example `b1f2`) |
| `#/twin/room/<id>` | Room view (for example `b1f2r2`) |
| `#/twin/roof/<id>` | Rooftop PV view (for example `b1`) |
| `#/assets` | Assets & Equipment page |
| `#/assets/<deviceId>` | Assets page with a device selected |
| `#/analytics/production` | Energy Analytics — production |
| `#/analytics/consumption` | Energy Analytics — consumption |
| `#/analytics/heatmap` | Energy Analytics — heatmap and playback |
| `#/alarms` | Alarm Center page |
| `#/fleet` | Fleet portfolio page |
| `#/intelligence` | Energy Intelligence page |
| `#/settings` | Simulation, display, and operator settings |

Legacy hashes such as `#campus`, `#roof`, `#b1`, `#b1f2`, and `#b1f2r2` resolve to the equivalent twin route. Unknown routes render the not-found page.

### Keyboard and pointer controls

| Action | Control |
|---|---|
| Orbit the camera | Left-drag; one-finger drag on touch |
| Pan | Right-drag, Shift-drag, or middle-drag; two-finger drag on touch |
| Zoom | Scroll or pinch |
| Reset camera | `R` or the reset control |
| Focus the current selection | `F` |
| Frame the current building/floor/room | `H` |
| Move between scene objects | Arrow keys; `Home` / `End` |
| Open the focused object | `Enter` or `Space` |
| Go up one level / close | `Esc` |
| Open the Building Navigator search | `/` |
| Explode or collapse floors | `E` |
| Open or close the Alarm Center | `A` |
| Switch visualization mode | `1`–`6` |
| Open the shortcut help | `?` |

On phones, floating panels become bottom sheets. Window launchers remain visible in the sidebar so a closed panel can be reopened. **Settings** also exposes simulation speed, weather, visual effects, light/dark theme, and the operator name used for alarm actions.

---

## Capabilities

### 3D Smart Building digital twin

The digital twin models a campus with two buildings:

- **Tower A** — 3 floors, 12 rooms, detailed WebGL interiors, and a rooftop PV plant with 48 modules.
- **Annex B** — 2 floors and 6 rooms, shown as simplified architectural massing.
- **Campus fleet** — the external sites provide monitoring records and are not part of the 3D campus scene.

The WebGL renderer is the default. It provides the campus, building, floor, and room camera hierarchy, a curtain-wall cutaway, furnished rooms, live equipment glyphs, and keyframed camera flights. Each of the 48 PV modules is individually selectable; its inspector reports row/column position and performance. If WebGL2 is unavailable, module loading fails, or the context is lost, the legacy Canvas renderer takes over. Add `?render=canvas` to force the Canvas path. The **3D / List** toggle instead shows an accessible equipment-list view of the same hierarchy and readings. **Visual effects** offers **Full (animated)** and **Reduced (static, saves power)** modes.

The **Exploded** control separates floors vertically for inspection without changing any energy values, IDs, or membership. Device selection opens the shared inspector drawer.

### Building navigation and Assets & Equipment

The **Building Navigator** provides a synchronized view of **Campus → Building → Floor → Room → Equipment**:

- building, floor, and room selectors;
- clickable floor pills and breadcrumbs;
- searchable equipment list;
- type, status, and source filters, plus an **Anomalies** toggle;
- two-way synchronization with the 3D scene and the details drawer;
- keyboard access through `/` and deep links such as `#b1f2r2`.

The **Assets & Equipment** page uses the same registry as a full table. Search, filters, scope selectors, live kW values, and row clicks open the same device inspector. The registry is persisted in SQLite and includes external sites as well as the simulated campus.

### Energy monitoring and analytics

The dashboard and analytics pages expose:

- solar generation, building load, grid import/export, self-sufficiency, and battery state;
- today and yesterday energy totals;
- campus, building, floor, and room roll-ups;
- battery charge/discharge flow and state of charge;
- a per-building table with actual load, expected load, energy today, and active anomalies;
- calculated historical playback and a day-bucket heatmap for the current simulation day.

Visualization modes are **Status**, **Energy**, **Alerts**, **Health**, **Data**, and **Heatmap**. A legend always explains the active encoding. Alerts and Health are driven by the expected-vs-actual detector, not by high consumption alone: a device that uses a lot of power but tracks its expected model is not automatically marked faulty.

The 3D scene's heatmap playback uses 60-minute buckets and calls `GET /api/playback?bucket=60`, which returns the current simulation day by default. The **Energy Analytics → Heatmap playback** tab requests 360-minute (six-hour) buckets for the current simulation day, producing four buckets; the API accepts `bucket` values from 5 to 1440 minutes and defaults to 60. A bucket with no covered data is shown as neutral/no-data, not as a fabricated zero.

### Equipment inspector

Selecting an equipment object opens a drawer with:

- name, category, parent hierarchy, and measurement-source chip (`SIMULATED`, `LIVE`, or `IMPORTED`);
- expected model, actual reading, residual, status, and rated power;
- equipment-specific sensor readings and a data-freshness indicator;
- metering (simulated or calculated consumption, operating hours, last measurement);
- calculated energy estimates with method, formula, and window;
- scenario configuration and a baseline-vs-scenario comparison for simulated equipment;
- recent alerts and the active anomaly;
- virtual fault injection;
- per-equipment history charts;
- rule-based or Claude-enriched AI diagnosis.

Missing readings remain missing (`—`); the UI does not substitute a healthy value for a failed sensor or an empty history.

### Alert Center and alarm lifecycle

Every detector anomaly is persisted and can be worked through four states:

| State | Meaning |
|---|---|
| **Open** | The condition is active and no operator has acknowledged it |
| **Acknowledged** | An operator owns the condition; it remains active |
| **Recovered** | The detector cleared the condition; the record awaits close-out |
| **Resolved** | An operator closed a recovered record, optionally with a note |

The server enforces the workflow:

- resolve is refused with HTTP 409 while the condition is still active;
- acknowledgement and resolution are idempotent and record the operator and UTC timestamp;
- the resolution note is trimmed and capped at 500 characters;
- the active queue combines open and acknowledged records;
- status chips report full-table counts for active, open, acknowledged, recovered, resolved, and all records, while severity and building controls filter the list.

The **Alarm Center** can be opened from the **Alarms** sidebar entry, the Alerts card's **Manage** action, or `A`. The **Alerts** card is a compact queue; the Alarm Center is the full workflow. Selecting a device name opens the normal equipment inspector.

### AI diagnostics

The diagnostic agent is designed to explain a live deviation rather than invent one:

- sensor-layer faults (`sensor_drift`, `sensor_stuck`, and dataset sensor flags) are checked first, before the residual/noise-band path, and described as sensor conditions that may not indicate an equipment fault;
- a material residual outside the noise band is matched against a deterministic rule set of probable causes, confidences, and corrective actions;
- if no active, non-operator anomaly exists, the API returns `anomaly: null` rather than fabricating a warning;
- the diagnosis endpoint reads the full active-anomaly list rather than the dashboard's capped list.

**Optional Claude enrichment.** If the `anthropic` package is installed and `ANTHROPIC_API_KEY` is configured, the agent can send the device/anomaly context to Claude for a JSON-schema-constrained diagnosis. The current code targets `claude-opus-5`. Missing credentials, API errors, a missing package, a sensor fault, or a within-noise-band reading all fall back to the rule engine. Enabling Claude sends the diagnostic context to the Anthropic API; the default rule path is fully local.

### Energy Intelligence

The Energy Intelligence panel and `#/intelligence` page turn deviations into an operator view:

| Metric | Definition |
|---|---|
| **Energy Health Score** | 30% efficiency + 25% equipment health + 20% renewable utilization + 15% grid independence + 10% sensor health |
| **Waste now** | Positive excess consumption above the expected model; generation loss is reported separately |
| **Projected waste/day** | Current excess extrapolated over 24 hours |
| **Projected cost/day** | Projected daily waste × the configured electricity rate (default `$0.15/kWh`) |
| **Projected CO₂/day** | Projected daily waste × the configured grid factor (default `0.40 kg CO₂/kWh`) |
| **Priority issues** | Active anomalies ranked by severity, impact, and duration |
| **Recommended actions** | Equipment- and sensor-specific corrective actions from the rule set |

Energy Intelligence health bands are **Healthy** (≥85), **Attention required** (65–84), and **High risk** (<65). The 3D **Health** visualization uses separate bands: **Good** (≥85), **Fair** (65–84), **Poor** (40–64), and **Critical** (<40). The **AI Energy Report** is an accessible in-page dialog, not a native `alert()`; it presents status, summary, daily projected waste, projected cost, projected CO₂, and the top issue. The underlying `GET /api/intelligence/report` response also includes health, energy, production-loss, and recommendation data.

### Fleet and data sources

The Fleet page shows one card per site:

| Site | Feed | Storage source |
|---|---|---|
| Tower A | Simulated digital twin | `simulated` |
| Annex B | Simulated digital twin | `simulated` |
| Warehouse 12 | Deterministic imported dataset feed (`sim/fleet.py`) | `imported` |
| Office 3 | In-process mock MQTT broker and adapter (`iot/`) | `live` internally; labelled **SIMULATED MQTT feed** on the Fleet page (the inspector chip shows **LIVE**) |

The mock MQTT broker never opens a socket and every published message carries `"simulated": true`. The adapter uses the same canonical `equipment_store.import_measurement(...)` path a real collector would use. Fleet samples use wall-clock timestamps, so they continue while the campus simulation is paused. External sites have monitoring data but are not part of the 3D campus scene.

### Labeled sensor dataset

`dataset/sensor_data.csv` contains 1,000 labeled PV telemetry rows. The dataset bridge converts CSV watts to platform kW, preserves a missing `measured_power` as missing, and calls `dataset.sensor_faults.classify_row()` as the single source of truth for sensor-fault classification.

Supported labels include `normal`, `voltage_bias`, `voltage_drift`, `sensor_dropout`, `stuck_sensor`, `sensor_noise`, `panel_overheating`, `inverter_overheating`, `power_loss`, and `grid_voltage_anomaly`.

Validate the full bridge:

```bash
python -m dataset.validate
# equivalent direct invocation:
python dataset/validate.py
```

The validation path is:

```text
CSV row → classify_row() → adapter → device-shaped telemetry
        → diagnose() → primary_fault → ground-truth comparison
```

This is an end-to-end bridge test, not a classifier-only accuracy claim. The current dataset reports **95.9% end-to-end accuracy** on 1,000 rows. Results are specific to this synthetic labeled dataset.

---

## How energy is calculated

The documented energy-estimate arithmetic lives in `equipment/calculations.py`; the simulation's own counters live in `sim/engine.py`. The platform distinguishes four quantities:

| Quantity | Meaning |
|---|---|
| **Rated power** | Nameplate capacity from the equipment registry; not a consumption |
| **Measured power** | One instantaneous sensor/virtual-meter reading |
| **Simulated energy** | Energy integrated by the simulation engine's own counter |
| **Calculated energy** | Energy derived from measured power with the documented formulas; always an estimate |

**Constant-power estimate.** When the measured series is approximately constant — `(max(P) − min(P)) / mean(P) ≤ 0.10` — the platform uses `E = P × t`, where `P` is the mean measured power and `t` is the covered measurement-window duration in hours.

**Variable-power estimate.** Otherwise it integrates over measured timestamps with the trapezoidal rule:

```text
E = Σ ((P_i + P_i+1) / 2) × (t_i+1 − t_i) / 60
```

Simulation timestamps are absolute minutes, so `Δt / 60` converts to hours. If there are fewer than two usable samples, or no usable interval, the result is `status != "ok"` and `energy_kwh: null`; the UI renders an empty state rather than inventing a number.

**Scenario estimate.** For `source = "simulated"` equipment, operators can configure rated power, daily operating hours, a load factor (0–1), and a schedule start hour (0–24); the schedule must end by hour 24 (`schedule_start + operating_hours ≤ 24`):

```text
E_scenario = rated_power_kw × load_factor × operating_hours   (kWh/day)
monthly    = E_scenario × 30
```

A scenario is rejected for live/imported equipment. The baseline-vs-scenario comparison uses the same covered window on both sides so a data gap cannot inflate the result; it is labelled as an estimate, not metered consumption.

**Provenance.** Measured-series results report their method, formula, window, sample count, thresholds, and caveats; scenario results report their inputs, method, formula, basis, and note. Scenario output is arithmetic on configured inputs and never represents metered consumption. `simulated_energy_kwh` is a simulation counter, not a utility meter register. Live/imported readings are integrated from canonical persisted measurements, never from the simulation counter.

---

## API reference

The server exposes JSON over HTTP. All routes below are implemented in `server.py`; successful GETs are read-only.

| Method and path | Purpose |
|---|---|
| `GET /api/state` | Digital-twin snapshot plus current intelligence |
| `GET /api/intelligence` | Health, waste, priorities, and recommendations |
| `GET /api/intelligence/report` | Daily operator report |
| `GET /api/intelligence/history` | Most recent stored intelligence snapshots (up to 100) |
| `GET /api/equipment` | Registry with latest canonical measurement and stats |
| `GET /api/equipment?building=b1&floor=b1f2&room=b1f2r2&category=fcu&source=simulated` | Filtered registry |
| `GET /api/equipment/<id>` | Equipment detail, history, and anomalies |
| `GET /api/device/<id>` | Live inspector payload, including the `energy` block |
| `GET /api/alarms?status=active&severity=&building=&limit=100` | Alarm records, counts, and filters |
| `GET /api/playback?bucket=60&day=N` | Calculated historical energy per space for one simulation day (bucket 5–1440 minutes) |
| `POST /api/fault` | Inject or clear a fault: `{ "device_id": "...", "fault_id": "...", "active": true }` |
| `POST /api/control` | Simulation control: `{ "action": "pause", "value": false }`, plus `speed`, `weather`, and `reset` |
| `POST /api/ai/diagnose` | Diagnose one device: `{ "device_id": "..." }` |
| `POST /api/intelligence/scenario` | Estimate savings: `{ "device_id": "hvac", "reduction_pct": 100, "hours": 8 }` |
| `POST /api/equipment/<id>/scenario` | Save a simulated scenario configuration; send `{ "clear": true }` to remove it |
| `POST /api/energy/calculate` | Pure scenario calculation from rating, hours, load factor, and schedule start |
| `POST /api/alarms/acknowledge` | `{ "equipment_id": "...", "event_key": "...", "operator": "..." }` |
| `POST /api/alarms/resolve` | `{ "equipment_id": "...", "event_key": "...", "operator": "...", "note": "..." }`; HTTP 409 while active |

Request bodies must be JSON objects of at most 64 KiB. The server validates types and ranges for controls, fault fields, scenarios, and alarm actions. Resolve is server-guarded rather than merely disabled in the UI.

A minimal read-only check after startup:

```bash
curl http://127.0.0.1:8080/api/state
curl http://127.0.0.1:8080/api/equipment
curl http://127.0.0.1:8080/api/intelligence
```

---

## Persistence and reliability

- The intelligence layer and equipment model share one SQLite database, with WAL enabled and a busy timeout.
- `equipment/migrations.py` owns schema version 5 and applies append-only, idempotent migrations at startup.
- Equipment measurements use a composite primary key `(equipment_id, measured_at)` and UPSERT writes, so a repeated reading replaces the canonical row instead of creating a duplicate.
- Anomalies use `(equipment_id, event_key)` and record open/close plus operator workflow columns.
- Simulation samples are written every 10 real seconds; repeated writes in a paused simulation are idempotent.
- GET endpoints do not persist snapshots or refresh alarms. Alarm persistence happens in the sampling loop and immediately after a fault mutation.
- If polling fails, a dismissible connection banner holds the last snapshot on screen while the client retries.
- POST bodies are size-capped, parsed as JSON objects, and validated before state changes.
- The server binds only to `127.0.0.1`; it is intended for a local demo or development workstation, not as a hardened multi-user deployment.

**Schema version and database path** are reported by `GET /api/equipment` in `stats.schema_version` and `stats.db_path`.

---

## Tests and validation

Run the backend suite from the repository root:

```bash
python -m unittest discover -s tests -v
```

The suite contains 142 tests and passed on the current commit during the documentation verification (2026-10-24). Tests use isolated temporary databases and do not require a running server. One pre-existing panel-isolation test is sensitive to randomized weather/noise and can occasionally fail a run; rerun before treating an isolated failure as a regression.

Validate the sensor bridge:

```bash
python -m dataset.validate
```

Result on the current commit: **1,000 rows, 95.9% end-to-end accuracy**. This validates the CSV → classifier → adapter → diagnostic agent path against the dataset's ground-truth labels.

Optional dataset plotting requires `matplotlib` from `dataset/requirements.txt`; it is not needed by the application server or the UI.

---

## Project layout

```text
energy-platform/
├── server.py                    # stdlib HTTP server, routing, API validation
├── sim/
│   ├── engine.py                # campus, buildings, devices, telemetry, detector
│   ├── faults.py                # virtual fault catalog
│   └── fleet.py                 # deterministic imported external-site feed
├── ai/
│   ├── agent.py                 # rule engine and optional Claude enrichment
│   └── anomaly.py               # detector helpers
├── dataset/
│   ├── sensor_data.csv          # 1,000 labeled PV rows
│   ├── sensor_simulator.py
│   ├── sensor_faults.py         # single source of truth for sensor labels
│   ├── adapter.py               # CSV watts → platform kW
│   ├── validate.py              # end-to-end bridge validation
│   └── requirements.txt         # matplotlib, only for visualize_data.py
├── intelligence/
│   ├── engine.py                # facade over metrics, priorities, recommendations
│   ├── metrics.py               # health, waste, cost, CO₂
│   ├── scoring.py               # anomaly prioritization
│   ├── recommendations.py
│   ├── reports.py
│   └── persistence.py
├── equipment/
│   ├── model.py
│   ├── store.py                 # canonical SQLite CRUD, alarms, scenarios
│   ├── migrations.py            # append-only schema versions 1–5
│   ├── calculations.py          # documented energy formulas
│   └── playback.py
├── iot/
│   ├── mock_broker.py           # in-process MQTT-shaped mock
│   └── adapter.py               # simulated adapter → canonical measurement path
├── tests/                       # 142 offline tests
└── web/
    ├── index.html               # shell entry point
    ├── shell.js / shell.css     # application frame, routing, windows
    ├── scene.js                 # Canvas twin and WebGL bootstrap
    ├── building.js              # building/floor/room hierarchy and camera
    ├── twin3d*.js               # Three.js WebGL presentation
    ├── navigator.js             # building navigator and equipment table
    ├── alarms.js                # Alarm Center
    ├── energy-intelligence.js   # intelligence panel and report dialog
    ├── app.js                   # dashboard, inspector, polling, fault UI
    ├── viz.js / playback.js     # visualization modes and heatmap playback
    └── vendor/                  # Three.js r186 and its MIT license
```

---

## Known limitations

- **Everything is simulated.** Tower A/Annex B use virtual sensors; Warehouse 12 is an imported dataset feed; Office 3 is an in-process mock MQTT feed. There is no physical-device integration, real broker, or metered utility data.
- **Projections are estimates.** “Projected waste/day”, cost, and CO₂ extrapolate the current excess over 24 hours using default factors (`$0.15/kWh`, `0.40 kg CO₂/kWh`). They are not billing or carbon-accounting records.
- **The local server is not hardened.** It binds to loopback only, has no authentication or TLS, and is intended for a trusted local environment.
- **SQLite is single-node.** Do not point multiple server processes at the same database file or treat this as a horizontally scalable production store.
- **3D detail is asymmetric.** Tower A has the detailed WebGL interior; Annex B is architectural massing. WebGL2 is required for the enhanced renderer; the Canvas fallback is lower-fidelity.
- **The intelligence history endpoint has no scheduled writer in this build.** `/api/intelligence/history` returns any previously stored snapshots, so a fresh database returns an empty list. Equipment measurements and alarms are persisted continuously.
- **Optional Claude is optional.** It requires `anthropic` and `ANTHROPIC_API_KEY`; without them the deterministic rule engine is used. Never enable it with data you are not prepared to send to the Anthropic API.
- **The simulation starts paused.** This is deliberate: no simulated time passes until an operator resumes it. External fleet feeds continue on wall-clock time.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| The page looks like an older UI | Confirm you opened the port printed by the server you just started. The current entry point serves the shell assets from `web/index.html`; there is no separate frontend build. |
| The simulation appears frozen | It starts paused. Open **Settings → Resume simulation**. |
| The 3D view is blank or refuses WebGL | The app should fall back to Canvas. Force it with `?render=canvas` and check that the browser supports WebGL2 for the detailed renderer. |
| Port already in use | Choose another free port, for example `python server.py --port 8081`. |
| Database or permission error | Set `ENERGY_DB_PATH` to a writable file and ensure its parent directory can be created. |
| AI diagnosis always says “RULE ENGINE” | Claude is optional. Install `anthropic`, set `ANTHROPIC_API_KEY`, and restart; failures fall back to the rule engine by design. |

---

## License

MIT — see [LICENSE](LICENSE).

Three.js is vendored under `web/vendor/` with its own MIT license in `web/vendor/LICENSE.three.txt`.

## Credits

- Digital twin, simulation engine, anomaly detection & AI agent: medeai68
- Energy Intelligence layer & sensor dataset bridge: Stephen (PR #2)
- Original sensor dataset bridge: Mohammed (PR #1)
- PV sensor dataset pipeline: Ali (makaynwalu/Solar-Energy-Enterprise-AI-Monitoring-Simulation-System)

## Repository

- Source: <https://github.com/medeai68/energy-platform>
- This README was verified against the application code at commit `b13ea638ace323b37b87c731abacf296a4d1da02` on 2026-10-24.
