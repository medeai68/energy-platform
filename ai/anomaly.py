"""Anomaly detection: expected-vs-actual residuals plus domain rule checks.

For each device, the residual is
    rel = (actual - expected) / max(expected, floor)

A healthy device keeps |rel| inside its noise band. An injected fault pushes
rel beyond the device's threshold; the detector requires the deviation to be
sustained (2 ticks to raise). Recovery needs 3 *consecutive* in-bounds ticks,
so noise dips around the threshold don't close and re-open the event (the
feed would churn). A few domain rules catch signatures the residual alone
can't name (lighting at night, inverter offline).
"""

SEVERITY_BAND = [(0.55, "critical"), (0.25, "serious")]

NOUN = {"solar": "generation", "inverter": "output"}


def _severity(abs_rel):
    for limit, level in SEVERITY_BAND:
        if abs_rel > limit:
            return level
    return "warning"


class AnomalyDetector:
    def __init__(self):
        # device_id -> {dir, count (raise sustain), recover, active_id}
        self.state = {}
        self._engine = None

    def _st(self, dev_id):
        if dev_id not in self.state:
            self.state[dev_id] = {"dir": None, "count": 0, "recover": 0, "active_id": None}
        return self.state[dev_id]

    def device_status(self, dev_id):
        """ok | warning | serious | critical - from the active anomaly."""
        st = self._st(dev_id)
        if st["active_id"] is None:
            return "ok"
        event = self._event_by_id(dev_id, st["active_id"])
        return event["severity"] if event else "ok"

    def _event_by_id(self, dev_id, event_id):
        for e in self._engine.events:
            if e["id"] == event_id and e["device_id"] == dev_id:
                return e
        return None

    def update(self, engine, env):
        self._engine = engine
        hour = env["hour"]
        for dev in engine.devices:
            e, a = dev.expected, dev.actual
            base = max(e, dev.rel_floor)
            rel = (a - e) / base if (e > 0 or a > 0) else 0.0
            st = self._st(dev.id)

            # --- domain rules (named signatures the residual can't express) ---
            # Lighting is scheduled off 19:00-07:00; on at night = stuck relay/schedule.
            night = hour < 7.0 or hour >= 19.0
            if dev.kind == "lighting" and night and a > 2.0:
                self._raise(engine, dev, rel, f"Lighting active at night "
                            f"({a:.1f} kW at {engine.time_label})", "serious", st)
                continue
            if dev.kind == "inverter" and rel < -0.95:
                self._raise(engine, dev, rel, "Inverter offline - no AC output", "critical", st)
                continue

            # --- generic residual check ---
            direction = ("hi" if rel > dev.anomaly_thresh
                         else "lo" if rel < -dev.anomaly_thresh else None)
            if direction:
                st["recover"] = 0
                if st["dir"] == direction:
                    st["count"] += 1
                else:
                    st["dir"] = direction
                    st["count"] = 1
                if st["count"] >= 2:
                    noun = NOUN.get(dev.kind, "consumption")
                    pct = rel * 100
                    msg = (f"{dev.name} {noun} {'above' if direction == 'hi' else 'below'} expected "
                           f"({a:.1f} kW vs {e:.1f} kW, {pct:+.0f}%)")
                    self._raise(engine, dev, rel, msg, _severity(abs(rel)), st)
            elif st["active_id"] is not None:
                st["recover"] += 1
                if st["recover"] >= 3:
                    ev = self._event_by_id(dev.id, st["active_id"])
                    if ev:
                        ev["active"] = False
                    st["active_id"] = None
                    st["dir"] = None
                    st["count"] = 0
                    st["recover"] = 0
            else:
                st["dir"] = None
                st["count"] = 0
                st["recover"] = 0

    def _raise(self, engine, dev, rel, message, severity, st):
        """Raise an anomaly event, or refresh the message of the active one."""
        if st["active_id"] is not None:
            ev = self._event_by_id(dev.id, st["active_id"])
            if ev and ev["active"]:
                ev["message"] = message
                ev["severity"] = severity
                return
        event = engine._add_event(severity, dev.id, dev.name, message, active=True)
        st["active_id"] = event["id"]
