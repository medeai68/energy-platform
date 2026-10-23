"""AI diagnostic agent: equipment rules + labeled sensor-fault rules.

Sensor flags are handled BEFORE the residual/noise-band early exit. This is
critical because bias/drift/dropout/stuck/noise faults may leave power nearly
unchanged. The returned diagnosis includes machine-readable detected_faults
so validation can test the real dataset -> adapter -> agent path.
"""

import json

RULE_SETS = {
    ("solar", "lo"): [
        {"cause": "Soiling / dust accumulation", "confidence": 0.65,
         "actions": ["Schedule panel cleaning; compare with a nearby clean reference panel",
                     "Review cleaning log - if last wash > 30 days ago, soiling is likely"]},
        {"cause": "Partial shading", "confidence": 0.55,
         "actions": ["Inspect for new shading sources", "Review shading around sunrise/sunset"]},
        {"cause": "Panel / string failure", "confidence": 0.45,
         "actions": ["Run a string-level IV-curve or IR thermal scan",
                     "Compare per-string currents in the inverter portal"]},
    ],
    ("inverter", "lo"): [
        {"cause": "Overheating / poor airflow", "confidence": 0.60,
         "actions": ["Clean the heat sink and air filters",
                     "Check inverter temperature and clearance"]},
        {"cause": "Power-stage degradation", "confidence": 0.55,
         "actions": ["Run a manufacturer power-stage diagnostic",
                     "Plan preventive replacement if efficiency keeps drifting"]},
        {"cause": "DC-side issue", "confidence": 0.45,
         "actions": ["Thermal-scan DC terminations", "Verify DC input against array output"]},
    ],
    ("inverter", "hi"): [
        {"cause": "Sensor offset or meter calibration drift", "confidence": 0.50,
         "actions": ["Cross-check inverter CT readings against the utility meter"]},
    ],
    ("hvac", "hi"): [
        {"cause": "Refrigerant leak", "confidence": 0.70,
         "actions": ["Check refrigerant charge and leak-test the circuit",
                     "Repair the leak and recharge to manufacturer specification"]},
        {"cause": "Dirty condenser / evaporator coils", "confidence": 0.60,
         "actions": ["Clean coils and replace clogged filters"]},
        {"cause": "Duct leakage or stuck damper", "confidence": 0.50,
         "actions": ["Inspect ducts and verify zone dampers"]},
        {"cause": "Failing compressor", "confidence": 0.45,
         "actions": ["Measure compressor current against nameplate",
                     "Schedule maintenance if the trend worsens"]},
    ],
    ("hvac", "lo"): [
        {"cause": "Unit tripped offline", "confidence": 0.60,
         "actions": ["Check breakers and unit error codes", "Reset and monitor for re-trip"]},
        {"cause": "Thermostat schedule/setpoint change", "confidence": 0.50,
         "actions": ["Compare thermostat setpoints against the baseline"]},
    ],
    ("lighting", "hi"): [
        {"cause": "Schedule error or stuck relay", "confidence": 0.85,
         "actions": ["Verify BMS schedule and overrides", "Inspect contactor/relay"]},
        {"cause": "Occupancy sensor fault", "confidence": 0.55,
         "actions": ["Test occupancy sensors and wiring"]},
    ],
    ("plugs", "hi"): [
        {"cause": "Equipment left running after hours", "confidence": 0.70,
         "actions": ["Audit night-time plug loads", "Add schedule-based shutdown"]},
        {"cause": "Faulty power supply / phantom load", "confidence": 0.55,
         "actions": ["Meter individual circuits", "Replace aging power supplies"]},
    ],
    ("panel", "lo"): [
        {"cause": "Cracked cells or hot spot", "confidence": 0.65,
         "actions": ["Run an IR thermal scan of the panel",
                     "Compare the panel's IV curve against a neighbouring module"]},
        {"cause": "Connector (MC4) or cabling fault", "confidence": 0.60,
         "actions": ["Inspect connectors for corrosion or arcing",
                     "Measure string current at the panel junction box"]},
        {"cause": "Localised shading or soiling", "confidence": 0.50,
         "actions": ["Inspect the panel for obstructions or heavy dust",
                     "Clean the panel and re-check output after a full sun cycle"]},
    ],
    ("fcu", "hi"): [
        {"cause": "Dirty coil or clogged filter", "confidence": 0.70,
         "actions": ["Clean the coil and replace filters",
                     "Check supply-air temperature against setpoint"]},
        {"cause": "Refrigerant undercharge", "confidence": 0.55,
         "actions": ["Check refrigerant charge and leak-test the circuit",
                     "Recharge to manufacturer specification"]},
        {"cause": "Fan motor bearing wear", "confidence": 0.50,
         "actions": ["Measure fan motor current against nameplate",
                     "Lubricate or replace the motor"]},
    ],
    ("fcu", "lo"): [
        {"cause": "Unit tripped offline", "confidence": 0.60,
         "actions": ["Check breakers and unit error codes",
                     "Reset and monitor for re-trip"]},
        {"cause": "Zone damper closed or setpoint change", "confidence": 0.50,
         "actions": ["Verify zone dampers and thermostat setpoints",
                     "Compare against the baseline schedule"]},
    ],
    ("room_light", "hi"): [
        {"cause": "Schedule error or stuck relay", "confidence": 0.85,
         "actions": ["Verify the BMS schedule and overrides for this room",
                     "Inspect the lighting contactor/relay"]},
        {"cause": "Occupancy sensor fault", "confidence": 0.55,
         "actions": ["Test the room's occupancy sensor and wiring",
                     "Check the sensor time-out setting"]},
    ],
    ("room_plugs", "hi"): [
        {"cause": "Equipment left running after hours", "confidence": 0.70,
         "actions": ["Audit night-time plug loads in the room",
                     "Add schedule-based shutdown for workstations"]},
        {"cause": "Overloaded circuit or extra equipment", "confidence": 0.55,
         "actions": ["Meter the circuit and compare to nameplate",
                     "Redistribute loads across circuits"]},
        {"cause": "Faulty power supply / phantom load", "confidence": 0.50,
         "actions": ["Meter individual devices", "Replace aging power supplies"]},
    ],
    ("elevator", "hi"): [
        {"cause": "Cab standby heater stuck on", "confidence": 0.70,
         "actions": ["Check the cab heater thermostat",
                     "Verify night setback control"]},
        {"cause": "Braking energy recovery failure", "confidence": 0.55,
         "actions": ["Inspect the regenerative drive module",
                     "Review drive error logs"]},
        {"cause": "Unusual traffic pattern", "confidence": 0.45,
         "actions": ["Compare usage against the weekly baseline",
                     "Check for after-hours access events"]},
    ],
    ("elevator", "lo"): [
        {"cause": "Drive offline or maintenance mode", "confidence": 0.60,
         "actions": ["Check the controller status and error codes",
                     "Verify the maintenance switch position"]},
    ],
    ("server_ups", "hi"): [
        {"cause": "Battery degradation (trickle charging)", "confidence": 0.75,
         "actions": ["Run a battery health test",
                     "Plan battery string replacement"]},
        {"cause": "Cooling fan failure", "confidence": 0.55,
         "actions": ["Check rack airflow and fan status",
                     "Verify room temperature against design"]},
    ],
    ("ev_charger", "hi"): [
        {"cause": "Unscheduled charging session", "confidence": 0.70,
         "actions": ["Check the session log against the schedule",
                     "Enable schedule enforcement on the charger"]},
        {"cause": "Meter / CT drift", "confidence": 0.50,
         "actions": ["Cross-check charger CT readings against the utility meter"]},
    ],
    ("ev_charger", "lo"): [
        {"cause": "Charger derated by protection logic", "confidence": 0.60,
         "actions": ["Check the charger cooling and connector temperature",
                     "Review the derating event log"]},
        {"cause": "Vehicle charging limit", "confidence": 0.45,
         "actions": ["Compare against the vehicle's charge curve",
                     "Test with a second vehicle"]},
    ],
    ("water_heater", "hi"): [
        {"cause": "Hot water leak", "confidence": 0.70,
         "actions": ["Inspect piping and fittings for leaks",
                     "Watch the heater's reheat cycle frequency"]},
        {"cause": "Stuck thermostat / heating element", "confidence": 0.60,
         "actions": ["Test the thermostat contacts",
                     "Replace the element if it stays energised"]},
    ],
}

