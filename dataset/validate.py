"""Validation: score the AI agent's detections against ground-truth labels.

Runs every row of `dataset/sensor_data.csv` through the adapter and the
sensor-fault classifier, compares the predicted fault set with the labeled
`fault_type` column, and prints:

  - confusion matrix (per fault type: correct / missed / false positives)
  - per-fault accuracy
  - overall accuracy
  - a short list of mismatches for spot-checking

This is the deliverable that proves the dataset bridge works. It is also the
script a CI job would run to guard against regressions.

Pure standard library. No imports from `sim/`, `ai/`, or `web/`.
"""

from __future__ import annotations

import csv
from collections import Counter, defaultdict
from pathlib import Path

from .adapter import row_to_devices
from .sensor_faults import classify_dataset


CSV_PATH = Path(__file__).parent / "sensor_data.csv"


def _load_rows(path: Path = CSV_PATH):
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def _ground_truth(row) -> str:
    """The labeled fault_type for a CSV row ('normal' if unknown)."""
    return (row.get("fault_type") or "normal").strip()


def _predicted_primary(flags) -> str:
    """Pick one predicted label per row for confusion-matrix scoring.

    Priority (most specific first):
      sensor_dropout > stuck_sensor > voltage_bias > voltage_drift >
      sensor_noise > inverter_overheating > panel_overheating >
      grid_voltage_anomaly > power_loss > normal
    """
    priority = [
        "sensor_dropout",
        "stuck_sensor",
        "voltage_bias",
        "voltage_drift",
        "sensor_noise",
        "inverter_overheating",
        "panel_overheating",
        "grid_voltage_anomaly",
        "power_loss",
    ]
    for name in priority:
        if name in flags:
            return name
    return "normal"


def _adapter_smoke_test(rows, sample: int = 5) -> None:
    """Sanity-check the adapter on a few rows and print the mapping."""
    print("\nADAPTER SMOKE TEST (first {} rows)".format(sample))
    print("-" * 60)
    for row in rows[:sample]:
        devices = row_to_devices(row)
        truth = _ground_truth(row)
        print(f"  {row['timestamp']}  truth={truth:22}  devices={[d['id'] for d in devices]}")


def run_validation() -> dict:
    rows = _load_rows()
    if not rows:
        print("ERROR: sensor_data.csv is empty or missing.")
        return {}

    _adapter_smoke_test(rows)

    # ---- classify all rows ----
    predictions = classify_dataset(rows)

    # ---- score ----
    per_fault_total = Counter()
    per_fault_correct = Counter()
    confusion = defaultdict(Counter)  # truth -> predicted -> count
    mismatches = []

    for row, flags in zip(rows, predictions):
        truth = _ground_truth(row)
        pred = _predicted_primary(flags)
        per_fault_total[truth] += 1
        confusion[truth][pred] += 1
        if pred == truth:
            per_fault_correct[truth] += 1
        elif len(mismatches) < 12:
            mismatches.append({
                "ts": row["timestamp"],
                "truth": truth,
                "pred": pred,
                "flags": flags,
                "faulty_v": row.get("faulty_voltage"),
                "normal_v": row.get("normal_voltage"),
            })

    # ---- print report ----
    print("\n" + "=" * 60)
    print("DATASET BRIDGE — VALIDATION vs GROUND TRUTH")
    print("=" * 60)

    print("\nPER-FAULT ACCURACY")
    print("-" * 60)
    print(f"  {'fault_type':25} {'correct':>8} {'total':>8} {'acc':>8}")
    for fault in sorted(per_fault_total):
        total = per_fault_total[fault]
        correct = per_fault_correct[fault]
        acc = (correct / total * 100) if total else 0.0
        print(f"  {fault:25} {correct:8d} {total:8d} {acc:7.1f}%")

    total = sum(per_fault_total.values())
    correct = sum(per_fault_correct.values())
    overall = (correct / total * 100) if total else 0.0
    print("-" * 60)
    print(f"  {'OVERALL':25} {correct:8d} {total:8d} {overall:7.1f}%")

    # ---- confusion matrix (only interesting cells) ----
    print("\nCONFUSION MATRIX (truth -> predicted)")
    print("-" * 60)
    for truth in sorted(confusion):
        preds = confusion[truth]
        top = preds.most_common(3)
        parts = ", ".join(f"{p}={c}" for p, c in top)
        print(f"  {truth:25} -> {parts}")

    # ---- sample mismatches ----
    if mismatches:
        print("\nSAMPLE MISMATCHES (first 12)")
        print("-" * 60)
        for m in mismatches:
            print(
                f"  {m['ts']}  truth={m['truth']:22}  pred={m['pred']:22}  "
                f"nv={m['normal_v']:>7}  fv={m['faulty_v']:>7}  flags={m['flags']}"
            )

    print("\n" + "=" * 60)
    print(f"Validation complete.  Overall accuracy: {overall:.1f}%")
    print("=" * 60)

    return {
        "total": total,
        "correct": correct,
        "overall_accuracy": round(overall, 2),
        "per_fault": {
            k: {
                "correct": per_fault_correct[k],
                "total": per_fault_total[k],
                "accuracy": round(
                    (per_fault_correct[k] / per_fault_total[k] * 100)
                    if per_fault_total[k] else 0.0, 2
                ),
            }
            for k in per_fault_total
        },
    }


if __name__ == "__main__":
    run_validation()