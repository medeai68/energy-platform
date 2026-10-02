"""Sensor-fault classifier for the labeled PV dataset.

The simulator in `dataset/sensor_simulator.py` injects 10 fault types with
ground-truth labels in `sensor_data.csv`. Some of them are *equipment* faults
that `ai/anomaly.py` already catches via the residual (power_loss,
panel_overheating, inverter_overheating). Others are *sensor* faults
(voltage_bias, voltage_drift, sensor_dropout, stuck_sensor, sensor_noise,
grid_voltage_anomaly) that the residual cannot see because they do not change
the actual power.

This module names those sensor-level faults from raw telemetry. It is used
by `dataset/validate.py` to score the platform's detection against the
ground-truth labels, and its output (a list of flag strings) is passed
through `extra.sensor_flags` in `dataset/adapter.py` so `ai/agent.py` can
name the signature in its diagnosis.

Pure standard library.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


SENSOR_FAULTS = {
    "voltage_bias",
    "voltage_drift",
    "sensor_dropout",
    "stuck_sensor",
    "sensor_noise",
    "panel_overheating",
    "inverter_overheating",
    "grid_voltage_anomaly",
    "power_loss",
}


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _classify_voltage_sensor(nv, fv):
    """Name the voltage-sensor fault from a single (nv, fv) pair.

    The sensor simulator in `dataset/sensor_simulator.py` uses these
    signatures:

      - sensor_dropout: faulty_voltage is None
      - stuck_sensor:   faulty_voltage is pinned near 420 V while the
                        healthy voltage is elsewhere (offset != 0)
      - voltage_bias:   a large constant offset, typically +30 V
      - sensor_noise:   small random jitter within +-15 V
      - voltage_drift:  a modest offset, typically +0.5 .. +5 V

    The simulator does not give us a way to separate drift from noise by
    magnitude alone, so we use magnitude:

      |offset| < 0.3        -> clean
      0.3 <= |offset| < 5   -> voltage_drift
      5 <= |offset| < 20    -> sensor_noise
      |offset| >= 20        -> voltage_bias

    This split is tuned to the generator's own fault functions
    (`inject_voltage_bias` uses +30 V; drift is +0.5..+40 V but is small
    in the early ticks where most labeled drift rows appear).
    """
    if fv is None and nv is not None:
        return ["sensor_dropout"]
    if nv is None or fv is None:
        return []

    offset = fv - nv
    abs_off = abs(offset)

    # stuck sensor: pinned near 420 V while healthy voltage is elsewhere.
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
    """Return the sensor-level fault flags for one CSV row.

    A row can carry more than one flag (e.g. panel_overheating + sensor_noise
    in the same tick). The order is stable so tests can compare against a
    fixed expected list.
    """
    flags: List[str] = []

    nv = _to_float(row.get("normal_voltage"))
    fv = _to_float(row.get("faulty_voltage"))
    current = _to_float(row.get("current"))
    normal_power = _to_float(row.get("normal_power"))
    measured_power = _to_float(row.get("measured_power"))
    panel_t = _to_float(row.get("panel_temperature"))
    inv_t = _to_float(row.get("inverter_temperature"))
    gv = _to_float(row.get("grid_voltage"))

    # --- voltage-sensor faults ---
    flags.extend(_classify_voltage_sensor(nv, fv))

    # --- thermal faults ---
    if panel_t is not None and panel_t > 70.0:
        flags.append("panel_overheating")
    if inv_t is not None and inv_t > 80.0:
        flags.append("inverter_overheating")

    # --- grid-side fault ---
    if gv is not None and (gv < 210.0 or gv > 250.0):
        flags.append("grid_voltage_anomaly")

    # --- power_loss (measured power dropped but voltage is sane) ---
    if (
        normal_power is not None
        and measured_power is not None
        and normal_power > 0
        and measured_power < normal_power * 0.75
        and current is not None
        and nv is not None
    ):
        if not any(f in flags for f in ("sensor_dropout", "voltage_bias", "stuck_sensor")):
            flags.append("power_loss")

    return flags


def classify_dataset(rows) -> List[List[str]]:
    """Run classify_row over an iterable of CSV rows.

    Kept as a thin wrapper so callers can pass any iterable (list, generator,
    csv reader) and get back a list of flag lists.
    """
    rows = list(rows)
    return [classify_row(r) for r in rows]


if __name__ == "__main__":
    import csv
    from collections import Counter
    from pathlib import Path

    csv_path = Path(__file__).parent / "sensor_data.csv"
    with csv_path.open("r", encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))

    predicted = classify_dataset(rows)
    counter: Counter = Counter()
    for flags in predicted:
        if not flags:
            counter["normal"] += 1
        else:
            for f in flags:
                counter[f] += 1

    print("Predicted sensor-fault distribution:")
    for name, count in counter.most_common():
        print(f"  {name:25} {count}")