DEFAULT_CAUSES = [{
    "cause": "Unknown deviation - signature not in the knowledge base",
    "confidence": 0.4,
    "actions": ["Collect high-resolution data and inspect manually",
                "Compare against the expected model to rule out model error"],
}]

RULE_SETS[("battery_storage", "lo")] = [
    {"cause": "Reduced usable capacity (aged cells)", "confidence": 0.65,
     "actions": ["Run a capacity test and compare against nameplate",
                 "Plan cell replacement if capacity stays under 80%"]},
    {"cause": "Charging fault / BMS refusal", "confidence": 0.55,
     "actions": ["Check the charge controller and BMS error codes",
                 "Verify DC wiring and the battery breaker"]},
]
RULE_SETS[("battery_storage", "hi")] = [
    {"cause": "Metering error or unexpected charge window", "confidence": 0.50,
     "actions": ["Verify the storage meter against the BMS reading",
                 "Review the charge schedule and grid signals"]},
]

NOUN = {"solar": "generation", "inverter": "output", "panel": "generation",
        "battery_storage": "charge/discharge flow"}

SENSOR_PRIORITY = [
    "sensor_dropout", "stuck_sensor", "voltage_bias", "voltage_drift",
    "sensor_noise", "inverter_overheating", "panel_overheating",
    "grid_voltage_anomaly", "power_loss",
]

