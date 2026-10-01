# Energy AI Platform — Digital Twin & Diagnostics

AI-powered energy monitoring and intelligent diagnosis for solar-energy
enterprises. A 2D digital twin with virtual sensors simulates a commercial
building (rooftop solar, inverter, HVAC, lighting, plug loads) **without any
physical hardware**, detects abnormal consumption by comparing actual power
against an expected model, and an AI agent explains probable causes and
recommends corrective actions. Operators can inject virtual faults directly
through the visualization.

**Zero dependencies** — pure Python standard library for the backend, vanilla
HTML/JS/Canvas for the dashboard.

## Run it

```bash
cd energy-platform
python server.py            # optional: --port 8000
```

Open <http://localhost:8000>.

## 2-minute demo

1. The twin starts at day 1, 06:00 at 60× speed (1 sim-day ≈ 24 s).
2. Click **HVAC (3 units)** → inject **Excessive consumption**.
3. Within ~5 seconds an alert appears: *"HVAC consumption above expected (…)"*.
4. Click **Ask AI** → ranked probable causes (refrigerant leak, dirty coils…)
   with confidence and concrete corrective actions.
5. Try other signatures: **Soiling** on the Solar Array, **Efficiency drop**
   on the Inverter, **Lights on at night** (wait for night or speed up to
   300×), **Vampire load** on Plug Loads. Clear a fault the same way.
6. Watch the power-flow chart: solar generation (blue), building load
   (orange), grid exchange (aqua). Export happens when generation exceeds
   load.

Every chart has a **table** toggle (WCAG-clean twin), and the dashboard
ships dark-first with a validated light theme (◐ button).

## Architecture

```
energy-platform/
├── server.py          # stdlib ThreadingHTTPServer + JSON API (see below)
├── sim/
│   ├── engine.py      # sim clock, weather, 5 device models, history, kWh
│   └── faults.py      # virtual fault catalog (14 injectable faults)
├── ai/
│   ├── anomaly.py     # expected-vs-actual residuals + domain rules
│   └── agent.py       # rule-based diagnostic KB + optional Claude enrichment
└── web/               # dashboard: canvas digital twin, SVG charts, drawer UI
```

Each tick every device produces two numbers:

- **expected** — the healthy model for current conditions (irradiance,
  temperature, schedule, occupancy), *never* affected by faults;
- **actual** — the virtual sensor reading: expected × fault effects + noise.

The gap between them is what the detector and the AI agent work on.

### Device models

| Device | Healthy model |
|---|---|
| Solar Array (50 kWp) | irradiance curve (06:00–18:30) × cloud attenuation × cell-temperature derating |
| Inverter (50 kW) | min(DC in, rating) × 97% efficiency |
| HVAC (3 × 12 kW) | cooling demand from outdoor temperature → duty cycle |
| Lighting (6 kW) | 07:00–19:00 schedule with daylight-harvesting dimming |
| Plug Loads (9 kW) | occupancy curve (95% working hours, 15% overnight) |

Weather: cloud cover (random walk or forced mode) drives solar output and
outdoor temperature (daily sinusoid, cooler under cloud).

### Anomaly detection

- Relative residual `(actual − expected) / max(expected, floor)` vs a
  per-device threshold derived from its noise band; deviations must be
  sustained 2 ticks to raise an alert and 3 in-bounds ticks to clear.
- Domain rules catch named signatures: lighting active at night, inverter
  offline (critical).
- Severity: warning / serious / critical from residual magnitude.

### AI agent

Two engines, one interface (`POST /api/ai/diagnose`):

1. **Rule-based expert system** (default, offline): fault signatures →
   ranked causes with confidence + corrective actions.
2. **Claude enrichment** (optional): if `pip install anthropic` is done and
   credentials are available (`ANTHROPIC_API_KEY` or `ant auth login`), the
   telemetry context is sent to `claude-opus-5` with structured JSON output.
   Any API error falls back to the rule engine automatically.

## API

| Endpoint | Description |
|---|---|
| `GET /api/state` | Full snapshot: sim clock, weather, KPIs, devices, grid, alerts, history |
| `GET /api/device/<id>` | Device detail: telemetry, fault catalog, expected/actual history |
| `POST /api/fault` | `{device_id, fault_id, active}` inject / clear a virtual fault |
| `POST /api/control` | `{action: speed\|pause\|weather\|reset, value}` sim controls |
| `POST /api/ai/diagnose` | `{device_id}` → causes, confidence, actions, reasoning basis |

## Roadmap ideas

- Battery storage (BESS) device + self-consumption optimization
- Sensor-fault layer (meter drift) to demo "virtual sensor" health checks
- Persistence (SQLite) for multi-day analytics and reports
- Multi-facility fleet view, alerts via webhook/email
- IoT integration path: swap the simulation's noise source for real MQTT/
  Modbus data — the expected/actual pipeline stays unchanged
