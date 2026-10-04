"""Fault prioritization and intelligence scoring."""

from __future__ import annotations

SEVERITY_WEIGHT = {"critical": 100, "serious": 70, "warning": 40, "operator": 0}


def priority_score(event, device=None):
    severity = SEVERITY_WEIGHT.get(event.get("severity"), 20)
    impact = 0.0
    if device:
        actual = device.get("actual")
        expected = device.get("expected")
        if actual is not None and expected is not None and expected:
            impact = min(100.0, abs(float(actual) - float(expected)) / float(expected) * 100.0)
    duration = float(event.get("duration_minutes") or 1.0)
    duration_factor = min(2.0, 1.0 + duration / 60.0)
    score = (severity * 0.55 + impact * 0.45) * duration_factor
    return round(min(100.0, score), 1)


def rank_events(snapshot):
    devices = {d["id"]: d for d in snapshot.get("devices", [])}
    ranked = []
    for event in snapshot.get("anomalies", []):
        device = devices.get(event.get("device_id"))
        item = dict(event)
        item["priority_score"] = priority_score(event, device)
        item["impact_kw"] = round(
            abs(float(device.get("actual") or 0) - float(device.get("expected") or 0)), 2
        ) if device else 0.0
        ranked.append(item)
    ranked.sort(key=lambda x: x["priority_score"], reverse=True)
    return ranked
