"""Human-readable and JSON-safe daily intelligence reports."""

from __future__ import annotations


def daily_report(snapshot, metrics, ranked_events, recommendations):
    critical = sum(1 for e in ranked_events if e.get("severity") == "critical")
    serious = sum(1 for e in ranked_events if e.get("severity") == "serious")
    score = metrics["health_score"]
    status = "HEALTHY" if score >= 85 and not critical else "ATTENTION REQUIRED" if score >= 65 else "HIGH RISK"

    top = ranked_events[:3]
    top_issues = [{
        "device": e.get("device_name"),
        "severity": e.get("severity"),
        "message": e.get("message"),
        "priority_score": e.get("priority_score"),
        "impact_kw": e.get("impact_kw"),
    } for e in top]

    return {
        "status": status,
        "summary": (
            f"Energy health is {score}/100. "
            f"{len(ranked_events)} active anomaly/anomalies are being monitored, "
            f"including {critical} critical and {serious} serious event(s)."
        ),
        "health_score": score,
        "energy": metrics["today"],
        "waste": {
            "instantaneous_kw": metrics["instantaneous_waste_kw"],
            "projected_daily_kwh": metrics["projected_daily_waste_kwh"],
            "projected_daily_cost": metrics["projected_daily_waste_cost"],
            "projected_daily_co2_kg": metrics["projected_daily_waste_co2_kg"],
        },
        "production_loss": {
            "instantaneous_kw": metrics["instantaneous_production_loss_kw"],
            "projected_daily_kwh": metrics["projected_daily_production_loss_kwh"],
        },
        "top_issues": top_issues,
        "recommendations": recommendations[:5],
        "sim": snapshot.get("sim", {}),
    }


def savings_scenario(snapshot, device_id=None, reduction_pct=100.0, hours=8.0,
                     electricity_rate=0.15, grid_co2_kg_per_kwh=0.40):
    devices = snapshot.get("devices", [])
    targets = [d for d in devices if device_id is None or d.get("id") == device_id]
    excess_kw = 0.0
    for d in targets:
        if d.get("kind") in ("solar", "inverter"):
            continue
        actual, expected = d.get("actual"), d.get("expected")
        if actual is not None and expected is not None:
            excess_kw += max(0.0, float(actual) - float(expected))
    reduction = max(0.0, min(100.0, float(reduction_pct))) / 100.0
    saved_kw = excess_kw * reduction
    daily_kwh = saved_kw * max(0.0, float(hours))
    monthly_kwh = daily_kwh * 30.0
    return {
        "device_id": device_id,
        "current_excess_kw": round(excess_kw, 2),
        "reduction_pct": round(reduction * 100.0, 1),
        "operating_hours": round(float(hours), 1),
        "daily_savings_kwh": round(daily_kwh, 2),
        "monthly_savings_kwh": round(monthly_kwh, 2),
        "monthly_cost_savings": round(monthly_kwh * electricity_rate, 2),
        "monthly_co2_reduction_kg": round(monthly_kwh * grid_co2_kg_per_kwh, 2),
    }
