"""Actionable recommendations built from anomalies and sensor state."""

from __future__ import annotations

SENSOR_ACTIONS = {
    "sensor_dropout": "Inspect sensor wiring/connector and the data-acquisition channel before dispatching equipment maintenance.",
    "stuck_sensor": "Verify the sensor responds to a known change; power-cycle the channel and replace it if it remains fixed.",
    "voltage_bias": "Cross-check against a calibrated reference meter and recalibrate the voltage transducer.",
    "voltage_drift": "Trend the voltage offset for 24 hours and recalibrate if the offset continues to grow.",
    "sensor_noise": "Inspect grounding, shielding and nearby electrical interference before treating the equipment as faulty.",
    "grid_voltage_anomaly": "Check the utility/grid side and inverter protection settings.",
}

EQUIPMENT_ACTIONS = {
    "hvac": "Inspect filters, coils, refrigerant charge and compressor current.",
    "lighting": "Check schedules, overrides, occupancy sensors and relays.",
    "plugs": "Audit after-hours loads and isolate phantom/standby loads.",
    "solar": "Inspect for soiling, shading, string faults and hotspots.",
    "inverter": "Inspect cooling, DC terminations, MPPT behavior and inverter diagnostics.",
}


def recommendations(snapshot, ranked_events):
    devices = {d["id"]: d for d in snapshot.get("devices", [])}
    out = []
    for event in ranked_events:
        device = devices.get(event.get("device_id"), {})
        flags = (device.get("extra") or {}).get("sensor_flags") or []
        sensor_flag = next((f for f in flags if f in SENSOR_ACTIONS), None)
        if sensor_flag:
            action = SENSOR_ACTIONS[sensor_flag]
            mode = "sensor"
            reason = f"Sensor issue '{sensor_flag}' should be ruled out before equipment maintenance."
        else:
            kind = device.get("kind")
            action = EQUIPMENT_ACTIONS.get(kind, "Inspect the asset and compare telemetry with the healthy baseline.")
            mode = "equipment"
            reason = "The deviation is associated with equipment behavior rather than a known sensor flag."
        out.append({
            "priority": "HIGH" if event["priority_score"] >= 70 else "MEDIUM" if event["priority_score"] >= 40 else "LOW",
            "priority_score": event["priority_score"],
            "device_id": event.get("device_id"),
            "device_name": event.get("device_name"),
            "fault_mode": mode,
            "reason": reason,
            "action": action,
            "impact_kw": event.get("impact_kw", 0.0),
        })
    return out