SENSOR_RULES = {
    "sensor_drift": [{
        "cause": "Sensor drift / calibration offset (measurement only — the equipment may be healthy)", "confidence": 0.85,
        "actions": ["Cross-check the reading against an independent reference meter",
                    "Re-calibrate or replace the power transducer",
                    "Verify signal wiring and the DAQ channel"]}],
    "sensor_stuck": [{
        "cause": "Stuck sensor (the reading froze — the equipment may be healthy)", "confidence": 0.85,
        "actions": ["Power-cycle the sensor / DAQ channel",
                    "Verify the response to a known load change",
                    "Replace the sensor if it remains fixed"]}],
    "voltage_bias": [{
        "cause": "Voltage sensor bias / calibration offset", "confidence": 0.85,
        "actions": ["Cross-check against a calibrated reference meter",
                    "Re-calibrate or replace the voltage transducer",
                    "Verify signal wiring"]}],
    "voltage_drift": [{
        "cause": "Voltage sensor drift over time", "confidence": 0.70,
        "actions": ["Trend the offset over 24 hours", "Re-calibrate the sensor",
                    "Compare against an independent voltage reading"]}],
    "sensor_dropout": [{
        "cause": "Voltage sensor dropout (missing reading)", "confidence": 0.90,
        "actions": ["Inspect sensor wiring and connector",
                    "Check the data-acquisition channel",
                    "Replace the sensor if dropout persists"]}],
    "stuck_sensor": [{
        "cause": "Stuck voltage sensor", "confidence": 0.85,
        "actions": ["Power-cycle the sensor/DAQ channel",
                    "Verify response to a known voltage change",
                    "Replace the sensor if it remains fixed"]}],
    "sensor_noise": [{
        "cause": "Voltage sensor noise / jitter", "confidence": 0.60,
        "actions": ["Check grounding and nearby electrical interference",
                    "Add shielding/filtering to the DAQ channel"]}],
    "panel_overheating": [{
        "cause": "Panel overheating", "confidence": 0.80,
        "actions": ["Inspect affected strings for hotspots",
                    "Check shading/soiling and mounting ventilation"]}],
    "inverter_overheating": [{
        "cause": "Inverter overheating", "confidence": 0.75,
        "actions": ["Clean the heat sink and check the fan",
                    "Verify clearance and review inverter temperature trend"]}],
    "grid_voltage_anomaly": [{
        "cause": "Grid voltage outside the normal range", "confidence": 0.75,
        "actions": ["Check the utility side", "Verify inverter protection settings"]}],
    "power_loss": [{
        "cause": "Power loss / current collapse under normal voltage", "confidence": 0.70,
        "actions": ["Check string fuses and DC disconnects",
                    "Compare string currents", "Inspect DC terminations"]}],
}


def _direction(rel):
    return "hi" if (rel or 0) > 0 else "lo"


def _detected_faults(device):
    flags = (device.get("extra") or {}).get("sensor_flags") or []
    detected = [f for f in SENSOR_PRIORITY if f in flags]
    # Sensor-layer faults from the live fault catalog (injected through the
    # UI) are reported the same way as dataset sensor flags.
    for f in (device.get("faults") or []):
        if f.get("layer") == "sensor" and f.get("id") not in detected:
            detected.append(f["id"])
    return detected


