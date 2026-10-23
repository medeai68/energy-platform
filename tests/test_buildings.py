"""Smart-building hierarchy: buildings -> floors -> rooms -> leaf devices.

Covers the interactive 3D digital-twin acceptance criteria:
  - every building, floor, room and leaf device has a stable unique id
  - the aggregate devices (hvac / lighting / plugs / systems) are exactly
    the sums of their leaves, and the KPIs include them
  - a fault on one room or floor device changes only that device's room
    plus the aggregate it feeds
  - leaf faults raise their own anomalies and appear in the snapshot tree
"""

import unittest

from sim.engine import SimulationEngine
from sim.faults import faults_for


class TestBuildings(unittest.TestCase):
    def setUp(self):
        self.eng = SimulationEngine()

    def tick(self, n):
        """Advance n ticks (speed 60 = 1 h per tick)."""
        for _ in range(n):
            self.eng.tick()

    def active_anomalies(self, device_id=None):
        return [e for e in self.eng.events
                if e["active"] and e["severity"] != "operator"
                and (device_id is None or e["device_id"] == device_id)]

    def snap(self, dev_id):
        snap = self.eng.snapshot()
        for lst in (snap["devices"], snap["panels"], snap["equipment"]):
            for d in lst:
                if d["id"] == dev_id:
                    return d
        raise KeyError(dev_id)

    # --- identity & structure ---

    def test_hierarchy_identity(self):
        self.assertEqual([b.id for b in self.eng.buildings], ["b1", "b2"])
        b1, b2 = self.eng.buildings
        self.assertEqual([f.id for f in b1.floors], ["b1f1", "b1f2", "b1f3"])
        self.assertEqual([f.id for f in b2.floors], ["b2f1", "b2f2"])
        self.assertEqual(len(b1.floors[0].rooms), 4)
        self.assertEqual(b1.floors[2].rooms[0].id, "b1f3r1")

        # every room has a lighting + plugs circuit; every floor an FCU.
        # Room-hosted system leaves (UPS in the server room, water heater in
        # storage) are the only additional devices.
        allowed_extra = {"server_ups", "water_heater"}
        for b in self.eng.buildings:
            for f in b.floors:
                self.assertTrue(f.fcu_id and f.fcu_id.startswith("fc-"))
                for r in f.rooms:
                    kinds = [self.snap(i)["kind"] for i in r.device_ids]
                    self.assertIn("room_light", kinds)
                    self.assertIn("room_plugs", kinds)
                    self.assertTrue(set(kinds) - {"room_light", "room_plugs"} <= allowed_extra)

        # all ids (aggregates + panels + leaves) are unique
        ids = [d.id for d in self.eng.devices] + [p.id for p in self.eng.panels] \
            + [d.id for d in self.eng.equipment]
        self.assertEqual(len(ids), len(set(ids)))
        # 6 aggregates + 48 panels + 5 FCUs + 18 lights + 18 plugs + 4 systems
        self.assertEqual(len(self.eng.equipment), 5 + 18 + 18 + 4)
        equip_ids = sorted(d.id for d in self.eng.equipment)

        # ids survive a reset
        self.eng.reset()
        self.assertEqual([b.id for b in self.eng.buildings], ["b1", "b2"])
        self.assertEqual(sorted(d.id for d in self.eng.equipment), equip_ids)

    def test_snapshot_buildings_tree(self):
        self.tick(3)
        snap = self.eng.snapshot()
        self.assertEqual(len(snap["buildings"]), 2)
        b1 = snap["buildings"][0]
        self.assertEqual(b1["name"], "Tower A")
        self.assertTrue(b1["solar"])
        self.assertIn("solar", b1["roof_device_ids"])
        self.assertIn("p01", b1["roof_device_ids"])
        f2 = b1["floors"][1]
        self.assertEqual(f2["id"], "b1f2")
        self.assertEqual(f2["fcu"]["id"], "fc-b1f2")
        server_room = next(r for r in f2["rooms"] if r["usage"] == "server")
        # lighting + plugs + the server-room UPS
        self.assertEqual(len(server_room["devices"]), 3)
        self.assertIn("ups-b1", [d["id"] for d in server_room["devices"]])
        self.assertEqual(server_room["area"], 48)
        # the water heater lives in Annex B's storage room
        b2_storage = snap["buildings"][1]["floors"][0]["rooms"][2]
        self.assertIn("wh-b2", [d["id"] for d in b2_storage["devices"]])
        self.assertEqual(snap["buildings"][1]["name"], "Annex B")
        self.assertFalse(snap["buildings"][1]["solar"])
        # equipment leaf list mirrors the tree
        equip_ids = {d["id"] for d in snap["equipment"]}
        self.assertIn("el-b1", equip_ids)
        self.assertIn("wh-b2", equip_ids)

    # --- aggregation ---

    def test_aggregates_are_leaf_sums(self):
        self.tick(4)
        by_id = {d.id: d for d in self.eng.devices}
        by_kind = {}
        for d in self.eng.equipment:
            by_kind.setdefault(d.kind, []).append(d)
        # the aggregates are the exact engine-level sums of their leaves
        # (snapshot dicts are rounded, so compare the raw objects)
        self.assertEqual(by_id["hvac"].actual, sum(d.actual for d in by_kind["fcu"]))
        self.assertEqual(by_id["lighting"].actual,
                         sum(d.actual for d in by_kind["room_light"]))
        self.assertEqual(by_id["plugs"].actual,
                         sum(d.actual for d in by_kind["room_plugs"]))
        self.assertEqual(by_id["systems"].actual,
                         sum(d.actual for d in by_kind["elevator"]
                             + by_kind["server_ups"] + by_kind["ev_charger"]
                             + by_kind["water_heater"]))
        snap = self.eng.snapshot()
        total = (by_id["hvac"].actual + by_id["lighting"].actual
                 + by_id["plugs"].actual + by_id["systems"].actual)
        # the snapshot KPI is exactly this sum, rounded to one decimal
        self.assertEqual(snap["kpis"]["load_kw"], round(total, 1))

    def test_building_totals_have_no_double_counting(self):
        """Room-hosted system leaves belong to both the room and the
        building's equipment list - the building total must count them once."""
        self.tick(4)
        snap = self.eng.snapshot()
        b1 = snap["buildings"][0]
        ids = set()
        for f in b1["floors"]:
            for r in f["rooms"]:
                ids.update(d["id"] for d in r["devices"])
            ids.add(f["fcu"]["id"])
        ids.update(d["id"] for d in b1["equipment"])
        by_id = {d["id"]: d for d in snap["equipment"]}
        expected = round(sum(by_id[i]["actual"] for i in ids), 2)
        self.assertAlmostEqual(b1["actual"], expected, places=2)
        # the server room's own total includes its UPS
        f2 = b1["floors"][1]
        server = next(r for r in f2["rooms"] if r["id"] == "b1f2r2")
        ups = next(d for d in server["devices"] if d["id"] == "ups-b1")
        self.assertGreaterEqual(server["actual"], ups["actual"])

    def test_energy_aggregation_has_no_double_counting(self):
        """The visualization relies on one aggregation rule per level:
        room = its devices, floor = rooms + FCU, building = unique devices.
        The campus total must equal the sum of leaves (roll-up plant is
        never added, room-hosted systems are never counted twice)."""
        self.tick(6)
        snap = self.eng.snapshot()
        by_id = {d["id"]: d for d in snap["equipment"]}

        for b in snap["buildings"]:
            ids = set()
            for f in b["floors"]:
                for r in f["rooms"]:
                    # room energy is exactly the sum of its own devices
                    self.assertAlmostEqual(
                        r["energy_today_kwh"],
                        round(sum(d["energy_today_kwh"] for d in r["devices"]), 3),
                        places=3)
                    ids.update(d["id"] for d in r["devices"])
                # floor energy includes its FCU, and area is the room area sum
                self.assertEqual(f["area"], sum(r["area"] for r in f["rooms"]))
                self.assertAlmostEqual(
                    f["energy_today_kwh"],
                    round(sum(r["energy_today_kwh"] for r in f["rooms"])
                          + (f["fcu"]["energy_today_kwh"] if f["fcu"] else 0), 3),
                    places=3)
                ids.add(f["fcu"]["id"])
            ids.update(d["id"] for d in b["equipment"])
            self.assertAlmostEqual(
                b["energy_today_kwh"],
                round(sum(by_id[i]["energy_today_kwh"] for i in ids), 3),
                places=3)
            self.assertEqual(b["area"], sum(f["area"] for f in b["floors"]))

        # campus total == every leaf exactly once (no aggregate roll-ups)
        campus = sum(b["energy_today_kwh"] for b in snap["buildings"])
        leaves = sum(d["energy_today_kwh"] for d in snap["equipment"])
        self.assertAlmostEqual(campus, round(leaves, 6), places=3)
        self.assertGreater(campus, 0)

    def test_leaf_ratings_sum_to_plants(self):
        snap = self.eng.snapshot()
        self.assertAlmostEqual(
            sum(d["rating"] for d in snap["equipment"] if d["kind"] == "room_light"), 6.0, places=2)
        self.assertAlmostEqual(
            sum(d["rating"] for d in snap["equipment"] if d["kind"] == "room_plugs"), 9.0, places=2)
        self.assertAlmostEqual(
            sum(d["rating"] for d in snap["equipment"] if d["kind"] == "fcu"), 36.0)
        self.assertAlmostEqual(
            sum(d["rating"] for d in snap["equipment"]
                if d["kind"] in ("elevator", "server_ups", "ev_charger", "water_heater")),
            20.0)

    # --- fault isolation ---

    def test_fcu_outage_isolated_to_floor(self):
        self.tick(4)  # 06:00 -> 10:00, HVAC active
        before = self.snap("hvac")["actual"]
        self.assertTrue(before > 2.0)

        self.assertTrue(self.eng.set_fault("fc-b1f1", "unit_outage", True))
        self.tick(3)
        self.assertLess(self.snap("fc-b1f1")["actual"], 0.1)
        # the other FCUs keep tracking their own expected model (their duty
        # legitimately follows the outdoor temperature, so compare against
        # the same tick's expected band, not against a different hour)
        other = self.snap("fc-b2f1")
        self.assertLess(abs(other["actual"] - other["expected"]), 0.6)
        self.assertEqual(other["status"], "ok")
        self.assertLess(self.snap("hvac")["actual"], before - 1.0)
        self.assertTrue(self.active_anomalies("fc-b1f1"))
        # the floor that lost its FCU reports it, the other floors don't
        snap = self.eng.snapshot()
        b1 = snap["buildings"][0]
        self.assertGreaterEqual(b1["floors"][0]["anomalies"], 1)
        self.assertEqual(b1["floors"][1]["anomalies"], 0)

        self.eng.set_fault("fc-b1f1", "unit_outage", False)
        self.tick(5)
        self.assertFalse(self.active_anomalies("fc-b1f1"))

    def test_room_light_night_fault(self):
        self.tick(13)  # 06:00 -> 19:00 (night)
        self.eng.set_fault("lt-b1f1r1", "night_on", True)
        self.tick(3)
        ev = self.active_anomalies("lt-b1f1r1")
        self.assertTrue(ev, "room light at night should raise its own anomaly")
        self.assertIn("night", ev[0]["message"].lower())
        # aggregate lighting picks up the extra draw
        self.assertTrue(self.active_anomalies("lighting"))
        self.eng.set_fault("lt-b1f1r1", "night_on", False)

    def test_systems_leaf_fault(self):
        # 06:00 -> 22:00: overnight every systems leaf holds a flat baseline,
        # so the aggregate delta is attributable to the injected leak alone.
        self.tick(16)
        self.eng.set_fault("wh-b2", "leak", True)
        self.tick(2)  # -> 24:00
        self.assertAlmostEqual(self.snap("wh-b2")["actual"],
                               self.snap("wh-b2")["expected"] + 0.9, delta=0.15)
        # the aggregate picks up the leak above its own expected model
        systems = self.snap("systems")
        self.assertGreater(systems["actual"], systems["expected"] + 0.5)
        self.assertTrue(self.active_anomalies("wh-b2"))

    # --- fault catalog ---

    def test_new_kinds_have_catalogs(self):
        for kind in ("room_light", "room_plugs", "fcu", "elevator",
                     "server_ups", "ev_charger", "water_heater"):
            self.assertTrue(faults_for(kind), f"missing catalog for {kind}")


if __name__ == "__main__":
    unittest.main()
