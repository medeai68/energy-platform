# Energy AI Platform — Digital Twin, AI Diagnostics & Energy Intelligence

AI-powered energy monitoring and intelligent diagnosis for solar-energy enterprises. The platform combines an interactive perspective digital twin, virtual sensors, labeled sensor-fault data, anomaly detection, an explainable AI agent, and an Energy Intelligence layer that quantifies waste and recommends actions.

**Zero runtime dependencies:** Python standard library backend + vanilla HTML/JS/Canvas dashboard. Claude enrichment remains optional.

## Run

```bash
cd energy-platform
python server.py --port 8000
```

Open http://localhost:8000.

## End-to-end demo

1. Start the platform.
2. Click **HVAC** and inject **Excessive consumption**.
3. Wait for the sustained anomaly.
4. Click **Ask AI** to receive probable causes and corrective actions.
5. Open **Energy Intelligence** to see:
   - Energy Health Score
   - current excess consumption
   - projected daily waste
   - cost impact
   - CO2 impact
   - ranked priority
   - recommended action
6. Use **AI Energy Report** for an operator summary.
7. Use the scenario API to estimate savings if a fault is fixed.
8. Clear the fault and watch the health score recover.

## Individual solar panel monitoring

The rooftop array is simulated as **48 individual PV modules** (12 × 4), each with a stable id (`p01`–`p48`), row/column position, its own expected-vs-actual model, telemetry (voltage, current, cell temperature, performance %) and its own fault state.

- Click any panel in the twin to open its inspection drawer; scroll to zoom (ids appear when zoomed), drag to pan.
- Each panel supports its own virtual faults: **Reduced output** (underperforming, ~15% loss), **Overheating** (faulted, hot spot +25°C, ~28% loss) and **Disconnected** (offline, zero output).
- A fault on one panel changes only that panel: its appearance changes in the twin, its power drops, the anomaly is reported against that specific panel id, and the aggregate array output (and every dashboard KPI derived from it) updates from the sum of the panel outputs.
- Clearing the fault restores the panel to Normal and closes its anomaly event.
- Array-level faults (soiling, shading, degradation, panel/string failure) still apply to the whole array and keep raising the array-level anomaly as before.

## Interactive 3D smart building

The digital twin is now a fully interactive campus. The same perspective
canvas (`web/building.js` extends the hand-rolled camera of `web/scene.js`)
renders procedural glass buildings — no external 3D library, no paid assets:

- **Campus view** — Tower A (3 floors, rooftop PV plant) and Annex B
  (2 floors) on a shared ground plane. Click a building to enter it.
- **Building view** — stacked floors behind a translucent curtain wall
  with lit windows at night, floor bands and the rooftop plant. Click a
  floor band (or a view-nav pill) to open that floor; click the roof to
  open the PV scene.
- **Floor view** — a cutaway plan of the floor: rooms with walls and
  doors, procedural furniture (desks with monitors, meeting tables,
  lobby, server racks, pantry, restrooms), and live equipment glyphs —
  ceiling lights, plug sockets, the floor FCU with a spinning fan, the
  elevator cab (it moves between floors), server racks with status LEDs.
- **Room view** — close-up of one room with its lighting and plug
  circuits, live power tags, and click-through to the device drawer.

Every leaf device keeps the platform's full expected-vs-actual machinery:
its own fault catalog (`/api/fault`), anomaly detection, AI diagnosis
(`/api/ai/diagnose`) and energy-intelligence impact. Injecting a fault on
one room's circuit changes only that room (plus the aggregate it feeds),
exactly like the per-panel solar model.

The hierarchy is simulated in `sim/engine.py`:

```text
campus
├── b1 Tower A (3 floors, rooftop PV)
│   ├── b1f1 Floor 1 → Lobby, Open Office 1, Meeting Room, Restrooms
│   ├── b1f2 Floor 2 → Open Office 2, Server Room, Meeting Room, Pantry
│   ├── b1f3 Floor 3 → Executive Suite, Open Office 3, Meeting Room, Restrooms
│   └── equipment: Elevator (el-b1), Server UPS (ups-b1), EV Charger (ev-b1)
└── b2 Annex B (2 floors)
    ├── b2f1 Floor 1 → Reception, Workshop, Storage
    ├── b2f2 Floor 2 → Studio, Office, Restrooms
    └── equipment: Water Heater (wh-b2)
```

- 45 leaf devices: room lighting circuits (`lt-*`), room plug loads
  (`pl-*`, computers/monitors/office equipment), one fan-coil per floor
  (`fc-*`) and four building systems. The aggregate devices (HVAC plant,
  lighting, plug loads, building systems) are exactly the sums of their
  leaves, so every dashboard KPI, chart and intelligence metric keeps
  working unchanged — and a fault on a leaf moves the aggregate too.
- The snapshot carries the full tree (`buildings` + `equipment`) so the
  UI needs no extra endpoints; breadcrumbs, floor pills and level cards
  are rendered client-side.
- Deep links: `#campus`, `#b1`, `#b1f2`, `#b1f2r2`, `#roof`.

### Selection and camera controls

Everything is selectable **directly in the 3D scene** (no list required):

- **Buildings** — click anywhere on a building in the campus view.
- **Floors** — click a floor band in the building view (or a floor pill).
- **Rooms** — click a room in the floor view; the camera flies into it.
- **Devices** — click lights, plug sockets, the floor FCU, server racks,
  the elevator shaft, the EV charger, the water heater, the inverter or
  any PV panel. Selecting via the building navigator or level cards also
  highlights the object in the scene.

The selected object gets a pulsing cyan ring (devices) or glowing outline
(rooms, floors, buildings). The information panel (right drawer, bottom
sheet on phones) shows the object's name, live expected-vs-actual power,
status, fault injection and AI diagnosis, plus a clickable hierarchy chain
`Campus › Building › Floor › Room › Device` and a **back-to-parent**
button.

Camera gestures (mouse, keyboard and touch):

| Action | Mouse | Keyboard | Touch |
|---|---|---|---|
| Orbit | left-drag | — | one-finger drag |
| Pan | right-drag / shift-drag / middle-drag | — | two-finger drag |
| Zoom | scroll (eased, cursor-anchored) | — | pinch |
| Reset camera | `⤢` button | `R` | — |
| Focus selection | — | `F` | — |
| Go up / close panel | — | `Esc` | back button |

View changes use a **keyframed camera flight**: it lifts to a safe waypoint
above the building envelope (high pitch, pulled-back distance) before diving
onto the destination, so the camera never clips through floors or walls and
the motion stays legible. Any manual gesture cancels the flight and hands
control back to the user. Panning moves the camera target in world space
(works at any zoom) and is clamped to one view-distance around the view's
home target.

### Exploded floor view

The building view has an **⧉ Exploded** toggle in the view nav and on the
level card. Floors ease vertically apart on their slabs — the ground floor
stays put, each upper floor lifts by `floor_height × gap`, and the roof lifts
clear of the stack — while the camera pulls back and raises its target so the
whole exploded building stays framed. Slab tops become the floor click
targets and each level keeps its own equipment hit areas, so floors and
devices remain selectable directly from the exploded stack. The level card
action reads **⧉ Collapse floors** while active; leaving the building view
collapses the layout. The exploded state is presentation only — positions,
IDs, membership and energy values are unchanged.

### Camera transitions into rooms

Entering a room from a building or floor uses a deliberate three-key flight
(`VIEW.transition.kind = "room-entry"`): a safe overhead waypoint, a closer
approach above the doorway, then a settle inside the room. **⌖ Enter room**
on the room level card replays the same path; other view changes keep the
two-key waypoint flight.

### WebGL presentation (`?render=gl`, now the default)

The WebGL (Three.js) renderer for **Tower A** is the default. Appending
`?render=canvas` to the URL opts out to the legacy Canvas renderer;
`?render=gl` remains accepted as the explicit spelling of the default. If
WebGL2 is unavailable, a module fails to load, or the context is lost, the
app falls back to the Canvas scene and keeps working.

- **Presentation scale.** The WebGL world uses its own architectural scale
  (`web/twin3d-presentation.js`) so the tower reads as a slender commercial
  high-rise. Room areas (252/204/204 m² in Tower A), equipment IDs, floor and
  room membership, energy calculations and simulated readings are unchanged
  system data and are never derived from the model's dimensions. A visible
  "Presentation scale" note is shown only while the WebGL prototype is active.
- **Modules.** `twin3d.js` (renderer, camera bridge, picking, fallback),
  `twin3d-kit.js` (materials, sky, batching helpers), `twin3d-arch.js`
  (tower/annex shells, façade, cutaway), `twin3d-interiors.js` (furniture,
  server room, equipment) and `twin3d-presentation.js` (presentation-scale
  layout and camera paths). Three.js r0.186.1 is vendored under `web/vendor/`
  with its MIT license; there are no runtime CDN requests.
- **Visuals.** Glass-and-steel façade with mullions and fins, dusk sky
  environment lighting, warm interior fixtures, soft shadows, a curtain-wall
  cutaway that fades glass facing the camera, and per-room furnished
  interiors. Selection accents remain optional; the building is designed to
  read without them.
- **Measured cost.** On headless Edge with an Intel UHD 630 (D3D11) at
  1600×1000, one prototype frame costs about 38 ms in the campus view,
  32 ms in the building view, 19 ms on a floor and 15 ms inside a room
  (`TWIN3D.measure`, renderer only). The Canvas renderer remains the
  default path; SwiftShader screenshots are used only for deterministic
  visual evidence.
- **Navigation.** Campus → Building → Floor → Room transitions use a
  Catmull-Rom camera flight (eye and look-target tracks) with eased timing;
  device selection still opens the existing inspector. The Canvas camera
  preset hands off to the WebGL camera on first activation.
- **Scope and limits.** Only Tower A receives the detailed treatment; Annex B
  is included as simple massing. All telemetry, faults and alarms remain
  **simulated** — the renderer does not connect to physical devices.

### Building navigation

The **building navigator** (`web/navigator.js`, opened from the building
rail icon) is the single place to move through the hierarchy
**Campus → Building → Floor → Room or Zone → Equipment**:

- **Scope selectors** — building, floor and room dropdowns. The floor
  selector lists the selected building's floors; with no floor chosen the
  room selector groups rooms by floor. Changing a selector navigates the
  3D scene, opens the details drawer and updates both breadcrumb trails.
- **Clickable floor navigation** — floor pills (`All`, `F1`, `F2`, …) jump
  straight to a floor of the current building; **All** returns to that
  building's overview.
- **Breadcrumbs** — the panel trail mirrors the page breadcrumb and the
  current 3D view (`Campus › Tower A › Floor 2 › Server Room › Server UPS`);
  every level except the current one is clickable.
- **Searchable equipment list** — all 99 registered items (leaf devices,
  aggregates and the 48 PV modules) grouped by plant, floor and room with
  item counts and live kW. A non-empty query searches names, IDs, categories
  and parents across every building, not just the current scope.
