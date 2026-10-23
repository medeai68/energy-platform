"""Alarm center: persisted anomalies plus operator follow-up.

Acceptance criteria covered:
  - an active anomaly appears as an alarm with equipment context and source
  - acknowledge is a state transition, not a delete: the condition stays
    visible and cannot be resolved while it is still active
  - resolve is only possible after the detector reports recovery, and keeps
    the operator, wall-clock timestamp and note
  - status/severity/building filters and counts agree with the rows
  - the alarm feed can sync a live snapshot without writing a measurement
"""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from equipment.store import EquipmentStore
from sim.engine import SimulationEngine


class AlarmBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = str(Path(self.tmp.name) / "alarms.db")
        self.store = EquipmentStore(self.db)
        self.addCleanup(self._close_store)
        self.eng = SimulationEngine()

    def _close_store(self):
        try:
            self.store.close()
        except sqlite3.ProgrammingError:
            pass

    def tick(self, n):
        for _ in range(n):
            self.eng.tick()

    def sample(self):
        snap = self.eng.snapshot()
        self.store.sync_registry(snap)
        self.store.record_sample(snap)
        return snap

    def raise_alarm(self, device="p01", fault="reduced_output"):
        self.tick(6)  # midday, panels generating
        self.eng.set_fault(device, fault, True)
        self.tick(3)  # sustained deviation raises after 2 ticks
        self.sample()
        items = self.store.list_alarms(status="active")
        self.assertTrue(items, "fault should have raised an alarm")
        return items[0]

    def clear_alarm(self, device="p01", fault="reduced_output"):
        self.eng.set_fault(device, fault, False)
        self.tick(5)  # recovery needs 3 consecutive in-bounds ticks
        self.sample()


class TestAlarmLifecycle(AlarmBase):
    def test_active_anomaly_is_listed_as_open_with_context(self):
        alarm = self.raise_alarm()
        self.assertEqual(alarm["state"], "open")
        self.assertTrue(alarm["active"])
        self.assertEqual(alarm["equipment_id"], "p01")
        self.assertIn("Panel P-01", alarm["message"])
        self.assertIn(alarm["severity"], ("warning", "serious", "critical"))
        self.assertEqual(alarm["source"], "simulated")
        self.assertEqual(alarm["category"], "panel")
        counts = self.store.alarm_counts()
        self.assertEqual(counts["open"], 1)
        self.assertEqual(counts["active"], 1)
        self.assertEqual(counts["resolved"], 0)

    def test_acknowledge_keeps_the_condition_visible(self):
        alarm = self.raise_alarm()
        acked = self.store.acknowledge_alarm(
            alarm["equipment_id"], alarm["event_key"], "A. Operator")
        self.assertIsNotNone(acked)
        self.assertEqual(acked["state"], "acknowledged")
        self.assertTrue(acked["active"])
        self.assertEqual(acked["acknowledged_by"], "A. Operator")
        self.assertIsNotNone(acked["acknowledged_at"])
        counts = self.store.alarm_counts()
        self.assertEqual((counts["open"], counts["acknowledged"]), (0, 1))
        self.assertEqual(counts["active"], 1)
        # idempotent: the timestamp is not rewritten by a second click
        again = self.store.acknowledge_alarm(
            alarm["equipment_id"], alarm["event_key"], "Someone Else")
        self.assertEqual(again["acknowledged_at"], acked["acknowledged_at"])
        self.assertEqual(again["acknowledged_by"], "A. Operator")

    def test_active_alarm_cannot_be_resolved(self):
        alarm = self.raise_alarm()
        with self.assertRaisesRegex(ValueError, "still active"):
            self.store.resolve_alarm(
                alarm["equipment_id"], alarm["event_key"], "operator", "done")
        self.assertEqual(self.store.alarm_counts()["active"], 1)

    def test_resolve_after_recovery_keeps_operator_and_note(self):
        alarm = self.raise_alarm()
        self.store.acknowledge_alarm(
            alarm["equipment_id"], alarm["event_key"], "A. Operator")
        self.clear_alarm()
        recovered = self.store.list_alarms(status="recovered")[0]
        self.assertEqual(recovered["state"], "recovered")
        self.assertFalse(recovered["active"])
        self.assertIsNotNone(recovered["closed_at"])
        resolved = self.store.resolve_alarm(
            recovered["equipment_id"], recovered["event_key"],
            "A. Operator", "  Sensor connector reseated  ")
        self.assertEqual(resolved["state"], "resolved")
        self.assertEqual(resolved["resolution_note"], "Sensor connector reseated")
        self.assertEqual(resolved["resolved_by"], "A. Operator")
        self.assertIsNotNone(resolved["resolved_at"])
        counts = self.store.alarm_counts()
        self.assertEqual(counts["recovered"], 0)
        self.assertEqual(counts["resolved"], 1)
        # resolving twice is idempotent and does not overwrite the note
        again = self.store.resolve_alarm(
            recovered["equipment_id"], recovered["event_key"], "X", "changed")
        self.assertEqual(again["resolution_note"], "Sensor connector reseated")
        self.assertEqual(again["resolved_by"], "A. Operator")

    def test_unknown_alarm_returns_none(self):
        self.raise_alarm()
        self.assertIsNone(self.store.acknowledge_alarm("nope", "0:1", "op"))
        self.assertIsNone(self.store.resolve_alarm("nope", "0:1", "op", "x"))
        self.assertIsNone(self.store.acknowledge_alarm("", "", "op"))


