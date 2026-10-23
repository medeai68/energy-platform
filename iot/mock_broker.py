"""Mock MQTT broker + publisher — SIMULATED integration.

An in-process, stdlib-only stand-in for an MQTT broker: a topic/queue pair
and a publisher thread that emits deterministic measurement messages for the
"Office 3" fleet site at a fixed cadence. This is a mock for development and
demonstration — it never opens a socket and never touches real hardware, and
every published message carries ``"simulated": true``.
"""

import json
import queue
import random
import threading
import time

TOPIC_SITE = "energy/office3/+/measurement"

SITE_DEVICES = [
    # id, name, kind, rating, base, amp
    ("ext-b-fcu", "FCU plant", "fcu", 18.0, 8.0, 9.0),
    ("ext-b-lighting", "Office lighting", "room_light", 3.0, 1.0, 1.8),
    ("ext-b-plugs", "Workstation plugs", "room_plug", 5.0, 2.4, 2.2),
    ("ext-b-ups", "Server UPS", "server_ups", 8.0, 4.6, 1.2),
]


class MockBroker:
    """A minimal pub/sub stand-in. Subscribers get every message published
    after they subscribe (no history, no retained messages)."""

    def __init__(self):
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        self._subscribers = []

    def publish(self, topic, payload):
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            q.put((topic, payload))

    def subscribe(self):
        q = queue.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)


class MockPublisher:
    """Deterministic 'device' publisher: one message per device per cycle."""

    def __init__(self, broker, interval=10.0, seed=21):
        self.broker = broker
        self.interval = interval
        self.rngs = {d[0]: random.Random(f"{seed}:{d[0]}") for d in SITE_DEVICES}
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="mock-mqtt-publisher", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        first = True
        while first or not self._stop.wait(self.interval):
            first = False
            now = time.time()
            hour = time.localtime(now).tm_hour
            dayf = 1.0 if 6 <= hour <= 20 else 0.25
            for dev_id, name, kind, rating, base, amp in SITE_DEVICES:
                r = self.rngs[dev_id]
                actual = base + amp * dayf * (0.85 + 0.3 * r.random())
                self.broker.publish(TOPIC_SITE, json.dumps({
                    "equipment_id": dev_id,
                    "name": name,
                    "kind": kind,
                    "rating_kw": rating,
                    "actual_kw": round(actual, 2),
                    "expected_kw": round(base + amp * dayf, 2),
                    "status": "ok",
                    "measured_at": int(now),
                    "measured_day": int(time.strftime("%j", time.localtime(now))),
                    "measured_time": time.strftime("%H:%M", time.localtime(now)),
                    "simulated": True,
                    "note": "simulated MQTT publisher — no real broker or hardware",
                }))
