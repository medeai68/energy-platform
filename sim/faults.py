"""Virtual fault catalog.

Each fault is a scripted degradation that can be injected into the digital
twin through the UI. Faults only affect the *actual* (virtual sensor) power
values - the *expected* values always come from the healthy model. That gap
between actual and expected is what the anomaly detector and the AI agent
work on.
"""

FAULTS = {
    "solar": [
        {
            "id": "soiling",
            "name": "Soiling / dust",
            "description": "Dust accumulation on panels reduces irradiance capture by ~15%.",
            "severity": "warning",
        },
        {
            "id": "shading",
            "name": "Partial shading",
            "description": "New obstruction (vegetation, adjacent structure) shades part of the array, ~28% loss.",
            "severity": "serious",
        },
        {
            "id": "degradation",
            "name": "Cell degradation",
            "description": "Aging cells lose conversion efficiency, ~10% output loss.",
            "severity": "warning",
        },
        {
            "id": "panel_failure",
            "name": "Panel / string failure",
            "description": "A string of panels is electrically isolated, ~40% output loss.",
            "severity": "critical",
        },
    ],
    "inverter": [
        {
            "id": "eff_drop",
            "name": "Efficiency drop",
            "description": "Conversion efficiency falls from 97% to 89% (overheating, aging).",
            "severity": "warning",
        },
        {
            "id": "derate",
            "name": "Thermal derating",
            "description": "Inverter caps output at 70% of rated power to protect itself.",
            "severity": "serious",
        },
        {
            "id": "offline",
            "name": "Inverter offline",
            "description": "Inverter trips and delivers zero AC power.",
            "severity": "critical",
        },
    ],
    "hvac": [
        {
            "id": "overconsumption",
            "name": "Excessive consumption",
            "description": "AC draws ~45% more power than the cooling demand requires (leak, dirty coils).",
            "severity": "serious",
        },
        {
            "id": "short_cycle",
            "name": "Short cycling",
            "description": "Compressor rapidly cycles on/off, causing erratic, inefficient operation.",
            "severity": "serious",
        },
        {
            "id": "unit_outage",
            "name": "Unit outage",
            "description": "One of the three AC units trips offline (~12 kW of capacity lost).",
            "severity": "serious",
        },
    ],
    "lighting": [
        {
            "id": "night_on",
            "name": "Lights on at night",
            "description": "Lighting stays fully on during night hours (stuck relay / schedule error).",
            "severity": "serious",
        },
        {
            "id": "always_on",
            "name": "Lights always on",
            "description": "Lighting ignores the schedule and dimming entirely.",
            "severity": "serious",
        },
    ],
    "plugs": [
        {
            "id": "vampire",
            "name": "Vampire load",
            "description": "Equipment left running after hours adds ~3.5 kW at night.",
            "severity": "warning",
        },
    ],
}


def faults_for(device_kind):
    """Return the fault catalog for a device kind."""
    return FAULTS.get(device_kind, [])
