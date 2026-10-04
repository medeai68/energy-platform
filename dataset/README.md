# Sensor Dataset Pipeline

Ali's labeled PV sensor dataset contains second-by-second telemetry and ground-truth fault labels. The bridge connects those rows to the platform's AI agent.

## Files

| File | Purpose |
|---|---|
| `sensor_simulator.py` | Generates labeled PV sensor data |
| `sensor_data.csv` | Committed 1,000-row dataset |
| `adapter.py` | Converts CSV watts to platform kW telemetry |
| `sensor_faults.py` | Single source of truth for fault classification |
| `validate.py` | End-to-end CSV → adapter → AI-agent validation |

## Fault labels

`normal`, `voltage_bias`, `voltage_drift`, `sensor_dropout`, `stuck_sensor`,
`sensor_noise`, `panel_overheating`, `inverter_overheating`, `power_loss`,
`grid_voltage_anomaly`.

## Important bridge rules

1. `adapter.py` calls `classify_row()` directly; thresholds are not duplicated.
2. CSV power is watts; platform device power is kW.
3. Missing `measured_power` remains missing and is never replaced by `normal_power`.
4. Sensor flags are attached to `extra.sensor_flags`.
5. The AI agent checks sensor flags before the residual/noise-band early return.

## Validate

Both invocation styles work:

```bash
python -m dataset.validate
python dataset/validate.py
```

The validation measures the actual:

```text
CSV -> classify_row -> adapter -> diagnose -> primary_fault
```

path against `fault_type`, rather than reporting classifier-only accuracy.