def _safe_power(v):
    return "missing" if v is None else f"{float(v):.3f} kW"


def rule_diagnosis(device, event, rel):
    direction = _direction(rel)
    causes = RULE_SETS.get((device["kind"], direction), DEFAULT_CAUSES)
    pct = abs(rel or 0) * 100
    actual = _safe_power(device.get("actual"))
    expected = _safe_power(device.get("expected"))
    return {
        "engine": "rule-based",
        "summary": (f"{device['name']} {NOUN.get(device['kind'], 'consumption')} is "
                    f"{pct:.0f}% {'above' if direction == 'hi' else 'below'} the expected model "
                    f"({actual} actual vs {expected} expected)."),
        "causes": causes,
        "detected_faults": [],
        "primary_fault": None,
        "basis": [
            f"Residual: {(rel or 0):+.1%} of expected",
            f"Detected at day {event.get('day', '?')} {event.get('time', '')}, severity {event.get('severity', 'warning')}",
        ],
    }


def _sensor_diagnosis(device, event, faults):
    primary = faults[0]
    actual = _safe_power(device.get("actual"))
    expected = _safe_power(device.get("expected"))
    return {
        "engine": "rule-based",
        "summary": (f"{device['name']} is flagged for '{primary}'. "
                    f"Telemetry: {actual} actual vs {expected} expected."),
        "causes": SENSOR_RULES[primary],
        "detected_faults": faults,
        "primary_fault": primary,
        "basis": [
            f"Sensor flag(s): {', '.join(faults)}",
            "Source: sensor fault layer (dataset flags or simulated sensor faults)",
        ],
    }


_CLAUDE_SYSTEM = (
    "You are the diagnostic engine of an AI-powered energy monitoring platform. "
    "Given digital-twin telemetry, identify probable causes and concrete corrective actions. "
    "Never invent readings."
)

_DIAG_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "causes": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "cause": {"type": "string"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "actions": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["cause", "confidence", "actions"],
            "additionalProperties": False,
        }},
    },
    "required": ["summary", "causes"],
    "additionalProperties": False,
}


def claude_diagnosis(context):
    try:
        import anthropic
    except ImportError:
        return None
    try:
        client = anthropic.Anthropic()
        response = client.with_options(timeout=30.0).messages.create(
            model="claude-opus-5", max_tokens=16000, system=_CLAUDE_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(context, indent=2)}],
            output_config={"format": {"type": "json_schema", "schema": _DIAG_SCHEMA}},
        )
        text = next(b.text for b in response.content if b.type == "text")
        result = json.loads(text)
        result["engine"] = "claude"
        result["detected_faults"] = []
        result["primary_fault"] = None
        return result
    except Exception:
        return None


def diagnose(device, event, rel, use_claude=True):
    """Always return a usable diagnosis.

    Sensor flags are intentionally checked before the noise-band early return.
    """
    sensor_faults = _detected_faults(device)
    if sensor_faults:
        return _sensor_diagnosis(device, event, sensor_faults)

    if rel is None:
        return {
            "engine": "rule-based",
            "summary": f"{device['name']} has no usable measured power reading.",
            "causes": [],
            "detected_faults": [],
            "primary_fault": None,
            "basis": ["Measured power is missing; no residual was calculated."],
        }

    if abs(rel) < 0.10:
        return {
            "engine": "rule-based",
            "summary": (f"{device['name']} is tracking the expected model "
                        f"({_safe_power(device.get('actual'))} actual vs "
                        f"{_safe_power(device.get('expected'))} expected, "
                        f"residual {rel:+.1%}) - no significant deviation."),
            "causes": [],
            "detected_faults": [],
            "primary_fault": None,
            "basis": ["Residual within the noise band"],
        }

    context = {
        "facility": "Commercial building with rooftop solar, inverter, HVAC, lighting and plug loads",
        "device": {k: device.get(k) for k in ("id", "name", "kind", "rating", "actual", "expected", "extra")},
        "anomaly": event,
        "residual": round(rel, 3),
    }
    if use_claude:
        enriched = claude_diagnosis(context)
        if enriched:
            enriched["basis"] = ["Generated by Claude from digital-twin telemetry; rule engine is fallback."]
            return enriched

    result = rule_diagnosis(device, event, rel)
    result["basis"].append("Offline rule-based engine")
    return result
