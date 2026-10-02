"""Adapter: Ali's sensor-level PV dataset -> device-shaped input for ai/.

The `dataset/sensor_data.csv` file contains second-by-second sensor-level
telemetry from a grid-tied PV system, with 10 labeled fault types
(voltage_bias, sensor_dropout, stuck_sensor, ...).

The platform's `ai/anomaly.py` and `ai/agent.py` expect device-shaped input
({id, name, kind, rating, actual, expected, ...}). This module bridges the two.

It maps each CSV row to TWO pseudo-devices:

  - "solar":    the DC side of the array. expected = normal_power,
                actual = measured_power. Sensor-fault flags from the CSV
                (voltage_bias, dropout, stuck, drift, noise) are attached
                as `sensor_flags` in `extra` so `ai/agent.py` can name them.
  - "inverter": the AC side. expected = normal_power * healthy_eta,
                actual = measured_power * healthy_eta. Thermal state comes
                from inverter_temperature + inverter_status.

Pure standard library. No imports from `sim/`, `ai/`, or `web/`.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional


# ---------------------------------------------------------------
# Constants tuned to the csv schema in dataset/sensor_data.csv
# ---------------------------------------------------------------

CSV_PATH = Path(__file__).parent / "sensor_data.csv"

# Healthy inverter efficiency assumed by sim/engine.py (Inverter.HEALTHY_ETA).
HEALTHY_ETA = 0.97

# Solar array rating implied by Ali's simulator (normal_power ≈ 400V * 17A).
SOLAR_RATING_KW = 8.0
INVERTER_RATING_KW = 8.0

# Noise floors used by the detector's relative-residual math.
SOLAR_REL_FLOOR = 1.0
INVERTER_REL_FLOOR = 1.0


def _to_float(value: Any) -> Optional[float]:
    """Convert a CSV cell to float, or None if missing/empty."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sensor_flags(row: Dict[str, str]) -> List[str]:
    """Derive sensor-level fault hints from a single CSV row.

    These do not fire the anomaly detector by themselves; they are passed
    through `extra.sensor_flags` so `ai/agent.py` can name the signature
    (bias / drift / dropout / stuck / noise) instead of falling back to
    "unknown deviation".
    """
    flags: List[str] = []
    nv = _to_float(row.get("normal_voltage"))
    fv = _to_float(row.get("faulty_voltage"))

    # sensor_dropout -> faulty_voltage is empty
    if fv is None and nv is not None:
        flags.append("sensor_dropout")
        return flags  # no further comparisons possible

    if nv is not None and fv is not None:
        offset = fv - nv
        # stuck_sensor -> the simulator pins faulty_voltage at exactly 420 V
        if abs(fv - 420.0) < 0.01 and abs(nv - 420.0) > 0.5:
            flags.append("stuck_sensor")
        # voltage_bias -> a large, roughly-constant offset (usually +30 V)
        elif abs(offset) >= 20.0:
            flags.append("voltage_bias")
        # voltage_drift -> a modest offset (usually +0.5 .. +5 V)
        elif 0.3 <= abs(offset) < 20.0:
            flags.append("voltage_drift")
        # sensor_noise -> small random jitter (< ±15 V)
        elif 0.0 < abs(offset) < 0.3:
            flags.append("sensor_noise")

    # thermal faults
    panel_t = _to_float(row.get("panel_temperature"))
    if panel_t is not None and panel_t > 70.0:
        flags.append("panel_overheating")

    inv_t = _to_float(row.get("inverter_temperature"))
    if inv_t is not None and inv_t > 80.0:
        flags.append("inverter_overheating")

    # grid-side
    gv = _to_float(row.get("grid_voltage"))
    if gv is not None and (gv < 210.0 or gv > 250.0):
        flags.append("grid_voltage_anomaly")

    return flags


def row_to_devices(row: Dict[str, str]) -> List[Dict[str, Any]]:
    """Convert one CSV row into two device-shaped dicts (solar, inverter).

    Output shape matches what `ai/anomaly.py` + `ai/agent.py` already read:

        {
          "id": "solar", "name": "Solar Array", "kind": "solar",
          "rating": 8.0,
          "expected": 6500.0, "actual": 6500.0,   # watts
          "rel": 0.0, "status": "ok",
          "extra": {"ghi": ..., "sensor_flags": [...]}
        }
    """
    normal_power = _to_float(row.get("normal_power")) or 0.0
    measured_power = _to_float(row.get("measured_power")) or 0.0
    irradiance = _to_float(row.get("irradiance")) or 0.0
    panel_t = _to_float(row.get("panel_temperature")) or 0.0

    flags = _sensor_flags(row)

    # --- solar side ---
    solar_expected = normal_power
    solar_actual = measured_power if measured_power > 0 else normal_power
    solar_rel = (
        (solar_actual - solar_expected) / max(solar_expected, 1.0)
        if (solar_expected > 0 or solar_actual > 0)
        else 0.0
    )
    solar = {
        "id": "solar",
        "name": "Solar Array",
        "kind": "solar",
        "rating": SOLAR_RATING_KW,
        "expected": round(solar_expected, 1),
        "actual": round(solar_actual, 1),
        "rel": round(solar_rel, 4),
        "status": "ok",
        "extra": {
            "ghi": round(irradiance / 1000.0, 3),   # normalised 0..1
            "cell_temp": round(panel_t, 1),
            "sensor_flags": flags,
        },
    }

    # --- inverter side ---
    inv_expected = normal_power * HEALTHY_ETA
    inv_actual = (measured_power if measured_power > 0 else normal_power) * HEALTHY_ETA
    inv_rel = (
        (inv_actual - inv_expected) / max(inv_expected, 1.0)
        if (inv_expected > 0 or inv_actual > 0)
        else 0.0
    )
    inverter = {
        "id": "inverter",
        "name": "Inverter",
        "kind": "inverter",
        "rating": INVERTER_RATING_KW,
        "expected": round(inv_expected, 1),
        "actual": round(inv_actual, 1),
        "rel": round(inv_rel, 4),
        "status": "ok",
        "extra": {
            "dc_in": round(solar_actual / 1000.0, 3),
            "efficiency": HEALTHY_ETA,
            "sensor_flags": flags,
        },
    }

    return [solar, inverter]


# ---------------------------------------------------------------
# CSV streaming helpers
# ---------------------------------------------------------------


def load_csv(path: Path | str = CSV_PATH) -> Iterator[Dict[str, str]]:
    """Yield each row of the CSV as a dict of strings."""
    path = Path(path)
    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            yield row


def load_devices(path: Path | str = CSV_PATH) -> Iterator[Dict[str, Any]]:
    """Yield every device-shaped dict derived from the CSV.

    For each CSV row this yields two dicts (solar, inverter) in that order.
    """
    for row in load_csv(path):
        for dev in row_to_devices(row):
            yield dev


if __name__ == "__main__":
    # Tiny smoke test: print the first 3 CSV rows as device dicts.
    import json

    for i, dev in enumerate(load_devices()):
        if i >= 6:  # 3 rows * 2 devices
            break
        print(json.dumps(dev, indent=2))