"""End-to-end validation: CSV -> adapter -> sensor classifier -> AI agent.

This validates the actual bridge, not only the classifier. The script can be
run either as:
    python -m dataset.validate
or:
    python dataset/validate.py
"""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path
import sys

# Support both `python -m dataset.validate` and `python dataset/validate.py`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    from .adapter import row_to_devices
    from .sensor_faults import classify_row
except ImportError:  # direct `python dataset/validate.py`
    from adapter import row_to_devices
    from sensor_faults import classify_row

from ai.agent import diagnose

CSV_PATH = Path(__file__).parent / "sensor_data.csv"

PRIORITY = [
    "sensor_dropout", "stuck_sensor", "voltage_bias", "voltage_drift",
    "sensor_noise", "inverter_overheating", "panel_overheating",
    "grid_voltage_anomaly", "power_loss",
]


def _load_rows(path=CSV_PATH):
    with Path(path).open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def _truth(row):
    return (row.get("fault_type") or "normal").strip() or "normal"


def _primary(flags):
    for name in PRIORITY:
        if name in flags:
            return name
    return "normal"


def _device_for_fault(devices, truth):
    if truth == "inverter_overheating":
        return next(d for d in devices if d["kind"] == "inverter")
    return next(d for d in devices if d["kind"] == "solar")


def run_validation(path=CSV_PATH):
    rows = _load_rows(path)
    if not rows:
        raise RuntimeError("sensor_data.csv is empty")

    counts = Counter()
    mismatches = []
    for row in rows:
        truth = _truth(row)
        devices = row_to_devices(row)
        flags = classify_row(row)
        device = _device_for_fault(devices, truth)

        # A synthetic event is enough to exercise diagnose(); the named-fault
        # result must come from the adapter's flags, not from the label.
        event = {
            "severity": "warning",
            "device_id": device["id"],
            "device_name": device["name"],
            "day": 1,
            "time": row.get("timestamp", ""),
            "message": "dataset validation event",
        }
        diagnosis = diagnose(device, event, device.get("rel"), use_claude=False)
        predicted = diagnosis.get("primary_fault") or "normal"

        counts["total"] += 1
        counts["correct"] += predicted == truth
        counts[f"{truth}:total"] += 1
        counts[f"{truth}:correct"] += predicted == truth

        if predicted != truth and len(mismatches) < 20:
            mismatches.append({
                "timestamp": row.get("timestamp"),
                "truth": truth,
                "classifier": _primary(flags),
                "agent": predicted,
                "flags": flags,
            })

    accuracy = counts["correct"] / counts["total"] if counts["total"] else 0.0

    print("=" * 72)
    print("DATASET -> ADAPTER -> AI AGENT END-TO-END VALIDATION")
    print("=" * 72)
    print(f"Rows tested: {counts['total']}")
    print(f"End-to-end accuracy: {accuracy:.1%}")
    print()
    print(f"{'fault':25} {'correct':>8} {'total':>8} {'accuracy':>10}")
    print("-" * 58)

    faults = sorted({_truth(r) for r in rows})
    for fault in faults:
        total = counts[f"{fault}:total"]
        correct = counts[f"{fault}:correct"]
        print(f"{fault:25} {correct:8d} {total:8d} {correct / total:9.1%}")

    if mismatches:
        print("\nFirst mismatches:")
        for m in mismatches:
            print(m)

    print("=" * 72)
    return {
        "total": counts["total"],
        "correct": counts["correct"],
        "overall_accuracy": round(accuracy * 100, 2),
        "mismatches": mismatches,
    }


if __name__ == "__main__":
    result = run_validation()
    # Non-zero exit below the accuracy floor so CI jobs can guard against regressions.
    FLOOR = 90.0
    if result["overall_accuracy"] < FLOOR:
        raise SystemExit(f"FAIL: end-to-end accuracy {result['overall_accuracy']:.1f}% "
                         f"is below the {FLOOR:.0f}% floor")
    raise SystemExit(0)
