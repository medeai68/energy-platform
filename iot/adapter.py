"""MQTT adapter — SIMULATED integration.

Subscribes to the mock broker and ingests every measurement through the
platform's canonical ``equipment_store.import_measurement`` entry point with
``source='live'``. This is the same ingestion path a real IoT/Modbus
collector would use; here the messages come from the in-process mock broker,
never from real devices, and every sample keeps its ``simulated`` flag in
the sensors payload.
"""

import json


class MqttAdapter:
    def __init__(self, broker, equipment_store):
        self.broker = broker
        self.store = equipment_store
        self.subscription = None
        self.imported = 0
        self.errors = 0

    def start(self):
        if self.subscription is not None:
            return
        self.subscription = self.broker.subscribe()

    def stop(self):
        if self.subscription is not None:
            self.broker.unsubscribe(self.subscription)
            self.subscription = None

    def drain(self):
        """Pull every pending message and import it. Returns the number of
        samples imported (0 when the mock broker has nothing new)."""
        count = 0
        while True:
            try:
                topic, payload = self.subscription.get_nowait()
            except Exception:
                break
            try:
                msg = json.loads(payload)
            except (TypeError, ValueError):
                self.errors += 1
                continue
            if not msg.get("simulated"):
                # never ingest anything that is not explicitly simulated
                self.errors += 1
                continue
            try:
                self.store.import_measurement(
                    equipment_id=msg["equipment_id"],
                    measured_at=int(msg["measured_at"]),
                    measured_day=str(msg.get("measured_day") or ""),
                    measured_time=str(msg.get("measured_time") or ""),
                    actual_kw=float(msg.get("actual_kw") or 0.0),
                    expected_kw=float(msg.get("expected_kw") or 0.0),
                    status=str(msg.get("status") or "ok"),
                    source="live",
                    sensors={"mqtt": "simulated in-process broker"},
                )
                self.imported += 1
                count += 1
            except Exception:
                self.errors += 1
        return count