class TestAlarmListing(AlarmBase):
    def test_status_views_and_counts_agree(self):
        first = self.raise_alarm("p01", "reduced_output")
        self.eng.set_fault("p02", "overheating", True)
        self.tick(3)
        self.sample()
        active = self.store.list_alarms(status="active")
        self.assertGreaterEqual(len(active), 2)
        self.assertTrue(all(a["active"] for a in active))
        self.assertEqual(len(self.store.list_alarms(status="open")), len(active))
        self.store.acknowledge_alarm(first["equipment_id"], first["event_key"], "op")
        self.assertEqual(len(self.store.list_alarms(status="acknowledged")), 1)
        self.assertEqual(len(self.store.list_alarms(status="open")),
                         len(active) - 1)
        counts = self.store.alarm_counts()
        self.assertEqual(counts["active"], len(active))
        self.assertEqual(counts["open"] + counts["acknowledged"], counts["active"])
        self.assertEqual(len(self.store.list_alarms(status="all", limit=500)),
                         counts["total"])

    def test_severity_and_building_filters(self):
        alarm = self.raise_alarm()
        sev = alarm["severity"]
        by_sev = self.store.list_alarms(status="active", severity=sev)
        self.assertTrue(by_sev)
        self.assertTrue(all(a["severity"] == sev for a in by_sev))
        other = [s for s in ("warning", "serious", "critical") if s != sev]
        for s in other:
            self.assertEqual(self.store.list_alarms(status="active", severity=s), [])
        building = alarm["building_id"]
        self.assertTrue(self.store.list_alarms(status="active", building_id=building))
        self.assertEqual(
            self.store.list_alarms(status="active", building_id="does-not-exist"), [])
        with self.assertRaises(ValueError):
            self.store.list_alarms(status="bogus")
        with self.assertRaises(ValueError):
            self.store.list_alarms(status="active", severity="bogus")

    def test_refresh_syncs_alarms_without_writing_measurements(self):
        self.tick(6)
        self.store.sync_registry(self.eng.snapshot())
        before = self.store.conn.execute(
            "SELECT COUNT(*) FROM equipment_measurements").fetchone()[0]
        self.eng.set_fault("p03", "disconnected", True)
        self.tick(3)
        self.store.refresh_anomalies(self.eng.snapshot())
        after = self.store.conn.execute(
            "SELECT COUNT(*) FROM equipment_measurements").fetchone()[0]
        self.assertEqual(before, after, "alarm sync must not sample measurements")
        items = self.store.list_alarms(status="active")
        self.assertTrue(any(a["equipment_id"] == "p03" for a in items))