- **Equipment filtering** — type (Lighting & plugs, HVAC, Systems, Solar PV),
  status (Normal / Warning / Serious / Critical) and an **anomalies only**
  toggle compose with each other, the search query and the navigator scope.
  Type groups form a partition (each kind belongs to exactly one group);
  anomalous rows carry a ⚠ count. The empty state names the active query and
  filters, and **Clear search & filters** resets them in one action.
- **Selected-object details panel** — the right drawer (bottom sheet on
  phones) shows the selected object with the full equipment inspector; a
  *Selected* summary at the foot of the navigator links to the same panel.
- **Return-to-building overview** — `⌂ Building overview` clears the
  selection and returns to the enclosing building's 3D view (or
  `⌂ Campus overview` when no building is in scope).
- **Two-way synchronization** — clicking a list row selects the object,
  flies the camera to its room/floor/building/roof and opens the details
  drawer; clicking an object in the 3D scene updates the navigator's scope,
  selection highlight and *Selected* summary, scrolling the matching row
  into view.
- **Keyboard** — `/` opens the navigator and focuses search; `Esc` clears
  the search, then closes the panel. Deep links (`#b1f2r2`, …) open with
  the navigator already scoped and synchronized.

## Digital twin scene

The rooftop scene is rendered by `web/scene.js` on a full-bleed canvas using a small perspective camera (yaw, pitch, distance, FOV) with per-panel projected geometry — not a flat schematic. Each of the 48 modules is drawn with a silver frame, glass cell grid and busbars, panel thickness, mounting rails and legs, projected shadows, and a live power tag. The scene also renders the inverter with its live AC-output screen, PV 1/PV 2 cable runs with animated flow, rooftop atmosphere, and per-panel fault treatments (amber underperforming, red faulted/offline, hot-spot glow, warning badge).

Hover a panel or the inverter for live telemetry, click for the inspection drawer, scroll to zoom at the cursor, and drag to pan. The rail home button and zoom controls reset the camera. The surrounding dashboard uses the same dark glass cards, frosted alert card, performance donut, and production dock.

## Performance and usability

By default the twin is Canvas 2D, so "geometry" here means projected
screen paths and "materials" means cached brushes and gradients keyed by
rounded coordinates (the opt-in `?render=gl` prototype adds a WebGL path
with its own budget notes; see above). The same budget rules apply:

- **Low, fixed polygon counts.** Each PV module is one 4-point quad plus
  a fixed cell grid and busbars; no per-object textures, no meshes, no
  subdivision. Lights, sockets, racks and the elevator are procedural
  paths built from the same `quad()`/`box3()` primitives.
- **Reused materials.** Gradients and CSS variables go through a bounded
  FIFO cache (`PERF.gradientCap = 96`, keyed by tag + rounded
  coordinates). Theme changes and resizes clear it once instead of
  re-creating brushes per object.
- **Reused projections.** Screen-space points are cached per camera
  signature (immutable `{x, y, s, depth}` objects) in a map capped at
  12,000 entries. The cache is bypassed while the camera is interacting,
  so a drag always projects fresh; it is reused again on the settling
  frame.
- **Correct disposal.** `disposeScene()` cancels rAF/timers, aborts the
  single `AbortController` behind every scene listener, and clears hit
  zones, panel geometry, the projection map, the gradient cache, the
  cached 2D context and the perf HUD. A resize after disposal cannot
  restart rendering (covered by the harness).

### Frame scheduler

All scene drawing goes through one dirty/busy/pulse/idle scheduler
(`SCHED` in `web/scene.js`) instead of perpetual `requestAnimationFrame`
loops:

| State | When | Frame rate |
|---|---|---|
| busy | camera drag, zoom, keyframed flight | every rAF (~60 fps) |
| dirty | snapshot/invalidate after a change | one frame |
| pulse | a selection ring, anomaly badge or non-ok status is visible | ~9 fps (110 ms); off in reduced mode |
| idle | nothing to show | **no frames at all** |

Tab-hide stops frames; a hidden tab that is shown again invalidates once.
Hover only redraws when the hover target actually changes. With polling
frozen, the harness measures zero additional draws and zero pending
rAF/timer callbacks while idle.

### Quality modes

The **Effects** select in the HUD (or `perfSetQuality`) offers *Full* and
*Reduced*; the choice persists in `localStorage` under `efi.effects`.
Reduced mode:

- caps device pixel ratio at **1.1** (vs 1.75) — fewer backing-store pixels;
- skips `shadowBlur` on every glow (`perfShadow`) and disables pulsing;
- keeps the scene static between data changes.

The platform **auto-reduces** — without persisting — when the user prefers
reduced motion, when the browser reports data-saver mode, or on very small
devices (`navigator.deviceMemory <= 2` GB or `hardwareConcurrency <= 2`).
The reason is shown in the HUD via `?perf=1`.

### Network resilience and loading failures

`web/net.js` wraps every API call in `AbortController` with a hard
timeout (8 s; 20 s for the optional AI call). Deliberate aborts are
distinguished from timeouts, all in-flight requests are aborted on
`pagehide`, and `net-state` events drive a connection banner. A failed
poll keeps the **last good snapshot** on screen, shows its age, and
retries with exponential backoff (a 1 s base plus a failure delay that
doubles from 2 s up to 16 s), paused while the tab is hidden. A failed
device refresh leaves the open drawer intact.

If `getContext("2d")` fails or returns null, or the render loop throws
three times, the scene pauses and switches to the equipment-list fallback
(the same circuit breaker logs the first error only, to avoid console
spam).

### Equipment-list fallback

When Canvas 2D is unavailable, rendering fails, or the user picks
**List** in the HUD, the scene is replaced by a DOM equipment list
(`web/fallback.js`): grouped `<details>` sections for Rooftop PV and each
building → floor → room, with live kW, status and anomaly counts. Rows
open the same inspector drawer, and values are patched in place on each
poll rather than rebuilding the list, so selection and scroll position
survive. The choice persists as `efi.view` (`scene` / `list`); an
automatic fallback is not persisted on reload, and the HUD's **3D**
button stays disabled when Canvas 2D itself is unavailable.

### Keyboard and pointer selection

Selection is fully operable without a mouse:

| Action | Keys |
|---|---|
| Enter the scene | `Tab` to the canvas (visible focus ring) |
| Move selection | `←` `→` `↑` `↓` (roving over the visible objects) |
| First / last object | `Home` / `End` |
| Activate (device drawer / open level) | `Enter` or `Space` |
| Clear selection | `Esc` |
| Building navigator search | `/` |
| Visualization modes | `1`–`6` |
| Exploded floors | `E` |
| Alarm center | `A` |
| Keyboard help | `?` |

