"""Single source of truth for Ali's labeled sensor/PV fault classification.

The adapter imports classify_row() from this module instead of re-deriving
thresholds. This prevents the bridge and validator from silently disagreeing.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

SENSOR_FAULTS = {
    "voltage_bias", "voltage_drift", "sensor_dropout", "stuck_sensor",
    "sensor_noise", "panel_overheating", "inverter_overheating",
    "grid_voltage_anomaly", "power_loss",
}


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _classify_voltage_sensor(nv, fv):
    if fv is None and nv is not None:
        return ["sensor_dropout"]
    if nv is None or fv is None:
        return []
    offset = fv - nv
    abs_off = abs(offset)

    if abs(fv - 420.0) < 0.01 and abs(nv - 420.0) > 2.0:
        return ["stuck_sensor"]
    if abs_off >= 20.0:
        return ["voltage_bias"]
    if abs_off >= 5.0:
        return ["sensor_noise"]
    if abs_off >= 0.3:
        return ["voltage_drift"]
    return []


def classify_row(row: Dict[str, str], prev_row: Optional[Dict[str, str]] = None) -> List[str]:
    """Return all defensible fault flags for one telemetry row."""
    flags: List[str] = []
    nv = _to_float(row.get("normal_voltage"))
    fv = _to_float(row.get("faulty_voltage"))
    current = _to_float(row.get("current"))
    normal_power = _to_float(row.get("normal_power"))
    measured_power = _to_float(row.get("measured_power"))
    panel_t = _to_float(row.get("panel_temperature"))
    inv_t = _to_float(row.get("inverter_temperature"))
    gv = _to_float(row.get("grid_voltage"))

    flags.extend(_classify_voltage_sensor(nv, fv))

    if panel_t is not None and panel_t > 70.0:
        flags.append("panel_overheating")
    if inv_t is not None and inv_t > 80.0:
        flags.append("inverter_overheating")
    if gv is not None and (gv < 210.0 or gv > 250.0):
        flags.append("grid_voltage_anomaly")

    # A real measured_power value is required. Missing readings are dropout,
    # not a healthy reading.
    if (
        normal_power is not None and measured_power is not None
        and normal_power > 0 and measured_power < normal_power * 0.75
        and current is not None and nv is not None
        and not any(f in flags for f in ("sensor_dropout", "voltage_bias", "stuck_sensor"))
    ):
        flags.append("power_loss")

    # Stable order makes validation deterministic.
    return list(dict.fromkeys(flags))


def classify_dataset(rows):
    return [classify_row(r) for r in rows]