class TestReopenedResolvedAlarm(AlarmBase):
    """Regression: a resolved record that the detector reports active again
    (same event id) must not stay in the resolved state.

    The snapshot exposes only the first 10 active anomalies, so an event can
    drop out of the sync (row -> recovered), be resolved by an operator, and
    then reappear in the snapshot while the engine still holds it active.
    The row is re-activated, but a retained resolved_at made it read as
    "resolved" and it vanished from the Active view - the exact defect.
    """

    DEVICE = "lt-regression"
    EVENT = {"id": 7, "device_id": DEVICE, "severity": "warning",
             "message": "Test anomaly re-reported", "ts": 360}

    def _snap(self, anomalies, minutes=360):
        return {
            "sim": {"day": 1, "minutes": minutes},
            "devices": [],
            "panels": [],
            "equipment": [{
                "id": self.DEVICE, "name": "Regression light",
                "kind": "room_light", "source": "simulated",
                "parent": {"building": "b1", "floor": "b1f1", "room": "b1f1r1"},
            }],
            "buildings": [],
            "anomalies": anomalies,
        }

    def _key(self):
        return self.store.conn.execute(
            "SELECT event_key FROM equipment_anomalies WHERE equipment_id = ?",
            (self.DEVICE,)).fetchone()[0]

    def setUp(self):
        super().setUp()
        self.store.sync_registry(self._snap([]))

    def test_reopened_condition_is_open_and_visible_in_active_view(self):
        # 1. the detector reports the anomaly -> open alarm
        self.store.refresh_anomalies(self._snap([dict(self.EVENT)]))
        key = self._key()
        active = self.store.list_alarms(status="active")
        self.assertEqual([a["event_key"] for a in active], [key])
        self.assertEqual(active[0]["state"], "open")

        # 2. the event drops out of the snapshot -> recovered
        self.store.refresh_anomalies(self._snap([]))
        self.assertEqual(self.store.list_alarms(status="recovered")[0]["event_key"], key)

        # 3. operator resolves the recovered record
        self.store.resolve_alarm(self.DEVICE, key, operator="Operator", note="closed out")
        resolved = self.store.list_alarms(status="resolved")
        self.assertEqual([a["event_key"] for a in resolved], [key])

        # 4. the detector reports the SAME event active again
        self.store.refresh_anomalies(self._snap([dict(self.EVENT)]))

        row = self.store.conn.execute(
            """SELECT active, closed_at, acknowledged_at, resolved_at,
                      resolved_by, resolution_note
                 FROM equipment_anomalies WHERE equipment_id = ? AND event_key = ?""",
            (self.DEVICE, key)).fetchone()
        self.assertEqual(row[0], 1, "reported event must be active again")
        self.assertIsNone(row[1], "an active condition has no closed_at")
        self.assertIsNone(row[3], "a reused active record cannot stay resolved")
        self.assertIsNone(row[4], "stale resolution operator must be cleared")
        self.assertIsNone(row[5], "stale resolution note must be cleared")
        self.assertIsNone(row[2], "stale acknowledgement must be cleared")

        active = self.store.list_alarms(status="active")
        self.assertEqual([a["event_key"] for a in active], [key],
                         "the live condition must appear in the Active view")
        self.assertEqual(active[0]["state"], "open")
        self.assertNotIn(key, [a["event_key"] for a in self.store.list_alarms(status="resolved")])

    def test_routine_refresh_keeps_an_acknowledgement(self):
        self.store.refresh_anomalies(self._snap([dict(self.EVENT)]))
        key = self._key()
        self.store.acknowledge_alarm(self.DEVICE, key, operator="Operator")
        # the detector re-reports the same live event on every poll
        self.store.refresh_anomalies(self._snap([dict(self.EVENT)], minutes=366))
        row = self.store.conn.execute(
            """SELECT active, acknowledged_at, acknowledged_by
                 FROM equipment_anomalies WHERE equipment_id = ? AND event_key = ?""",
            (self.DEVICE, key)).fetchone()
        self.assertEqual(row[0], 1)
        self.assertIsNotNone(row[1], "refresh of a live alarm must keep its acknowledgement")
        self.assertEqual(row[2], "Operator")
        self.assertEqual(self.store.list_alarms(status="acknowledged")[0]["event_key"], key)

    def test_resolved_record_is_untouched_when_not_reported(self):
        self.store.refresh_anomalies(self._snap([dict(self.EVENT)]))
        key = self._key()
        self.store.refresh_anomalies(self._snap([]))
        self.store.resolve_alarm(self.DEVICE, key, operator="Operator", note="closed out")
        # later syncs without the event must not alter the closed record
        self.store.refresh_anomalies(self._snap([], minutes=372))
        row = self.store.conn.execute(
            """SELECT active, resolved_at, resolution_note
                 FROM equipment_anomalies WHERE equipment_id = ? AND event_key = ?""",
            (self.DEVICE, key)).fetchone()
        self.assertEqual(row[0], 0)
        self.assertIsNotNone(row[1])
        self.assertEqual(row[2], "closed out")


if __name__ == "__main__":
    unittest.main()
