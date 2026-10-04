"""Adapter: Ali's sensor CSV -> the platform's device-shaped telemetry.

Important unit contract:
  CSV normal_power/measured_power are watts.
  Platform device actual/expected/rating are kW.

Missing measured_power stays missing (None); it is never silently replaced
with normal_power, so sensor_dropout remains diagnosable.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

try:
    from .sensor_faults import classify_row
except ImportError:  # direct `python dataset/adapter.py`
    from sensor_faults import classify_row

CSV_PATH = Path(__file__).parent / "sensor_data.csv"
HEALTHY_ETA = 0.97
SOLAR_RATING_KW = 8.0
INVERTER_RATING_KW = 8.0


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def row_to_devices(row: Dict[str, str]) -> List[Dict[str, Any]]:
    normal_w = _to_float(row.get("normal_power"))
    measured_w = _to_float(row.get("measured_power"))
    irradiance = _to_float(row.get("irradiance"))
    panel_t = _to_float(row.get("panel_temperature"))
    inv_t = _to_float(row.get("inverter_temperature"))
    grid_v = _to_float(row.get("grid_voltage"))
    flags = classify_row(row)

    expected_kw = normal_w / 1000.0 if normal_w is not None else None
    actual_kw = measured_w / 1000.0 if measured_w is not None else None

    if expected_kw is not None and actual_kw is not None:
        solar_rel = (actual_kw - expected_kw) / max(expected_kw, 1.0)
    else:
        solar_rel = None

    inv_expected = expected_kw * HEALTHY_ETA if expected_kw is not None else None
    inv_actual = actual_kw * HEALTHY_ETA if actual_kw is not None else None
    if inv_expected is not None and inv_actual is not None:
        inv_rel = (inv_actual - inv_expected) / max(inv_expected, 1.0)
    else:
        inv_rel = None

    common_extra = {
        "ghi": round((irradiance or 0.0) / 1000.0, 3),
        "cell_temp": round(panel_t, 1) if panel_t is not None else None,
        "grid_voltage": round(grid_v, 1) if grid_v is not None else None,
        "sensor_flags": flags,
        "source": "ali_sensor_dataset",
        "timestamp": row.get("timestamp"),
        "measured_power_available": measured_w is not None,
    }

    solar = {
        "id": "solar",
        "name": "Solar Array",
        "kind": "solar",
        "rating": SOLAR_RATING_KW,
        "expected": round(expected_kw, 3) if expected_kw is not None else None,
        "actual": round(actual_kw, 3) if actual_kw is not None else None,
        "rel": round(solar_rel, 4) if solar_rel is not None else None,
        "status": "ok",
        "extra": dict(common_extra),
    }

    inverter_extra = dict(common_extra)
    inverter_extra.update({
        "dc_in": round(actual_kw, 3) if actual_kw is not None else None,
        "efficiency": HEALTHY_ETA,
        "inverter_temperature": round(inv_t, 1) if inv_t is not None else None,
    })

    inverter = {
        "id": "inverter",
        "name": "Inverter",
        "kind": "inverter",
        "rating": INVERTER_RATING_KW,
        "expected": round(inv_expected, 3) if inv_expected is not None else None,
        "actual": round(inv_actual, 3) if inv_actual is not None else None,
        "rel": round(inv_rel, 4) if inv_rel is not None else None,
        "status": "ok",
        "extra": inverter_extra,
    }
    return [solar, inverter]


def load_csv(path: Path | str = CSV_PATH) -> Iterator[Dict[str, str]]:
    with Path(path).open("r", encoding="utf-8", newline="") as fh:
        yield from csv.DictReader(fh)


def load_devices(path: Path | str = CSV_PATH) -> Iterator[Dict[str, Any]]:
    for row in load_csv(path):
        yield from row_to_devices(row)


if __name__ == "__main__":
    import json
    for i, dev in enumerate(load_devices()):
        if i >= 6:
            break
        print(json.dumps(dev, indent=2))
