"""Deterministic energy, cost, carbon and reliability metrics.

All power values in the platform are kW and all accumulated energy values are kWh.
"""

from __future__ import annotations

DEFAULT_ELECTRICITY_RATE = 0.15
DEFAULT_GRID_CO2_KG_PER_KWH = 0.40


def clamp(value, lo=0.0, hi=100.0):
    return max(lo, min(hi, float(value)))


def pct(value):
    return round(clamp(value * 100.0), 1)


def device_waste_kw(device):
    """Positive excess consumption only; production devices use loss instead."""
    if device.get("kind") in ("solar", "inverter"):
        return 0.0
    actual = device.get("actual")
    expected = device.get("expected")
    if actual is None or expected is None:
        return 0.0
    return max(0.0, float(actual) - float(expected))


def device_production_loss_kw(device):
    """Positive loss for generation/output devices."""
    if device.get("kind") not in ("solar", "inverter"):
        return 0.0
    actual = device.get("actual")
    expected = device.get("expected")
    if actual is None or expected is None:
        return 0.0
    return max(0.0, float(expected) - float(actual))


def energy_efficiency_score(devices):
    """100 means all consuming devices are at/below their expected demand."""
    consumers = [d for d in devices if d.get("kind") not in ("solar", "inverter")]
    if not consumers:
        return 100.0
    ratios = []
    for d in consumers:
        e = float(d.get("expected") or 0.0)
        a = d.get("actual")
        if e <= 0 or a is None:
            continue
        ratios.append(max(0.0, min(1.0, 1.0 - max(0.0, float(a) - e) / e)))
    return round(sum(ratios) / len(ratios) * 100.0, 1) if ratios else 100.0


def equipment_health_score(devices):
    if not devices:
        return 100.0
    weights = {"critical": 0.0, "serious": 35.0, "warning": 70.0, "ok": 100.0}
    values = [weights.get(d.get("status"), 100.0) for d in devices]
    return round(sum(values) / len(values), 1)


def renewable_utilization(snapshot):
    today = snapshot.get("kpis", {}).get("today", {})
    load = float(today.get("load_kwh") or 0.0)
    solar = float(today.get("solar_kwh") or 0.0)
    if load <= 0:
        return 100.0
    return round(clamp(solar / load * 100.0), 1)


def grid_dependence(snapshot):
    today = snapshot.get("kpis", {}).get("today", {})
    load = float(today.get("load_kwh") or 0.0)
    imported = float(today.get("import_kwh") or 0.0)
    if load <= 0:
        return 0.0
    # 100 = no grid dependence, 0 = fully grid supplied.
    return round(clamp(100.0 - imported / load * 100.0), 1)


def sensor_health_score(devices):
    """Separate sensor confidence from equipment health.

    The PR's dataset adapter puts sensor flags in extra.sensor_flags.
    """
    penalties = {
        "sensor_dropout": 35,
        "stuck_sensor": 25,
        "voltage_bias": 20,
        "voltage_drift": 15,
        "sensor_noise": 10,
        "grid_voltage_anomaly": 8,
    }
    scores = []
    for d in devices:
        score = 100.0
        for flag in (d.get("extra") or {}).get("sensor_flags") or []:
            score -= penalties.get(flag, 0)
        scores.append(clamp(score))
    return round(sum(scores) / len(scores), 1) if scores else 100.0


def calculate(snapshot, electricity_rate=DEFAULT_ELECTRICITY_RATE,
              grid_co2_kg_per_kwh=DEFAULT_GRID_CO2_KG_PER_KWH):
    devices = snapshot.get("devices", [])
    waste_kw = sum(device_waste_kw(d) for d in devices)
    production_loss_kw = sum(device_production_loss_kw(d) for d in devices)

    # Simulation advances speed minutes each tick. For a snapshot-level
    # instantaneous estimate, project the current excess over 24 hours.
    projected_daily_waste_kwh = round(waste_kw * 24.0, 2)
    projected_daily_loss_kwh = round(production_loss_kw * 24.0, 2)

    health = {
        "efficiency": energy_efficiency_score(devices),
        "equipment": equipment_health_score(devices),
        "renewable": renewable_utilization(snapshot),
        "grid": grid_dependence(snapshot),
        "sensors": sensor_health_score(devices),
    }

    # Sensor health is deliberately included but cannot dominate equipment health.
    overall = round(
        health["efficiency"] * 0.30
        + health["equipment"] * 0.25
        + health["renewable"] * 0.20
        + health["grid"] * 0.15
        + health["sensors"] * 0.10,
        1,
    )

    today = snapshot.get("kpis", {}).get("today", {})
    waste_cost = round(projected_daily_waste_kwh * electricity_rate, 2)
    waste_co2 = round(projected_daily_waste_kwh * grid_co2_kg_per_kwh, 2)

    return {
        "health_score": overall,
        "health_components": health,
        "instantaneous_waste_kw": round(waste_kw, 2),
        "instantaneous_production_loss_kw": round(production_loss_kw, 2),
        "projected_daily_waste_kwh": projected_daily_waste_kwh,
        "projected_daily_production_loss_kwh": projected_daily_loss_kwh,
        "projected_daily_waste_cost": waste_cost,
        "projected_daily_waste_co2_kg": waste_co2,
        "today": {
            "solar_kwh": round(float(today.get("solar_kwh") or 0), 2),
            "load_kwh": round(float(today.get("load_kwh") or 0), 2),
            "import_kwh": round(float(today.get("import_kwh") or 0), 2),
            "export_kwh": round(float(today.get("export_kwh") or 0), 2),
        },
        "tariff": electricity_rate,
        "grid_co2_kg_per_kwh": grid_co2_kg_per_kwh,
    }
