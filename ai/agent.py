"""AI diagnostic agent.

Two engines, one interface:

1. Rule-based expert system (always available, offline). A knowledge base of
   fault signatures -> ranked probable causes + recommended actions.

2. Claude enrichment (optional). If the `anthropic` package is installed and
   credentials are available, the same context is sent to the Claude API
   (claude-opus-5) with structured JSON output. Any error falls back to the
   rule-based engine so the platform keeps working offline.
"""

import json

# ---------------- Knowledge base ----------------
# Signature = (device_kind, direction). Causes are ranked by confidence.
# Actions are concrete steps a facility operator or O&M team can take.

RULE_SETS = {
    ("solar", "lo"): [
        {"cause": "Soiling / dust accumulation", "confidence": 0.65,
         "actions": ["Schedule panel cleaning; compare with a nearby clean reference panel",
                     "Review cleaning log - if last wash > 30 days ago, soiling is likely"]},
        {"cause": "Partial shading (vegetation, new obstruction)", "confidence": 0.55,
         "actions": ["Walk the roof and inspect for new shading sources",
                     "Check shading logs around sunrise/sunset; consider trimming or panel relocation"]},
        {"cause": "Panel / string failure (bypass diode, hotspot)", "confidence": 0.45,
         "actions": ["Run a string-level IV-curve or IR thermal scan to isolate the bad string",
                     "Compare per-string currents in the inverter monitoring portal"]},
        {"cause": "Inverter MPPT tracking issue", "confidence": 0.30,
         "actions": ["Review inverter MPPT sweep logs", "Update inverter firmware and re-run self-test"]},
    ],
    ("inverter", "lo"): [
        {"cause": "Overheating (dust-blocked heat sink, poor airflow)", "confidence": 0.60,
         "actions": ["Inspect and clean the heat sink and air filters",
                     "Check the inverter's internal temperature trend; verify clearance around the unit"]},
        {"cause": "Aging IGBT / power-stage degradation", "confidence": 0.55,
         "actions": ["Run a power-stage diagnostic via the manufacturer tool",
                     "Plan preventive replacement if efficiency keeps drifting down"]},
        {"cause": "DC-side issue upstream (loose connections, string fault)", "confidence": 0.45,
         "actions": ["Thermal-scan DC terminations for hot spots", "Verify DC input vs expected array output"]},
    ],
    ("inverter", "hi"): [
        {"cause": "Sensor offset or meter calibration drift", "confidence": 0.50,
         "actions": ["Cross-check the inverter's internal CT readings against the utility meter"]},
    ],
    ("hvac", "hi"): [
        {"cause": "Refrigerant leak (undercharge makes the compressor run longer/harder)", "confidence": 0.70,
         "actions": ["Check refrigerant charge and subcooling; leak-test the circuit",
                     "If confirmed, repair the leak and recharge per manufacturer spec"]},
        {"cause": "Dirty condenser / evaporator coils", "confidence": 0.60,
         "actions": ["Clean condenser and evaporator coils", "Verify air filters and replace if clogged"]},
        {"cause": "Duct leakage or stuck damper", "confidence": 0.50,
         "actions": ["Inspect ducts for leaks; verify zone dampers open/close correctly"]},
        {"cause": "Failing compressor (mechanical wear)", "confidence": 0.45,
         "actions": ["Measure compressor amp draw and compare with the nameplate",
                     "Schedule a technician visit if the trend worsens"]},
    ],
    ("hvac", "lo"): [
        {"cause": "Unit tripped offline (breaker, protection)", "confidence": 0.60,
         "actions": ["Check breakers and the unit's fault LED/error codes", "Reset and watch for re-trip"]},
        {"cause": "Thermostat setpoint or schedule change", "confidence": 0.50,
         "actions": ["Compare thermostat setpoints against the baseline schedule"]},
    ],
    ("lighting", "hi"): [
        {"cause": "Schedule error or stuck relay (lights left on after hours)", "confidence": 0.85,
         "actions": ["Verify the lighting schedule in the BMS; correct any override",
                     "Inspect the contactor/relay for welded contacts"]},
        {"cause": "Occupancy sensor fault", "confidence": 0.55,
         "actions": ["Test the occupancy sensors; check for blocked lenses or wiring faults"]},
    ],
    ("plugs", "hi"): [
        {"cause": "Equipment left running after hours", "confidence": 0.70,
         "actions": ["Audit night-time plug loads (server room, kitchen, chargers)",
                     "Add smart plugs or schedule-based shutdown for known offenders"]},
        {"cause": "Faulty power supply / phantom load", "confidence": 0.55,
         "actions": ["Meter individual circuits to isolate the load", "Replace aging power supplies"]},
    ],
}

