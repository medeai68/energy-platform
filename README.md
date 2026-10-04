# Energy AI Platform — Digital Twin, AI Diagnostics & Energy Intelligence

AI-powered energy monitoring and intelligent diagnosis for solar-energy enterprises. The platform combines a 2D digital twin, virtual sensors, labeled sensor-fault data, anomaly detection, an explainable AI agent, and an Energy Intelligence layer that quantifies waste and recommends actions.

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
├── tests/
│   ├── test_dataset_bridge_fixed.py
│   └── test_intelligence.py
└── web/
    ├── index.html
    ├── app.js
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

## Energy Intelligence API

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | Digital twin snapshot + current intelligence |
| `GET /api/intelligence` | Current health, waste, priorities and recommendations |
| `GET /api/intelligence/report` | Daily operator report |
| `GET /api/intelligence/history` | Recent persisted intelligence snapshots |
| `POST /api/intelligence/scenario` | Estimate savings from fixing a device/fault |
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

The intelligence layer stores recent snapshots in:

```text
data/energy_intelligence.db
```

This file is runtime state and should not be committed.

## Tests

Run:

```bash
python -m unittest discover -s tests -v
```

The important regression is the end-to-end dataset test: a sensor fault must survive the adapter and be named by `diagnose()`.

## Optional Claude enrichment

The offline rule engine is always available. Claude enrichment remains optional and falls back to the rule engine on missing credentials, API errors or missing package.

## Source

The sensor dataset bridge is based on the team's Ali PV sensor simulation dataset. The live project repository is maintained at `medeai68/energy-platform`.

