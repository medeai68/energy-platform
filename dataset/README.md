# Sensor Dataset Pipeline (team member: PV sensor simulation)

This part simulates a grid-tied PV system **at the sensor level** and produces
a **labeled fault dataset** for the platform. While the live digital twin in
[`sim/`](../sim) simulates equipment at the kW level in real time, this
pipeline generates offline, second-by-second sensor records with ground-truth
fault labels - the training data for machine-learning fault classifiers and
for validating the anomaly-detection rules in [`ai/`](../ai).

## Contents

| File | Purpose |
|---|---|
| `sensor_simulator.py` | Generates 1,000 second-interval sensor records with 10 fault types and saves them to `sensor_data.csv` |
| `sensor_data.csv` | The generated dataset (committed for reproducibility) |
| `analyze_dataset.py` | Statistical report: fault distribution, averages per channel, sensor quality |
| `visualize_data.py` | 10 matplotlib plots of every channel (normal vs measured where applicable) |

## Simulated channels

- **Environment**: irradiance, ambient / panel temperature, humidity, wind speed
- **Electrical**: normal vs measured voltage, current, normal vs measured power, energy
- **Grid**: grid voltage, frequency, power factor
- **Inverter**: temperature, status

## Fault labels (severity 0-3)

| Fault | Severity | Meaning |
|---|---|---|
| `normal` | 0 | healthy operation |
| `voltage_bias` | 2 | sensor reads a constant offset (+30 V) |
| `voltage_drift` | 1-2 | offset grows over time up to +40 V |
| `sensor_dropout` | 3 | sensor returns no reading (NaN) |
| `stuck_sensor` | 2 | sensor frozen at 420 V |
| `sensor_noise` | 1 | ±15 V random jitter |
| `panel_overheating` | 2 | panel temp forced to 70-90 °C |
| `inverter_overheating` | 3 | inverter temp 80-100 °C, status "overheating" |
| `power_loss` | 2 | current drops to 40-70% of expected |
| `grid_voltage_anomaly` | 2 | grid voltage out of 190-210 / 250-270 V |

## How it fits the platform

- The **sensor faults** here (bias, drift, dropout, stuck, noise) are the
  sensor-fault layer listed in the main README roadmap - they complement the
  equipment faults injected through the digital twin UI.
- The **labeled dataset** is what an energy-analysis or AI team member can use
  to train a fault classifier, then compare its detections against the
  rule-based detector in [`ai/anomaly.py`](../ai/anomaly.py).

## Run it

```bash
# regenerate the dataset (overwrites sensor_data.csv)
python sensor_simulator.py

# print the analysis report
python analyze_dataset.py

# open the 10 interactive plots (requires matplotlib)
pip install -r requirements.txt
python visualize_data.py