DEFAULT_CAUSES = [
    {"cause": "Unknown deviation - signature not in the knowledge base", "confidence": 0.4,
     "actions": ["Collect 24h of high-resolution data and inspect manually",
                 "Compare against the expected model to rule out a modeling error"]},
]

NOUN = {"solar": "generation", "inverter": "output"}


def _direction(rel):
    return "hi" if rel > 0 else "lo"


def rule_diagnosis(device, event, rel):
    """Rule-based diagnosis from the knowledge base."""
    noun = NOUN.get(device["kind"], "consumption")
    direction = _direction(rel)
    pct = abs(rel) * 100
    causes = RULE_SETS.get((device["kind"], direction), DEFAULT_CAUSES)
    summary = (f"{device['name']} {noun} is {pct:.0f}% "
               f"{'above' if direction == 'hi' else 'below'} the expected model "
               f"({device['actual']:.1f} kW vs {device['expected']:.1f} kW expected).")
    return {
        "engine": "rule-based",
        "summary": summary,
        "causes": causes,
        "basis": [
            f"Residual: {rel:+.1%} of expected",
            f"Detected at day {event.get('day', '?')} {event.get('time', '')}, severity {event['severity']}",
        ],
    }


# ---------------- Optional Claude enrichment ----------------

_CLAUDE_SYSTEM = (
    "You are the diagnostic engine of an AI-powered energy monitoring platform "
    "for commercial solar buildings. Given telemetry from the digital twin "
    "(virtual sensors), identify probable causes of the detected anomaly and "
    "recommend concrete corrective actions. Be specific, practical, and honest "
    "about uncertainty - rank causes by probability and never invent readings."
)

_DIAG_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "causes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cause": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "actions": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["cause", "confidence", "actions"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "causes"],
    "additionalProperties": False,
}


def claude_diagnosis(context):
    """Ask Claude for a diagnosis. Returns a dict or None if unavailable.

    Requires `pip install anthropic` and credentials resolvable by the SDK
    (ANTHROPIC_API_KEY env var or an `ant auth login` profile).
    """
    try:
        import anthropic
    except ImportError:
        return None
    try:
        client = anthropic.Anthropic()  # resolves credentials from the environment
        response = client.with_options(timeout=30.0).messages.create(
            model="claude-opus-5",
            max_tokens=16000,
            system=_CLAUDE_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(context, indent=2)}],
            output_config={"format": {"type": "json_schema", "schema": _DIAG_SCHEMA}},
        )
        text = next(b.text for b in response.content if b.type == "text")
        result = json.loads(text)
        result["engine"] = "claude"
        return result
    except anthropic.AuthenticationError:
        return None  # bad/missing key -> fall back to rules silently
    except (anthropic.RateLimitError, anthropic.APIStatusError, anthropic.APIConnectionError):
        return None
    except Exception:
        return None


# ---------------- Public entry point ----------------


def diagnose(device, event, rel, use_claude=True):
    """Diagnose an anomaly for a device. Always returns a usable diagnosis."""
    # Nothing to diagnose: the residual is inside the noise band.
    if abs(rel) < 0.10:
        return {
            "engine": "rule-based",
            "summary": (f"{device['name']} is tracking the expected model "
                        f"({device['actual']:.1f} kW vs {device['expected']:.1f} kW expected, "
                        f"residual {rel:+.1%}) - no significant deviation to diagnose."),
            "causes": [],
            "basis": ["Residual within the noise band of the expected model"],
        }
    context = {
        "facility": "Commercial building with 50 kWp rooftop solar, 50 kW inverter, "
                    "3x12 kW HVAC, 6 kW lighting, 9 kW plug loads",
        "device": {k: device.get(k) for k in ("id", "name", "kind", "rating", "actual", "expected", "extra")},
        "anomaly": event,
        "residual": round(rel, 3),
    }
    if use_claude:
        enriched = claude_diagnosis(context)
        if enriched:
            enriched["basis"] = [
                "Generated by Claude from digital-twin telemetry (rule engine available as fallback)",
            ]
            return enriched
    result = rule_diagnosis(device, event, rel)
    result["basis"].append("Offline rule-based engine (set ANTHROPIC_API_KEY + `pip install anthropic` for Claude enrichment)")
    return result