Each move is announced in the `#sr-status` live region ("Scene focus:
Solar panel P-04, 49 of 99. Press Enter to open."), the focus ring is
drawn in the scene,
activating a device moves focus into the drawer and `Esc` returns it to
the canvas, and a skip link jumps past the rail. The help dialog traps
focus and restores it on close. On coarse pointers, hit targets are
enlarged to a 44 px minimum.

### Tablet and small screens

The scene backing store follows its CSS box (`max(320, round(rect))`),
so it renders correctly from phones to tablets instead of being forced
to a desktop size. Pointer/touch coordinates are scaled from CSS to
backing pixels, which keeps taps aligned with their panels. A dedicated
tablet band (761–1024 CSS px) tightens the rail and drawer, and the HUD
toggles stay above the fallback list on every breakpoint. The harness
checks 820×1180 (DSF 2) and 1024×768 for no horizontal overflow,
panel hit-test alignment and correct device selection.

### Verified

Run against a live local server (headless Edge, throttled camera and
polling frozen where needed):

- Idle: 0 draws / 0 frames over 1.5 s; draw cost ~1–3 ms (EMA < 40 ms).
- Repeat draws: +333 projection-cache hits, cache pinned at 96 gradients;
  projection map 213 / 12,000.
- Camera flight: 47–52 draws over ~1.19 s, then 0 after settling.
- Selection pulse: ~9 draws/s; 0 after the selection closes.
- Outage: banner with snapshot age, snapshot kept by identity, recovery;
  startup failure recovers and renders KPIs.
- Fallback: 97 equipment rows, no scene draws while shown, in-place
  patching, persistence across reload.
- Reduced motion emulation: reduced quality, DPR ≤ 1.1, static scene.
- Keyboard, focus return, help trap and tablet taps: all pass.

### New modules

| File | Responsibility |
|---|---|
| `web/perf.js` | quality modes, DPR cap, bounded gradient cache, HUD, disposal |
| `web/net.js` | abortable fetch, timeouts, `net-state` events, pagehide cleanup |
| `web/keyboard.js` | canvas roving selection, announcements, help dialog, shortcuts |
| `web/fallback.js` | equipment-list fallback, capability detection, in-place updates |

`web/scene.js`, `web/app.js`, `web/style.css`, `web/index.html` and
`server.py` were extended accordingly (scheduler, projection cache,
context-loss handling, polling state machine, fallback styles and routes).

## Architecture

```text
Digital Twin
   |
   +--> Expected vs Actual Telemetry
              |
              +--> Equipment Anomaly Detector
              |
              +--> Sensor Dataset Bridge
                       |
                       +--> classify_row()  <-- single source of truth
              |
              v
         AI Diagnostic Agent
              |
              v
     Energy Intelligence Engine
       |       |       |       |
       v       v       v       v
    Health   Waste    Cost    CO2
     Score   Impact   Impact  Impact
       |       |       |
       +-------+-------+
               |
               v
        Priority + Recommendations
               |
               v
           Dashboard
               |
               v
        SQLite history/reports
```

## Repository layout

```text
energy-platform/
├── server.py
├── sim/
│   ├── engine.py
│   └── faults.py
├── ai/
│   ├── anomaly.py
│   └── agent.py
├── dataset/
│   ├── sensor_data.csv
│   ├── sensor_simulator.py
│   ├── adapter.py
│   ├── sensor_faults.py
│   ├── validate.py
│   └── README.md
├── intelligence/
│   ├── engine.py
│   ├── metrics.py
│   ├── scoring.py
│   ├── recommendations.py
│   ├── reports.py
│   └── persistence.py
├── equipment/
│   ├── model.py
│   ├── store.py
│   ├── migrations.py
│   ├── calculations.py
│   └── playback.py
├── tests/
│   ├── test_dataset_bridge_fixed.py
│   ├── test_intelligence.py
│   ├── test_panels.py
│   ├── test_buildings.py
│   ├── test_equipment.py
│   ├── test_alarms.py
│   ├── test_calculations.py
│   └── test_playback.py
└── web/
    ├── index.html
    ├── app.js
    ├── building.js
    ├── scene.js
    ├── perf.js
    ├── net.js
    ├── keyboard.js
    ├── fallback.js
    ├── navigator.js
    ├── alarms.js
    ├── viz.js
    ├── playback.js
    ├── style.css
    ├── energy-intelligence.js
    └── energy-intelligence.css
```

## Sensor dataset bridge

Ali's 1,000-row PV sensor dataset contains labeled faults including voltage bias, drift, dropout, stuck sensor, noise, panel/inverter overheating, power loss and grid-voltage anomalies.

The adapter converts the dataset's **watts to kW** before passing readings into the platform. Missing measured power remains `None`; it is never replaced with the healthy value.

`dataset/adapter.py` calls `dataset.sensor_faults.classify_row()` directly. There is therefore one source of truth for sensor classification.

Validate the real bridge:

```bash
python -m dataset.validate
python dataset/validate.py
```

The validation path is:

```text
CSV row
  -> classify_row()
  -> adapter
  -> device-shaped telemetry
  -> diagnose()
  -> primary_fault
  -> ground-truth comparison
```

This is intentionally different from a classifier-only accuracy test.

## Equipment data model

Every metered object — aggregate plant, PV module, room lighting/plug
circuit, fan-coil, elevator, UPS, EV charger, water heater — is described by
one canonical model in `equipment/` and persisted in the shared SQLite
database (`data/energy_intelligence.db`).

| Field | Where |
|---|---|
| stable id | `equipment.id` (primary key, never reused) |
| name, category | `equipment.name`, `equipment.category` (+ human label) |
| parent building / floor / room ids | `equipment.building_id/floor_id/room_id` |
| rated power (kW) | `equipment.rated_kw` |
| data source | `equipment.source` — `live`, `imported` or `simulated` (CHECK) |
| equipment-specific fields | `equipment.attributes` (JSON: panel row/col, FCU floor share, battery %, tank size, …) |
| measurement timestamp | `equipment_measurements.measured_at` (sim absolute minutes) + `measured_day`/`measured_time` |
| operating status | `equipment_measurements.status` — `ok`/`warning`/`serious`/`critical` (CHECK) |
| operating hours | `equipment_measurements.operating_hours` (cumulative runtime) |
| energy consumption (kWh) | `equipment_measurements.energy_today_kwh` (since sim midnight) |
| optional sensor readings | `equipment_measurements.sensors` (JSON: voltage, current, cell temp, duty, …) |
| anomalies | `equipment_anomalies` rows keyed by `(equipment_id, event_key)` |

**No duplicate or contradictory measurements.** The measurement table has
`PRIMARY KEY (equipment_id, measured_at)`: every write is an UPSERT, so the
same reading is never stored twice and a corrected value replaces the old
one in place. Sensor readings live once, in the measurement row. Anomalies
use the same in-place rule (`event_key`) and close with a `closed_at`
timestamp; a simulation reset starts a new anomaly epoch, closing the
previous run's open records instead of overwriting their history.

**Migrations.** `equipment/migrations.py` owns the schema for the whole
database (energy-intelligence snapshots + equipment tables). Migrations are
append-only and idempotent; applied versions are recorded in
`schema_migrations`, and a pre-migration database (only
`intelligence_snapshots`) is adopted without data loss. Schema version is
reported by `GET /api/equipment` → `stats.schema_version`.

**Sources.** Simulation samples are written every 10 real seconds (sim
timestamps; UPSERT makes paused runs idempotent). Live/imported readings
enter through `EquipmentStore.import_measurement(...)` — same canonical
row, `source` recorded per measurement.

### Equipment API

| Endpoint | Purpose |
|---|---|
| `GET /api/equipment` | Registry + latest canonical measurement per equipment, with `stats` |
| `GET /api/equipment?building=b1&floor=b1f2&room=b1f2r2&category=fcu&source=simulated` | Filtered registry |
| `GET /api/equipment/<id>` | Equipment detail: latest measurement, history, anomaly records |

```json
{
  "id": "ups-b1",
  "name": "Server UPS",
  "category": "server_ups",
  "parent": { "building": "b1", "floor": "b1f2", "room": "b1f2r2" },
  "rated_kw": 6.0,
  "source": "simulated",
  "attributes": { "serves": "server room", "battery_pct": 100 },
  "latest": {
    "measured_at": 7560, "measured_day": 6, "measured_time": "06:00",
    "actual_kw": 3.72, "expected_kw": 4.6,
    "energy_today_kwh": 25.1, "operating_hours": 120.0,
    "status": "ok", "source": "simulated",
    "sensors": { "battery": 100.0, "load_pct": 62.0 }
  },
  "active_anomalies": 0
}
```

The device drawer in the UI shows the same fields under **Metering**
(simulated consumption, operating hours, data source, last measurement).

## Energy calculations

All energy arithmetic lives in `equipment/calculations.py` as documented pure
functions with one unit system:

| Quantity | Unit | Meaning |
|---|---|---|
| `rated_power_kw` | kW | nameplate capacity from the equipment registry — **not** a consumption |
| `measured_power_kw` | kW | one instantaneous sensor/meter reading (in this prototype the twin's virtual sensor) |
| `simulated_energy_kwh` | kWh | energy integrated by the simulation engine's own counter — a simulation output, **not** a meter register |
| `calculated_energy_kwh` | kWh | energy derived from measured power with the formulas below — always an **estimate** |

Every calculation result carries `basis: "calculated"`, its method, formula,
window, sample count, thresholds and a note; the UI and API never label a
calculated estimate as measured consumption.

**Constant power** (`E = P × t`, kW × h = kWh) is used when the measured
series is approximately constant:

```
(max(P) − min(P)) / mean(P) ≤ 0.10
```

The operating time `t` is the covered measurement-window duration in hours.

**Variable power** is integrated over the measured timestamps (trapezoidal
rule):

```
E = Σ ((P_i + P_i+1) / 2) × (t_i+1 − t_i) / 60
```

Simulation timestamps are absolute minutes, so `Δt / 60` converts to hours.
Intervals longer than the data-support gap are skipped; fewer than two usable
samples (or no usable interval) yields `status != "ok"` and `energy_kwh:
null`, which the inspector renders as an empty state rather than inventing a
number.

**Scenario configuration.** For `source = "simulated"` equipment users can
configure a rated power, daily operating hours, a load factor and the hour of
day at which the operating window starts:

```
E_scenario = rated_power_kw × load_factor × operating_hours   (kWh/day)
monthly    = E_scenario × 30
```

`load_factor` (0–1) is the average fraction of nameplate power actually drawn;
`1` reproduces the original Step 7 formula and reports formula `E = P × t`,
otherwise `E = P × t × LF`. The optional window start (0–24 h) places the
operating hours inside the day (`schedule_label`, e.g. `09:00–13:00`); it does
not change the daily total, but it determines how much of the schedule falls
inside a baseline window during comparison.

The configuration is stored in `equipment_scenarios` (migration v3, extended
with `load_factor` / `schedule_start` in migration v4) and is rejected for
live/imported equipment: scenario assumptions must not be presented as
measured data. The inspector shows all four inputs, a live
`E = P × LF × t` preview, the configured window and the calculated
daily/monthly estimate, clearly tagged as a scenario. Invalid values (hours or
start outside the day, window end past midnight, load factor outside 0–1) are
refused client- and server-side without disturbing a saved configuration.

**Baseline vs scenario comparison.** When a scenario is configured, the
inspector compares it with the calculated baseline for the most recent 24 h of
measurement. Both figures cover the **same window**: only the portion of the
configured schedule that overlaps the baseline window contributes, and the
scenario runtime is capped by the baseline's covered hours so a gap in the
data cannot inflate either side. The result reports
`basis: "calculated_comparison"`, the covered/scheduled hours, the scenario
kWh, the delta and direction, and states that both figures are estimates, not
metered consumption. The UI renders two labelled bars (baseline blue,
scenario amber), the delta and the same caveat.

### Calculation API

| Endpoint | Purpose |
|---|---|
| `POST /api/equipment/<id>/scenario` | Save `{ "rated_kw": 6.0, "operating_hours": 8, "load_factor": 0.5, "schedule_start": 9 }` for simulated equipment |
| `POST /api/equipment/<id>/scenario` with `{ "clear": true }` | Remove the scenario configuration |
| `POST /api/energy/calculate` | Pure calculation: `{ "rated_kw": 6.0, "operating_hours": 8, "load_factor": 0.5, "schedule_start": 9 }` → daily/monthly scenario energy |
| `GET /api/device/<id>` | Inspector data, including the `energy` block (rated / measured / simulated / calculated, saved scenario and same-window comparison) |
| `GET /api/playback?bucket=60&day=N` | Calculated historical energy per space for one simulation day (see below) |

The `energy` block is source-aware: simulated equipment is calculated from the
twin's tick-cadence measured-power series and reports the engine's integrated
counter as `simulated_energy_kwh`; live/imported equipment is calculated from
canonical persisted measurements and never reports the simulation counter.

### Individual equipment inspector

Clicking any equipment object in the 3D scene opens the inspector, which
shows, top to bottom:

- **Name and type** — header plus the category label (e.g. "Server UPS"),
  with a **measurement-source chip** (`SIMULATED` / `LIVE` / `IMPORTED`).
- **Simulation mode banner** — simulated equipment is explicitly labelled:
  "Readings are produced by the digital-twin model, not live sensor
  hardware."
- **Current status** — detector state, live power, expected model value and
  rated power.
- **Sensor readings** — equipment-specific telemetry (voltage, current,
  cell temperature, duty, battery, tank temperature, …) or an empty state.
- **Metering** — simulated consumption (kWh), operating hours, measurement
  source, last measurement timestamp and **data freshness** (`live · just
  now`, `paused · 3m ago`).
- **Energy calculations** — the four quantities side by side with provenance
  tags: rated power (nameplate), measured power (source + timestamp),
  simulated consumption (simulation counter), calculated estimate (method,
  formula and window), plus the configured scenario estimate. A note states
  that calculated estimates are derived, not metered.
- **Scenario configuration** — for simulated equipment: rated power (kW),
  operating hours (h/day), load factor (0–1) and window start (hour) inputs
  with a live `E = P × LF × t` daily/monthly preview, the configured window,
  and Save/Clear. Live/imported equipment shows that scenario configuration
  is simulated-only.
- **Baseline vs scenario** — same-window bars comparing the calculated
  baseline with the configured scenario, plus the delta, scheduled/covered
  hours and a "not metered" caveat. It appears only when a scenario is saved
  and the baseline calculation has sufficient data.
- **Recent alerts** — anomaly records for this equipment with severity,
  timestamp and active/resolved state; "No alerts recorded for this
  equipment." when there are none.
- **Diagnostics** — expected model, measured residual, detector state and
  the active anomaly.
- **Virtual fault injection** — the same fault catalog as everywhere else.
- **Historical consumption chart** — actual vs expected power from the live
  twin history (labelled "Generation history" for PV equipment).
- **Simulated consumption chart** — cumulative energy from the persisted
  equipment measurements (labelled "Energy" for live/imported equipment).
- **AI diagnosis** — rule-based or Claude-enriched causes and actions.

**Missing data is never fabricated.** Null readings render as `—`; when
there are no persisted measurements the energy chart shows "No persisted
measurements yet for this equipment.", when history is still accumulating
it says "Energy history builds as measurements are recorded (one sample
every 10 s).", and a missing power history shows "No measurements yet —
history appears after the first few ticks." Data freshness also reports
`paused · …` while the simulation is paused.

## Visualization modes

The twin has a mode selector (top-left of the scene) and a legend that
always explains the active encoding:

| Mode | Encodes | Aggregation |
|---|---|---|
| **Status** | detector state per device (✓ Normal, ▲ Warning, ● Serious, ✕ Critical) | space = worst severity among its devices |
| **Energy** | consumption intensity: devices in kWh today, spaces in kWh/m² today | room = its devices; floor = rooms + FCU; building = unique devices |
| **Alerts** | only *abnormal* equipment (sustained deviation from its expected model) | space severity = worst active anomaly |
| **Health** | diagnostic health bands (Good ≥ 85 … Critical < 40) | space = mean health of its devices (each counts once) |
| **Data** | measurement source per device (live / imported / simulated), stale (> 30 s) and no-data states | space = worst availability among its devices |
| **Heatmap** | calculated energy intensity per space (kWh/m²) for the live day or a scrubbed 60-min playback bucket | room = its devices; floor = rooms + FCU; building = unique devices; no-coverage buckets are neutral, never zero |

**Aggregation rules are computed once on the server** (`sim/engine.py`:
`energy_today_kwh` and `area` on every room, floor and building) and reused
by the UI, so every mode agrees:

- a room sums only the devices that live in it,
- a floor sums its rooms plus its own FCU,
- a building sums the **unique** set of devices (rooms + FCU + building
  equipment), so room-hosted devices (UPS, water heater) count once,
- the campus is the sum of its buildings; the roll-up plant devices
  (HVAC plant, lighting, plug loads, building systems) are **never added**
  to these sums — they are derived aggregates of the leaves. A test
  asserts the campus energy equals the sum of leaf energy exactly.

**High consumption ≠ fault.** The energy mode visualizes intensity only;
faults come from the expected-vs-actual model (alerts/health). A
high-consuming but healthy device is never colored as abnormal — verified
in the browser checks.

### Historical energy playback and heatmaps

Selecting **Heatmap** reveals a playback strip under the mode buttons:
play/pause, a 24-step slider (one step per 60-minute bucket of the selected
simulation day), a **Live** button, the current time label and a provenance
line. Scrubbing switches the scene from live today totals to the selected
bucket; each room floor, floor chip and building chip shows its calculated
energy and intensity for that bucket. **Live** returns to the accumulating
today totals, with the slider following the current simulation hour.

The strip is backed by `GET /api/playback?bucket=60&day=N` (bucket 5–1440
minutes, day defaults to the current simulation day). `equipment/playback.py`
builds one series per room, floor and building by summing its unique member
devices and integrating their simulated power series with the documented
trapezoidal rule, splitting intervals at bucket boundaries:

```
E_bucket = Σ ((P_i + P_i+1) / 2) × Δt / 60
```

Values are calculated from simulated history — the payload says so
(`basis: "calculated"`, `power_source: "simulated_history"`) and the UI
labels it "calculated, not metered". A bucket with no covered interval has
`energy_kwh: null` and renders as a neutral space with a "no data" chip, not
a fabricated zero or a misleading cold colour. Coverage and covered minutes
travel with every value so partial buckets are distinguishable.

Heatmap colours use the same single-hue amber ramp as the energy mode, scaled
by the **day-wide maximum intensity** (`max_intensity_kwh_m2`) so a bucket's
colour does not rescale while scrubbing; the legend reports kWh/m², the active
bucket and its time. High intensity is not a fault here either.

### Anomaly highlighting

Active anomalies propagate visibly through the whole hierarchy rather than
only the faulted device:

- the floor, building and rooftop labels show a pulsing **⚠ count** badge,
  and tooltips/level cards state the anomaly count;
- **Alerts** mode colours exactly the abnormal spaces and devices (worst
  severity wins) and its legend names the expected-model source;
- the building navigator adds an **anomalies only** filter, composes it with
  type/status/search, and marks affected rows with ⚠;
- `anomalyHighlights()` exposes the affected building/floor/room list for
  inspection and tests.

Injection and recovery come from the normal detector, so the scene, level
cards, navigator and inspector agree on the same active anomaly set. A device
without an anomaly is never highlighted just because it consumes a lot.

**Colors.** Palettes were validated with the data-viz palette validator
against the dark stage surface: the energy mode uses a single-hue amber
sequential ramp (monotone lightness, every step ≥ 2.5:1 contrast), the
data mode uses three categorical hues that pass all-pairs CVD separation
plus neutral grey for “no data”, and status/alerts/health use the reserved
status palette with a glyph and text label in every legend entry (never
color alone). Intensity dots are drawn beside device glyphs; room floors,
floor and building chips carry the space-level encoding.

## Alarm and event management

Every anomaly the detector raises is persisted, so alarms can be worked as a
lifecycle rather than scrolling out of a transient feed:

| State | Meaning |
|---|---|
| **Open** | condition active; no operator has taken it yet |
| **Acknowledged** | an operator owns it; the condition is still active |
| **Recovered** | the detector cleared the condition; the record awaits close-out |
| **Resolved** | an operator closed the record after recovery, optionally with a note |

Rules enforced by the server, not just the UI:

- **Resolve is refused while the condition is still active** (HTTP 409), so a
  live abnormal device cannot be hidden behind a "done" record.
- Acknowledge and resolve are idempotent and record the operator name plus UTC
  wall-clock time; the resolution note is trimmed and capped at 500 characters.
- The panel polls every 5 s, pauses while a resolution note is being edited,
  and announces a condition that clears while it is open ("waiting for
  close-out in the Recovered view").
- The **active** view is the live queue (open + acknowledged). Records that
  recovered without being resolved stay in the **Recovered** view until an
  operator closes them out.
- Rows are derived from persisted simulated anomalies, labelled **SIMULATED**,
  and the panel states that no physical devices are connected.

Open the **alarm center** with the **Manage** button on the floating alerts
card, with the `A` shortcut, or — on phones, where the floating card is hidden
— with the left-rail Alerts button (it opens as a bottom sheet). Status chips
carry full-table counts; severity and building filters compose with them.
Selecting a device name jumps to the normal equipment inspector.

### Alarm API

| Endpoint | Purpose |
|---|---|
| `GET /api/alarms` | Records + counts + filters (`status=active\|open\|acknowledged\|recovered\|resolved\|all`, `severity`, `building`, `limit`) |
| `POST /api/alarms/acknowledge` | `{equipment_id, event_key, operator}` |
| `POST /api/alarms/resolve` | `{equipment_id, event_key, operator, note}`; HTTP 409 while active |

## Energy Intelligence API

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | Digital twin snapshot + current intelligence |
| `GET /api/intelligence` | Current health, waste, priorities and recommendations |
| `GET /api/intelligence/report` | Daily operator report |
| `GET /api/intelligence/history` | Recent persisted intelligence snapshots |
| `GET /api/equipment` | Equipment data model (registry + latest measurements) |
| `POST /api/equipment/<id>/scenario` | Save/clear a simulated scenario (rating, hours, load factor, window start) |
| `POST /api/energy/calculate` | Documented constant-power scenario calculation |
| `POST /api/intelligence/scenario` | Estimate savings from fixing a device/fault |
| `GET /api/alarms` | Alarm lifecycle records, counts and filters |
| `POST /api/alarms/acknowledge` | Acknowledge an active alarm |
| `POST /api/alarms/resolve` | Resolve a recovered alarm with an optional note |
| `POST /api/ai/diagnose` | AI diagnosis for a device |
| `POST /api/fault` | Inject/clear virtual faults |
| `POST /api/control` | Simulation controls |

Scenario example:

```json
{
  "device_id": "hvac",
  "reduction_pct": 100,
  "hours": 8
}
```

The response estimates daily/monthly kWh saved, cost saved and CO2 avoided.

## Health score

The Energy Health Score combines:

- 30% energy efficiency
- 25% equipment health
- 20% renewable utilization
- 15% grid independence
- 10% sensor health

Sensor health is kept separate from equipment health so a bad sensor does not automatically trigger unnecessary equipment maintenance.

## Persistence

The intelligence layer and the equipment data model share one SQLite
database (schema managed by `equipment/migrations.py`):

```text
data/energy_intelligence.db
```

This file is runtime state and should not be committed. Set
`ENERGY_DB_PATH` to use another location (useful for tests or deployments):

```bash
ENERGY_DB_PATH=/tmp/energy.db python server.py
```

Schema version 5 adds the operator-workflow columns to
`equipment_anomalies` (`acknowledged_at/by`, `resolved_at/by`,
`resolution_note`). The detector keeps ownership of `active`, `opened_at` and
`closed_at`, so operator actions cannot mask a live condition. When the
detector reports an already-closed record active again (the same event id
reappearing after it dropped out of the snapshot), the stale operator
close-out (`acknowledged_*`, `resolved_*`, `resolution_note`) is cleared so
the live condition returns to the Active view as `open`; routine refreshes of
a still-active alarm keep their acknowledgement. Migrations are append-only
and idempotent; existing databases upgrade in place.

## Tests

Run:

```bash
python -m unittest discover -s tests -v
```

The important regression is the end-to-end dataset test: a sensor fault must survive the adapter and be named by `diagnose()`.

The UI was also exercised through headless-browser acceptance runs
(puppeteer-core against a temporary server): 96 Python tests (including 8
alarm-lifecycle tests), 51 scene / navigation checks for the interactive
building, 78 performance and usability checks, 37 Step 11 acceptance checks
(floor/room/equipment selection, scene↔list navigation, units, aggregation
without double-counting, simulated vs measured provenance, and missing-data
empty states), and 21 alarm-center checks (fault → open → acknowledge →
recovery → resolve with note, filters and counts, device jump, keyboard and
phone entry points, no page errors) — all passing, along with the end-to-end
walkthrough, navigator, energy-calculation, visualization, layout and
inspector regressions.

## Phase 2 — Application shell & routing

The app gained an enterprise frame (top bar, breadcrumb, page header, sidebar
navigation, status pill) with a hash router that owns both new and legacy
destinations. `shell.js` / `shell.css` move the existing rail, stage and
below-fold sections into shell hosts at runtime — IDs and handlers are
unchanged, so the dashboard, twin, navigator, inspector, alarm center and
intelligence modules were not rewritten.

Routes: `#/overview`, `#/twin/campus|building/:id|floor/:id|room/:id|roof/:id`,
`#/assets(/:deviceId)`, `#/analytics/production|consumption|heatmap`,
`#/alarms`, `#/intelligence`, `#/settings`. Legacy hashes (`#campus`, `#roof`,
`#b1`, `#b1f2`, `#b1f2r2`) resolve to the new twin routes. Unknown routes show
a 404 page. The WebGL renderer is the default (lazy-loading
`camera-controls.js` and `twin3d.js`); `?render=canvas` opts out to the
legacy Canvas renderer.

### Verified (2026-10-22, isolated copy, port 8019)

- **87/87 headless-browser acceptance checks** (puppeteer-core / Edge against
  a temporary server with a temporary database): boot & shell construction,
  all declared routes (title / breadcrumb / active-nav / view sync), unknown
  routes, legacy alias resolution, direct hash loads, browser back/forward,
  sidebar toggle / scrim / Escape / nav-click behavior, alarm-center +
  navigator + sim-pop + keyboard entry-point compatibility, WebGL-default
  and legacy-Canvas (`?render=canvas`) renderer paths, responsive layouts at
  1440/1280/1024/768/390 px (no horizontal overflow, usable navigation), and
  keyboard focus visibility — with zero page errors.
- JavaScript syntax checks (`node --check`) pass for all shell-era files.
- The existing Python suite passes unchanged (temporary database).

Known limitations: all four page destinations were completed in Phase 4
(Assets, Alarms, Analytics, Settings). Alarm-center and intelligence data
remain simulated (see provenance notes above).

## Phase 3 — UI integration & responsive layout

The scene routes now fit the legacy workspace to the shell viewport
(`shell.css`, scoped to `.app-shell`): on tall desktop displays the production
dock and every dashboard card sit above the fold with no scrolling, and at
short viewport heights the approved 960 px scroll layout is kept with the
left card stack and repair card repositioned so nothing overlaps the taller
dock. The scene-routes page header is compact (the stage top bar already
carries the scene title and KPI); other routes keep the full header.

The Overview page now shows the Energy Intelligence panel below the scene, so
health, priorities and recommendations are discoverable without leaving the
dashboard. The `#/intelligence` route is the module's own page: the stale
compatibility banner was replaced by a data-provenance note, and the page
badge marks the figures as `SIMULATED · calculated estimates` (nothing here
is metered or measured from physical equipment).

The approved 3D geometry, room/equipment interactions, camera controls and
both renderer paths were not changed; the scene re-projects when the stage is
resized, and scene clicks still navigate (verified below).

### Verified (2026-10-22, isolated copy, port 8019)

- **32/32 Phase 3 headless-browser checks**: no card overlaps and no
  horizontal overflow at 1440×900, 1280×800, 1024×768, 768×1024 and 390×844;
  production dock above the fold at 1440×900/768×1024/390×844; intelligence
  panel visible below the overview scene; provenance panel + simulated badge
  on the intelligence route; alarm center fits the phone viewport and closes
  with Escape; assets navigator and device drawer usable at phone size; scene
  click navigation and the WebGL (`?render=gl`) camera path intact; zero page
  errors.
- **87/87 Phase 2 acceptance checks** still pass after the Phase 3 changes
  (one check updated to expect the new provenance panel instead of the
  removed compatibility banner).
- The existing Python suite passes unchanged (temporary database).

Known limitations: at viewport heights ≤ 879 px the scene keeps its scroll
layout, so the production dock sits below the fold (reachable by scrolling —
the original full-bleed design). The value card is hidden on scene routes at
viewport heights 880–993 px because its cost/CO₂ figures are duplicated by
the Energy Intelligence panel now visible on the same page. The device
drawer remains the shared inspector overlay (used by the Assets and Alarms
pages); it has no separate page-level rebuild scheduled.

## Phase 4 — Page-level destinations

### Assets & Equipment (done)

The `#/assets` route is now a real page: the existing building navigator
fills the stage as the full equipment table (99 registry rows at campus
scope), with search, type / status / **source** filters (the source filter
was added to `navigator.js` and the filter bar), building/floor/room scope
selectors and floor pills that drive the 3D scene, live kW values patched in
place, and row clicks opening the existing device drawer (hash syncs to
`#/assets/<id>`). The page badge marks the registry as
`SIMULATED · equipment registry`; the source filter honestly reports empty
states for live/imported data (none exists in this environment). The
floating compact navigator on the twin route is unchanged; on the assets
page the panel's close button is hidden and Escape no longer empties the
page.

### Verified (2026-10-22, isolated copy, port 8019)

- **32/32 Assets-page headless-browser checks**: page layout (full-width
  table, no compat banner, SIMULATED badge), 99-row registry with live kW
  values, search + honest empty states, type/status/source filters, scope
  navigation (building → floor → room → overview), row → drawer + hash
  sync, Escape guard, floating navigator unchanged on the twin route, zero
  console/network errors.
- Regression ladder: Phase 2 **88/88**, Phase 3 **32/32** (the mobile
  navigator needed `position: absolute` in page mode because the floating
  panel is viewport-fixed at ≤760 px), WebGL-default **19/19**, Python
  suite unchanged.

### Alarms (done)

The `#/alarms` route is now a real page: the existing alarm center becomes
the page's main content (fills the stage; on every other route it remains
the fixed overlay). The full lifecycle is unchanged — open → acknowledge →
recover → resolve with note, server-side refusal to resolve a live
condition, status chips with full-table counts, severity/building filters,
operator persistence, 5 s polling, device jump to the shared drawer — plus
the page keeps its built-in provenance note ("simulated sensor anomalies…
no physical devices are connected") and the `SIMULATED alarms` badge.

Behavior notes: on the Alarms page the center cannot be closed into an
empty page — `A`, Escape and every closer keep it open (the state stays
consistent so leaving the route still closes the overlay); the ✕ button is
hidden on the page. On other routes `A` and Escape keep their original
overlay toggle behavior, and the rail Alerts button navigates to the page.

### Verified (2026-10-22, isolated copy, port 8019)

- **29/29 Alarms-page headless-browser checks**: page layout (no compat
  banner, SIMULATED badge, provenance note, chips with counts), the full
  lifecycle driven by a real fault on the paused sim (fault → open →
  acknowledge → resolve refused while active → clear → recovered →
  resolve with note → resolved view), severity filter, `A`/Escape guards on
  the page, unchanged overlay behavior on the twin route, rail navigation,
  device jump with the page staying behind the drawer, phone layout within
  the stage with no overflow, zero console/network errors.
- Regression ladder: Assets **32/32**, Phase 2 **88/88**, Phase 3 **32/32**
  (two phone checks updated to the intentional page semantics: ✕ hidden,
  Escape keeps the page), WebGL-default **19/19**, Python suite unchanged.

### Analytics (done)

The `#/analytics/{production,consumption,heatmap}` destinations are now a
real page: the approved live scene, production dock and heatmap stay
exactly as they were, and a structured summary section renders below the
scene. Every displayed value comes from the existing `/api/state` KPIs
(solar/load/grid import-export, today/yesterday energy, self-sufficiency,
anomalies), the per-building snapshot table, and `/api/playback`
(consumption by building + the day timeline). The page honestly reports the
paused state ("Simulation paused at Day N · HH:MM — today's totals cover
the elapsed simulated hours; buckets after the current hour have no data")
and marks everything as calculated from simulated history, not metered.
Playback failure shows an explicit unavailable state and recovers
automatically. Tab clicks navigate the route (`production` / `consumption` /
`heatmap`); the heatmap tab keeps activating the scene heatmap mode.

### Settings (done)

The `#/settings` route is a real page hosting the existing controls: the
simulation group (speed, weather, pause/resume, reset), the display group
(theme, visual-effects quality) and the operator name. Every page control
mirrors the existing element and re-dispatches its event, so the original
handlers (`postControl`, theme rebuild, `perfSetQuality`, operator
persistence) remain the single source of truth. The page states clearly
which controls affect the shared simulated state, shows the live
paused/running status, and notes persistence honestly: effects quality and
the operator name persist on this device; the theme does not persist across
reloads. Reset clears all faults and alerts and restarts the simulation
(the existing confirmation dialog is preserved).

### Verified (2026-10-23, isolated copy, port 8019)

- **33/33 Analytics-page checks**: banner removed, every KPI and table cell
  compared against the live API responses, tab routing, honest
  paused/no-data presentation, playback failure + recovery (page-local
  stub), scene click + heatmap mode intact, phone layout without overflow,
  zero console/network errors.
- **30/30 Settings-page checks**: banner removed, speed/weather applied and
  restored (sim stayed paused), pause/resume and reset wiring verified with
  page-local test doubles (no resume or reset was ever sent), theme toggle
  + non-persistence, effects quality applied + persisted + restored,
  operator persistence, no side effects on the twin route, phone layout,
  zero console/network errors. The simulation remained paused (Day 265 ·
  11:00) throughout.
- Full regression ladder re-run after Phase 4 completion (see below).

## Phase 5 — Battery storage & sensor-fault layer

The campus gains **battery storage** (40 kW / 120 kWh, `battery` device,
kind `battery_storage`): it charges from solar surplus and discharges to
cover load within the 10%..95% state-of-charge window. `expected` is the
healthy schedule and `actual` the signed flow (+charging/−discharging);
faults `reduced_capacity` (60% cap) and `charge_fault` (no charging) are
detected like any deviation. The snapshot exposes `kpis.storage_kw` /
`soc_pct` and today/yesterday charge/discharge kWh; the device appears in
the equipment registry, the navigator, the inspector (with SoC, capacity
and both flow directions) and the Analytics production tab. Existing
`net_kw`/import/export semantics are unchanged — storage is reported
separately.

The **sensor-fault layer** adds `sensor_drift` (+35% measurement bias) and
`sensor_stuck` (frozen reading) to the fault catalog for every device kind,
tagged `layer: "sensor"`. Sensor faults distort the *measurement only* —
the equipment may be healthy; aggregates remain honest sums; the detector
flags the deviation and the AI agent names it a sensor fault (the drawer
labels these rows `SENSOR FAULT · measurement only`).

## Phase 6 — Fleet monitoring & simulated MQTT

The new `#/fleet` page monitors the whole portfolio: one card per site —
Tower A / Annex B (simulated twin), **Warehouse 12** (imported dataset
feed, `sim/fleet.py`) and **Office 3** (fed by the **simulated MQTT
integration**: an in-process mock broker + publisher in `iot/`, ingested
through the canonical `equipment_store.import_measurement` entry point with
`source='live'`). Site cards show device counts, total load, source and
sample freshness; selecting a site lists its equipment with latest readings.
All feeds are explicitly simulated: every MQTT message carries
`"simulated": true` and a "no real broker or hardware" note, the adapter
refuses non-simulated messages, and external sites have no 3D twin. The
fleet and MQTT loops run inside the server with wall-clock timestamps, so
external samples keep arriving while the campus simulation is paused. The
isolated server now boots **paused** (`engine.set_paused(True)` in
`main()`), so restarts never run the simulation.

### Verified (2026-10-23, isolated copy)

- **Python: 118 tests OK** (new `tests/test_battery.py` 9, `test_sensor_faults.py` 6,
  `test_fleet.py` 7; three count/catalog expectations updated for the new
  device; the known randomized-noise alarm flake passed 3/3 on retry).
- Browser acceptance (`batterycheck.js`, `fleetcheck.js`) requires the
  approved server restart (the running process predates the backend
  changes) — pending approval, see the delivery report.

## Roadmap audit and Phase 7 (proposed) — demonstration readiness

**Audit (2026-10-23).** This workspace has no Git history (it is an isolated
copy), and neither this README nor the original repository's README or commit
log contains a phase plan or roadmap beyond the work described above. The
last documented forward-looking list from the project's early README —
battery storage, sensor-fault layer, SQLite persistence, fleet view and the
IoT/MQTT data path — is **fully implemented**: persistence (Step 4),
sensor-fault layer and battery storage (Phase 5), fleet view and the
simulated MQTT data path (Phase 6). Everything described in this README is
implemented and tested.

**Phase 7 is therefore a proposed completion phase, not an original roadmap
item.** It is justified by the stated competition goal (China–Africa Youth
Entrepreneurship Competition) and by one concrete, documented UI defect: the
AI Energy Report used the native `alert()` — blocking, unthemed, not
accessible, and unsuitable for a projected demo.

### Phase 7 scope and acceptance criteria

1. **AI Energy Report dialog.** Replace `alert()` with an in-page, accessible
   dialog reusing `/api/intelligence/report` and the existing design system:
   themed overlay, `role="dialog"` + `aria-modal`, labelled title, focus
   moved in on open and returned to the trigger on close, Escape / close
   button / backdrop dismissal, loading and error states inside the dialog,
   explicit "not metered · simulated" provenance. Acceptance: values match
   the API; no native dialogs; works at 1440×900 and 390×844 with no
   overflow; zero console/network errors.
2. **Competition demonstration guide** (below): a numbered, reproducible
   walkthrough that maps each claim to a verified feature and states what is
   simulated versus real.
3. **Final regression** across the full suite.

### Verified (2026-10-23, isolated copy, port 8019, simulation paused)

- **17/17 report-dialog checks** (`reportcheck.js`): dialog opens with no
  native alert, modal semantics, focus in/out, Escape + button + backdrop
  close, status/summary/waste/cost/CO₂ compared with the live API response,
  simulated provenance note, error state rendered in-page (page-local
  network stub), phone layout fits with no overflow, zero console/network
  errors.
- Full regression ladder re-run after Phase 7 (see the delivery report).

## Phase 8 — UI/UX defect fixes

Manual testing found four user-facing defects; each was reproduced, root-caused
and fixed without changing alarm semantics, routing, or the twin.

1. **Alarm "detail window" disappeared on a second click.** Root cause: in the
   alarm-center overlay, selecting an alarm's device called `closeAlarms()`
   before opening the drawer, so the alarm list vanished on the jump. Fix
   (`web/alarms.js`): the center now always stays open behind the drawer;
   the drawer's own top-right ✕ closes it without touching the alarm list.
2. **Floating windows fixed and obstructive.** A shared drag handler
   (`web/shell.js`) lets the navigator, simulation popover, alerts card and
   the alarm-center overlay be dragged by their header. It never starts on a
   button/input, keeps the panel inside the viewport (and below the shell
   topbar), is clamped on resize, is disabled in page modes (Assets table,
   Alarms page) and on mobile (≤760 px), and is implemented without new
   dependencies or files.
3. **Notification overlapped the interface and could not be dismissed.**
   Root cause: the connection notice was centred over the stage with no
   control, and it lived **inside the stage**, so it could not appear at all
   on routes whose stage is hidden (Settings, Intelligence). Fix
   (`web/index.html`, `web/shell.js`, `web/app.js`, `web/style.css`): the
   notice is moved to **body level** and fixed to the top-right under the
   shell topbar (z-index 80, above workspace panels and below the report
   dialog), so it shows on every route. Its ✕ is now 30×30 px, high-contrast,
   labelled `Dismiss notification`, dismisses for the current outage,
   re-arms after a reconnect, and is inset full-width on phones.
   A related stacking defect was found while fixing this: the sticky shell
   topbar sits above the stage's stacking context, so the **top of the alarm
   center (its header and close control) was covered and unclickable**. The
   overlay now starts below the topbar (`web/shell.css`).
4. **Settings appeared not to navigate.** Root cause: the route did change,
   but the 960 px scene stayed above the settings panel, placing the controls
   ~260 px below the fold — so the page looked unchanged. Fix
   (`web/shell.css`): the Settings route hides the stage; the panel now
   renders at the top of the content area. All entry points, direct loads
   and Back/Forward were verified.

**Verified (2026-10-23, isolated copy, port 8019, paused simulation):** the
Phase 8 suite (`phase8check.js`) passes **44/44** (alarm clicks including a
poll-crossing repeat and Escape close, drag across all four panels with
viewport clamping, page-mode and mobile opt-outs, Settings navigation from
the sidebar, direct load and history, zero console/network errors), and the
dedicated notification suite (`noticecheck.js`) passes **13/13** — driven by
a **real outage** (aborted API requests, not a stubbed flag) and verified
with **real mouse clicks**: the ✕ is 30×30, topmost at its centre, labelled,
dismisses the notice, stays dismissed for the same outage, re-arms after a
reconnect, and works on the Settings route and at 390 px. Screenshots
`_p8b_notice_desktop.png`, `_p8b_notice_settings.png`,
`_p8b_notice_phone.png`, `_p8_settings_visible.png`.

## Phase 9 — Alerts, side panels and resizable windows

Five connected UI upgrades; no new dependencies, routes, endpoints or
static files — every change lives in the existing served files.

1. **Notification action button.** The connection notice keeps its separate
   high-contrast ✕ and gains a labelled **“Open alarm center”** action
   beside the message. It opens the existing alarm view through the same
   path as the rail / Manage / `A` key; on routes whose stage is hidden
   (Settings, Intelligence) it opens the Alarms page instead so the action
   is never an invisible overlay. The banner stays up until it is dismissed
   or the connection actually returns, stays dismissed for the same outage
   and re-arms after a reconnect (`web/index.html`, `web/app.js`,
   `web/style.css`). On phones the action is a full-width row and the
   banner reserves the ✕ strip so the buttons never overlap.
2. **Repair Matching and Trend Analysis side panels.** The two cards leave
   their centered / left-edge positions and form one fixed panel stack
   along the **right side** below the shell topbar on the scene routes
   (`.left-stack` repositions; selectors carry `.stage` to outrank the
   `shellpage` container queries). Each panel has a clear header (kicker +
   status chip) and its own **✕**; the live rendering, “Review issue”
   device link and the sparkline are untouched (`renderRepair` /
   `renderTrend` unchanged). The dock gains **Repair / Trend** pills that
   reopen a closed panel, and a ✕ on the floating Alerts card closes it.
   On phones both panels start closed and the pills open them as
   near-full-width bottom sheets (the alarm-center convention). Crossing
   back to desktop reopens the panels the user left open and keeps the
   ones they closed closed (`web/index.html`, `web/shell.js`, `web/shell.css`).
3. **Alarm Center close button.** The overlay keeps its own top-right ✕
   (`#alarm-close`, separate from the device drawer's ✕) — closing returns
   focus without leaving the current route. On the Alarms route the center
   is the page content and deliberately has no ✕; the drawer remains the
   separate detail window above it. Filtering, acknowledge / resolve,
   device navigation and counts are unchanged (`web/alarms.js` untouched).
   *(Phase 10 supersedes the Alarms-route part: the center is now a
   floating window there too, with a working ✕.)*
4. **Resizable, movable windows.** All floating windows — navigator,
   simulation popover, alerts card, alarm center, device drawer, repair and
   trend panels — get right/bottom edge strips and a visible bottom-right
   corner grip (E / S / SE), per-window minimum sizes, and viewport maxima.
   Resizing works with mouse and touch (≥761 px); resized windows clear
   their CSS `max-width`/`max-height` dashboard caps so the grip always
   does what it shows. Dragging works from the header only (never from
   buttons, inputs or the chart), keeps the window **right of the main
   navigation and below the top bar** even when it is taller than the free
   band (it shrinks to fit so its grip stays reachable), and the window the
   user last interacted with raises above its siblings — always below the
   alarm center, drawer, notification and report dialog. Page modes (Assets
   table, Alarms page) and phones (full-width sheets) opt out. Ordinary
   page content and the 3D twin are untouched (`web/shell.js`,
   `web/shell.css`, `web/style.css`).

**Verified (2026-10-23, isolated copy, port 8019, simulation running, no
state changes):** driven by real mouse clicks and real keyboard presses in
Edge against the running server, with the notification suite driven by a
**real outage** (all `/api/` fetches rejected, restored afterwards):

- `_probes/interact.cjs` — **28/28**: repair/trend/drawer drag with
  topbar/sidebar clamping and viewport fitting, resize growth + per-window
  minimums, ✕ close + dock-pill reopen for both side panels, alarm-center
  open (A) and ✕ close without leaving the route, banner action/✕
  visibility, non-overlap and topmost-ness, action opens the alarm center,
  banner stays during the outage, stays dismissed for the same outage and
  re-arms after reconnect, sim-pop resize.
- `_probes/windows.cjs` — **8/8**: drag + resize for the alarm-center
  overlay, alerts card, navigator and sim popover (drawer/repair/trend
  covered above).
- `_probes/mobile.cjs` — **28/28** at 390 px: panels closed at load, dock
  pills open near-full-width sheets inside the viewport, ✕ closes them,
  banner buttons visible / non-overlapping / topmost / working, alarm ✕,
  desktop↔mobile crossing semantics, alarms + assets page modes hide
  resize handles, overlay ✕ returns.
- `_probes/final.cjs` — **26/26**: trend chart SVG renders, WebGL + Canvas
  twins untouched, “Review issue” still opens the device drawer, drawer
  defaults below the topbar, alerts-card ✕, raise-on-interact stacking,
  dragged windows stay inside a shrunken viewport, side stack
  visible/hidden per route across all eight routes, banner action on
  Settings opens the Alarms page.
- Zero console/page errors across every run.

Screenshots: `_probes/geo_desktop_before.png` / `geo_mobile_before.png`
(before), `_probes/p9_desktop_dark.png`, `p9_desktop_light.png`,
`p9_desktop_banner.png`, `p9_alarm_center.png`, `p9_mobile_sheet.png`,
`p9_mobile_banner.png` (after). The probes themselves live in `_probes/`
and are read-only: they never call control endpoints, never reset or pause
the simulation and only read `/api/state`, `/api/alarms`,
`/api/device/…` and `/api/equipment`.

## Phase 10 — Window controls, permanent launchers and drag/resize repair

Six window-management defects fixed with no new dependencies, routes,
endpoints or static files. Served files changed: `web/index.html`,
`web/shell.js`, `web/alarms.js`, `web/navigator.js`, `web/shell.css`.

**Root causes found in the running UI (real-browser baseline):**

- There were no permanent sidebar controls for the Alerts card, Repair
  Matching or Trend Analysis; those windows could only be reopened from the
  dock pills or by reloading a route.
- Launcher state was not a single source of truth. The Alarm Center icon
  carried a route-active class on `#/alarms`, and closes through the
  window's own ✕, Escape, the dock pills or a route change did not
  consistently clear the icon's active/pressed state. The Building
  Navigator's close did not update its icon.
- Every window close glyph was `✕` (U+2715), some had no accessible name,
  and the Alarm Center's ✕ was `display:none` on `#/alarms` because the
  route turned the overlay into an absolute page panel.
- The connection notice (`z-index: 80`, top-right) physically covered the
  top-right windows' headers. Before the fix, `elementFromPoint` at the
  centre of the Alarm Center ✕ and the Repair ✕ both resolved to
  `#conn-banner-close`: clicks dismissed the notice instead of closing the
  window.
- Phone bottom sheets began at `left: 8px`, underneath the fixed 64 px
  icon rail (`z-index: 70`), covering their titles and close controls.
- At tablet/small-desktop widths the legacy scene container queries
  (`@container shellpage (max-width: 950px)` and `(max-width: 760px)`) hid
  the Alerts card with `display:none` even though its permanent launcher
  was visible. At 800 and 761 px repeated real clicks left the card at
  0×0 with `aria-pressed="false"` — the control looked dead. At 1024 px
  the card rendered, but its header sat under the scene's view-mode
  strip, so `elementFromPoint` at the centre of its × returned `viz-mode`
  rather than `alerts-close`.

**Fixes**

1. **Permanent sidebar launchers.** The existing Alarm Center and Building
   Navigator icons keep their places in Operate / Workspace tools. A new
   **Windows** group adds Alerts, Repair matching and Trend analysis. One
   `shellSyncLaunchers()` runs after every open/close, ✕, Escape, dock-pill,
   route and resize change and derives `active` / `aria-pressed` from the
   windows' actual rendered visibility. The same control opens a closed
   window and closes an open one, remains visible in both states, and the
   window's ✕ leaves the control ready to reopen it. Route fallbacks use
   existing pages: the alarm launcher opens `#/alarms` when the stage is
   hidden, Repair/Trend go to `#/overview` when the side stack is not
   displayed, and the Assets page keeps the navigator as page content.
2. **Real × controls.** All six window close glyphs are `&times;` (U+00D7)
   with 26 px targets (30 px for the Alarm Center and drawer), accessible
   names/titles and visible focus rings. The Alarm Center is a floating
   window on every route, including `#/alarms`; its ✕ closes it in place
   and preserves the route, while the device drawer closes independently
   and never removes a sidebar launcher. On `#/assets` the center floats
   over the equipment table and leaves the table in place when it closes.
   The Phase 9 `/alarms` page-fill, hidden-✕ and hidden-resize rules were
   removed.
3. **Drag and resize restored.** Header dragging, right/bottom edge strips
   and the visible bottom-right grip work for the navigator, simulation
   popover, Alerts card, Repair and Trend panels, Alarm Center and device
   drawer, with per-window minimums, viewport/sidebar/topbar clamping and a
   guard that stops header drags from starting on buttons or fields. Phones
   hide resize handles and use bottom sheets; ordinary page content and the
   3D twin never enter the drag/resize path.
4. **Notification clearance.** When a top-right window is open, shell.js
   measures its left edge and publishes `--shell-banner-right`; the notice
   slides to the left of that window and caps its width so it stays right
   of the sidebar. Its action and ✕ stay inside the notice and clickable
   from 761 px through 1440 px. The notice remains above the windows and
   keeps its own dismiss control.
5. **Phone sheets.** Alerts, Repair, Trend and the Alarm Center start to
   the right of the 64 px rail and fit the 390 px viewport; opening one
   tucks the other sheets away, while the drawer keeps its independent
   close. Choosing a launcher from the expanded sidebar closes the rail.
6. **Alerts at tablet widths.** The Alerts card is no longer part of the
   legacy scene-decoration hide lists. Where the shell container is
   ≤950 px it stays a real window (parked 16 px from the stage's left
   edge, `z-index: 33`, above the scene's view-mode strip at 25 and the
   navigator at 32, below a dragged window at 46) so its header and ×
   remain visible and hit-testable; tablet widths above 760 px use
   this floating form, while phone widths keep the bottom sheet. The
   card was verified at 1024×800, 800×900 and 761×900, including real
   sidebar clicks and × closes.

**Verified (2026-10-23, existing server on 8019, simulation running; the
probes made no simulation or alarm state changes)** — real mouse
clicks/keyboard in Edge against the running
app, with the notification runs driven by a stubbed `/api/` outage that was
restored afterwards:

- `_probes/p10_verify.cjs` — **117/117** (Phase 11 added one Assets-launcher
  check): five launchers (Alerts, Repair,
  Trend, Building Navigator, Alarm Center) each visible with their window
  closed, opened and closed twice from the same control, reopened, closed
  by the window ✕ and reopened again; close targets ≥24 px and
  hit-testable; no duplicate launchers or windows; `#/alarms` closes in
  place; alarm-center and drawer closes independent; the Alarm Center opens
  over the Assets equipment table without hiding it and closing it leaves
  `#/assets` intact; both the Alerts and alarm launchers use page
  navigation when the stage is hidden; Repair and Alerts survive route
  round-trips (hidden only where the page cannot host them, never closed by
  navigation); Alerts card distinct from the outage notice; route fallbacks;
  Escape keeps launchers in sync.
- `_probes/p10_drag.cjs` — **100/100**: header drag plus corner resize for
  Alerts, Repair, Trend, Navigator, Alarm Center (also on `#/alarms`) and
  the drawer; close controls remain clickable and inside the viewport;
  buttons do not start header drags; the Alarm Center respects its 320×280
  minimum; exactly 21 resize handles (3 on each of the seven windows); no
  handles or header drag on phones; dragging the 3D scene/page content
  starts no window drag.
- `_probes/p10_mobile.cjs` — **89/89** at 390×844: all five rail controls
  visible, two full open/close cycles each plus the window ✕ and reopen;
  sheets stay right of the rail and inside the phone; close controls
  hit-testable; one sheet at a time; alarm center + drawer close
  independently; expanded-sidebar launcher path.
- `_probes/p10_tablet.cjs` — **174/174** at 1024×800, 800×900 and
  761×900: the same five-launcher open/close/reopen cycles with real
  mouse clicks at the widths where the legacy scene container queries
  used to suppress the Alerts card; every window ✕ is on screen,
  ≥24 px and hit-testable; launchers survive × and reopen; route
  preserved; no horizontal overflow; zero errors. This cross-width pass
  is what exposed the tablet-only Alerts defect recorded above.
- `_probes/p10_tablet_drag.cjs` — **12/12** at 1024×800: the repositioned
  Alerts window still drags from its header, resizes from the visible
  bottom-right grip, clamps inside the viewport, and its × remains
  hit-testable after both operations.
- `_probes/p10_banner_all_windows.cjs` — read-only cross-width evidence
  at 1440, 1024 and 800 with the outage notice visible and Alerts +
  Navigator open: the ✕ of Alerts, Navigator, Repair and Trend all
  resolve to themselves, and the notice intersects none of their
  headers.
- `_probes/p10_overlap_after.cjs` — **9/9**: with the outage notice up, the
  Alarm Center, Repair and drawer ✕ controls hit-test to themselves and
  the notice sits clear of their windows.
- `_probes/p10_banner_narrow.cjs` — **20/20** at 761, 800, 1024 and
  1180 px: the notice and its action/✕ remain inside the viewport, right of
  the rail and left of the open Alarm Center.
- Zero console/page errors across all runs.

Screenshots: `_probes/p10_before_overview.png`,
`p10_before_alarms_route.png`, `p10_before_mobile.png`,
`p10_before_banner_overlap.png` / `_stack.png` (before);
`_probes/p10_after_overview.png`, `p10_after_windows.png`,
`p10_after_alarms_route.png`, `p10_assets_alarm_open.png`,
`p10_after_banner_clearance.png` / `_stack.png` / `_drawer.png`,
`p10_after_banner_narrow_761.png` /
`_800.png`, `p10_after_mobile_sidebar.png` / `_alerts.png` / `_trend.png`,
`p10_mobile_after_compact_rail.png`, `p10_mobile_after_alerts.png`,
`p10_mobile_after_repair.png`, `p10_mobile_after_trend.png`,
`p10_mobile_after_alarmcenter.png`, `p10_mobile_after_alarm_drawer.png`,
`p10_mobile_after_sidebar_expanded.png`, `p10_tablet_after_1024.png` /
`_800.png` / `_761.png`, `p10_banner_all_1440.png` / `_1024.png` /
`_800.png`. The tablet defect was found during the final cross-width
pass, after the original baseline captures, so its before state is
recorded by the measured `display:none` / 0×0 / `viz-mode` hit result
rather than a before screenshot.

All probes are read-only: no simulation control/reset calls, no fault
injection and no alarm acknowledgement/resolution. The four resolved
records predate this session (2026-10-22, `resolved_by: "Operator"`); no
acknowledgement was added during the runs (acknowledged 0). The alarm
store read after the runs was open 0, acknowledged 0, recovered 24,
resolved 4, total 28. The one-record increase from the earlier 27 is a
simulated water-heater event (`wh-b2`, event `0:46`) that the running
simulation opened and closed during the session, with null
acknowledgement fields. No probe called a simulation control/reset or
alarm-mutation endpoint.

## Phase 11 — Assets & Equipment window lifecycle

On `#/assets` the rail icon (`rail-equipment`) and the shared `#navigator`
card now act as one window: the icon opens the destination and the card,
the card's × (U+00D7, 30 px target, accessible name) closes it in place and
keeps the route and table, and the still-visible icon reopens or toggles it.
The scene-navigator icon (`rail-buildings`) leaves `#/assets` and opens the
floating navigator in the same click. Scene-route drag/resize and the phone
sheet layout are unchanged. Real-browser coverage: `_probes/p11_assets.cjs`
**84/84** at 1440×900, 800×900 and 390×844, plus the updated
`_probes/p10_verify.cjs` one-click Assets-launcher cycle.

## Phase 12 — Full application audit, window consistency and delivery

Read-only audit at 1440×900, 1024×800, 800×900 and 390×844 using real mouse
and keyboard input. `_probes/p12_audit.cjs` covers every route, the twin
hierarchy and deep links, Assets, analytics tabs, fleet, intelligence, the
AI report, settings, alarms, browser history, multi-window z-order,
drag/resize, overflow, shortcuts and console/network errors:
**168/168** at 1440, 1024 and 800, **156/156** at 390. Zero console, page
or failed-request errors.

Defects fixed in this pass:

- The AI report close glyph is U+00D7 with an accessible name; its modal
  blocks page shortcuts and restores focus on close.
- Simulation settings is anchored below the shell topbar instead of under
  it. The Simulate trigger stays reachable at 761–960 px, where the legacy
  stylesheet hid the bottom actions.
- Alarm Center and device drawer keep independent × controls: the drawer
  clears the alarm header on desktop, and a short phone alarm sheet keeps
  its header above the drawer.
- Camera reset on Overview no longer pushes a stray URL or history entry.
- Twin deep links validate the referenced building/floor/room and fall back
  to the not-found page for unknown IDs.
- `A` opens the visible Alarm Center from pages without the stage; `/` no
  longer steals focus from the AI report.

Verification of the delivered tree: **121/121** Python unit tests,
`python -m compileall` for every package, and `node --check` for every
served and probe script. The full Phase 10/11 real-browser set was re-run
after the fixes: `p10_verify` **117/117** (one Assets-launcher check was
added because Phase 11 makes that control open the navigator in one click),
`p10_drag` **100/100**, `p10_mobile` **89/89**, `p10_tablet` **174/174**,
`p10_tablet_drag` **12/12**, `p10_overlap_after` **9/9**,
`p10_banner_narrow` **20/20**, and `p11_assets` **84/84**. Production port
8000 and the production database were not touched; all browser writes were
the isolated instance's normal polling.

## Phase 13 — Backend audit and safe verification

This phase audited the backend at commit
`813eeeb31375470263c5d40c1a7e37ab2103977c` (`phase12-shell-audit`)
without repeating the completed frontend audit. The running development
server on port **8019 was not restarted**, and port 8000, the production
database and the original repository were not touched. All endpoint checks
below ran against an in-process `ThreadingHTTPServer` on an ephemeral
loopback port with an isolated temporary database.

### Confirmed defects fixed

| Area | Defect | Fix |
| --- | --- | --- |
| `sim/engine.py` | `reset()` re-ran `__init__`, replacing `self.lock` while other threads were inside it; a thread could observe a partially reset engine. | `reset()` rebuilds state under the existing lock via `_build_state()`. |
| `sim/engine.py`, `equipment/store.py` | After a reset, event ids restart at 1. If the simulation caught up past the previous sample before the next 10 s sample, the old detector saw a forward timestamp, kept the previous epoch, and an old event key could collide with the new one. | The engine exposes a monotonic `sim.reset_seq`; the store starts a new anomaly epoch whenever it changes and closes active anomalies. |
| `server.py`, `equipment/calculations.py` | Live/imported `measured_at` values are wall-clock Unix **seconds**, but `calculate_energy` expects **minutes**. A 15 s sample was integrated as 15 minutes and the "24 h" baseline covered 24 minutes. | `_energy_block` converts seconds to epoch minutes before integration. Simulated samples remain sim absolute minutes. |
| `server.py` | `GET /api/intelligence` persisted an `intelligence_snapshots` row on every dashboard poll; `GET /api/alarms` also called `refresh_anomalies`, writing on every poll. | Both GETs are read-only. Alarm persistence happens in the 10 s sampling loop and immediately after `POST /api/fault`. |
| `server.py` | POST bodies were read without a size limit; a non-object JSON body caused an attribute error; control values were unchecked (`"false"` paused the simulation, unknown weather returned `ok: true`, a string speed raised). | `Content-Length` is validated before reading with a 64 KiB cap; bodies must be JSON objects; speed/pause/weather/fault fields are type- and range-checked with 400 responses. |
| `server.py` | `POST /api/ai/diagnose` fabricated a warning event ("Current residual outside the expected band") when the device was healthy. | It now diagnoses only a live active non-operator event and returns `"anomaly": null` otherwise. |
| `sim/engine.py` | Sensor-layer faults injected on aggregate devices (HVAC, lighting, plugs, inverter, ...) were stored in the catalog but never applied: only leaf devices honoured them. | Aggregate measurements are distorted after their honest sum; the battery's signed flow is handled after its step. Leaves already worked. |
| `intelligence/metrics.py` | Sensor health ignored live sensor faults (`sensor_drift`, `sensor_stuck`), reporting 100 while equipment health moved. | Score penalties include sensor-layer faults from `device["faults"]` and averages only over devices with sensor evidence, so one bad sensor is not diluted by ~100 healthy ones. |
| `equipment/store.py` | Read paths (`list_equipment`, `equipment_detail`, `stats`) shared the SQLite connection with the sampling thread without the lock. | Reads hold `self.lock`, matching the existing write paths. |
| `server.py`, `sim/engine.py` | Alarm sync used the dashboard's top-10 anomaly list, so an 11th live event was treated as recovered and closed. `/api/device` read the shared event deque outside the engine lock. | Persistence/alarm sync use `snapshot(full_anomalies=True)`; `device_detail` copies the device's alerts under the engine lock. |

### Tests

`tests/test_backend_fixes.py` adds **20** offline regressions (isolated temp
databases; no live server, no production data):

- reset keeps the same lock and bumps `reset_seq`; a post-reset catch-up
  sample starts a new anomaly epoch with a distinct event key;
- sensor drift/stuck on aggregate devices distorts the aggregate reading;
- sensor health penalises injected sensor faults but still honours dataset
  `sensor_flags`;
- POST size, malformed/ non-object JSON, and control/fault validation return
  400 without changing engine state; valid controls still apply;
- a healthy device diagnoses with no anomaly, a real active anomaly is passed
  to the diagnosis engine;
- GET intelligence/alarms do not write; a fault POST syncs alarms;
- live series in Unix seconds integrate to the correct kWh and 24 h baseline;
- `device_detail` carries locked alerts; full snapshots keep >10 alarms.

Full suite: **141 Python tests** (`python -m unittest discover -s tests -q`);
the suite passed on repeated runs, and `python -m compileall` covered all
packages. One pre-existing test,
`tests/test_panels.py::test_fault_isolation_single_panel`, is
weather/noise-sensitive: it occasionally sees a second water-heater anomaly
(or no P-01 anomaly) and can fail a run. The same behaviour was reproduced
on the unmodified `813eeeb` tree (5/200 simulated runs), so it is not caused
by this phase; it remains unmodified.

### Deliberately not changed

- `GET /api/device/<id>` returns 404 for registry-only live/imported
  equipment. The Fleet UI uses `/api/equipment`; `/api/device` is the twin
  inspector, and inventing engine data for an external device would be worse.
- `intelligence_snapshots.ts` is declared `REAL` while `IntelligenceStore`
  inserts a TEXT timestamp. The table is append-only, no code reads the
  column, and changing an applied migration is riskier than the mismatch.
- The running server on 8019 still executes the pre-fix code. **These fixes
  are not live there**; applying them requires a deliberate server restart,
  which was outside this task's authorization. No live simulation was
  resumed, paused, reset, or fault-injected, and no alarm was acknowledged
  or resolved.

## Running and debugging in VS Code

The reported **F5 → `localhost:8080`** behaviour comes from the *parent
folder's* leftover template `lot/.vscode/launch.json` (dated before this
project), which points at port 8080 and is shared with unrelated projects;
it is outside this isolated workspace and was deliberately not modified.

The project ships its own configuration in
`energy-platform-phase2-shell/.vscode/launch.json` (Edge and Chrome, both
`http://127.0.0.1:8019/`). Correct workflow:

1. Start the development server once in a PowerShell terminal:
   ```powershell
   cd C:\Users\hamed\.vscode\lot\energy-platform-phase2-shell
   $env:ENERGY_DB_PATH="C:\Users\hamed\.vscode\lot\.shot-harness\phase2-accept.db"
   python server.py --port 8019
   ```
2. Open **this folder** (`energy-platform-phase2-shell`) in VS Code, not the
   parent `lot` folder. F5 then uses the project's launch configuration and
   opens the debugger against `http://127.0.0.1:8019/`.
3. If the parent folder must stay open, use **Run and Debug → Energy
   Platform — Edge (:8019)** after adding this folder to the workspace, or
   simply open `http://127.0.0.1:8019/` in a browser.

## Competition demonstration guide

A reproducible walkthrough (about 8 minutes). The simulation must be
**running** for animated values — an operator resumes it from Settings; this
guide does not change the simulation state by itself. Everything shown is
simulated or an imported/mock feed, never physical hardware.

1. **Overview (`#/overview`)** — campus summary, live KPIs, the plant
   dashboard, and the Energy Intelligence panel below the scene (health,
   projected waste, priorities, recommendations).
2. **Digital Twin (`#/twin/campus`)** — WebGL Tower A by default: orbit,
   zoom, click the tower → floors → rooms → equipment; open the inspector
   (metering, simulated consumption, calculated estimates, fault injection,
   AI diagnosis). Explode floors, playback heatmap and camera presets are
   available in the scene controls.
3. **Assets (`#/assets`)** — the full registry table: search, type / status /
   **source** filters (simulated / imported / live), scope selectors, live
   kW, row → inspector. The source filter is the honest data-provenance
   demo: only simulated and the two external feeds exist.
4. **Alarms (`#/alarms`)** — the simulator's alarm lifecycle with counts and
   filters; while the sim runs, injected faults appear as open alarms,
   acknowledge keeps the live condition visible, and resolution is refused
   until the detector reports recovery.
5. **Energy Analytics (`#/analytics/production|consumption|heatmap`)** —
   today/yesterday production and consumption, grid import/export,
   self-sufficiency, battery flow and state of charge, per-building table,
   playback timeline with explicit "no data" buckets.
6. **Energy Intelligence (`#/intelligence`)** — health score and components,
   waste impact, priorities, recommendations and the **AI Energy Report
   dialog** (in-page, themed, simulated-provenance note).
7. **Fleet (`#/fleet`)** — all sites and sources: Tower A and Annex B
   (simulated twin), Warehouse 12 (imported dataset), Office 3 (simulated
   MQTT mock). Freshness is shown per site; external sites are monitoring
   data only (no 3D twin).
8. **Settings (`#/settings`)** — speed, weather, pause/resume, reset, theme,
   effects quality and operator name, with the note that speed/weather and
   pause/reset affect the shared simulated state.

**Claims to make and not make.** Say: "simulated campus with virtual sensors,
an imported dataset feed and a simulated MQTT path; calculated estimates
using documented formulas." Do not claim real hardware, a real MQTT broker or
metered readings.

## Phase 4 — final status

**Complete.** All four destinations (Assets, Alarms, Analytics, Settings)
have real page content; the four compatibility banners are gone (the
not-found page and the intelligence provenance note still use the shared
panel primitive). The compat-specific actions (focus-chart /
open-heatmap / open-sim) were removed with their banners. No new backend
endpoints, schema changes, external dependencies or new static files were
introduced — the two page modules live in `shell.js` so the running server
needs no allowlist change or restart. Tower A, the WebGL default, the
Canvas fallback, camera controls, the twin and the monitoring logic were
not modified.

## Optional Claude enrichment

The offline rule engine is always available. Claude enrichment remains optional and falls back to the rule engine on missing credentials, API errors or missing package.

## Source

The sensor dataset bridge is based on the team's Ali PV sensor simulation dataset. The live project repository is maintained at `medeai68/energy-platform`.


## License

MIT - see [LICENSE](LICENSE).

## Credits

- Digital twin, simulation engine, anomaly detection & AI agent: medeai68
- Energy Intelligence layer & sensor dataset bridge: Stephen (PR #2)
- Original sensor dataset bridge: Mohammed (PR #1)
- PV sensor dataset pipeline: Ali (makaynwalu/Solar-Energy-Enterprise-AI-Monitoring-Simulation-System)
