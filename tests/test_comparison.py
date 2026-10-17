"""Locked world alternatives, metric calibration and saved alignment review."""

import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film import comparison, jobs, worlds
from film.scene import evaluate, load_scene, sample_scene, validate_scene
from tests.test_worlds import glb_bytes, glb_document, PROVENANCE


ROOT = Path(__file__).resolve().parents[1]


class ComparisonTests(unittest.TestCase):
    def test_floor_contact_without_plinth_is_shared_calibrated_and_reviewed(self):
        self.scene["environment"]["plinth"]["visible"] = False
        self.scene["environment"]["floorY"] = .13
        self.scene["placement"]["restsOn"] = "floor"
        reviewed = comparison.review_alignment(self.scene)
        payload = comparison.comparison_payload(reviewed)
        self.assertEqual(payload["b"]["environment"]["floorY"], .13)
        self.assertFalse(payload["b"]["environment"]["plinth"]["visible"])
        self.assertEqual(sample_scene(payload["a"])["frames"], sample_scene(payload["b"])["frames"])
        calibrated = comparison.calibrate_scene(reviewed, "a", {"sourceFloorPoint": [0, 0, 0]})
        self.assertAlmostEqual(calibrated["environment"]["asset"]["translationM"][1], .13)
        calibrated["environment"]["floorY"] = .14
        self.assertEqual(comparison.comparison_payload(calibrated)["alignmentStatus"], "draft")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.library = self.root / "library"
        source = self.root / "world.glb"
        source.write_bytes(glb_bytes())
        provenance = dict(PROVENANCE, providerWorldId="same-synthetic-world")
        self.left = worlds.import_world(source, self.library, name="Official visual mesh fixture",
                                        provenance=dict(provenance, representation="hq-visual-glb"), fixture=True)
        document = glb_document()
        document["asset"]["generator"] = "Distinct original engineering fixture for the alternative mesh"
        source.write_bytes(glb_bytes(document))
        self.right = worlds.import_world(source, self.library, name="Reconstructed visual mesh fixture",
                                         provenance=dict(provenance, representation="gaussian-reconstructed-mesh"), fixture=True)
        self.scene = load_scene(ROOT / "examples" / "bottle.scene.json")
        self.scene["environment"] = copy.deepcopy(self.left["environment"])
        self.scene["environment"]["plinth"] = {"id": "plinth", "sizeM": [0.48, 0.08, 0.48], "translationM": [0, -0.04, 0]}
        self.scene["environment"]["worldColor"] = [0.21, 0.22, 0.23]
        self.scene["environment"]["props"] = [{"id": "occluder", "shape": "box", "sizeM": [0.02, 0.04, 0.01],
            "translationM": [0.1, 0.02, 0.04], "rotationXyzw": [0, 0, 0, 1],
            "material": {"baseColor": [0.2, 0.2, 0.2, 1], "roughness": 0.6, "metallic": 0}}]
        self.scene = comparison.set_alternative(self.scene, self.right["environment"])

    def test_materialized_sides_share_every_product_camera_contact_and_ambient_sample(self):
        before = copy.deepcopy(self.scene)
        payload = comparison.comparison_payload(self.scene)
        self.assertEqual(payload["pairing"], {"sameWorld": True, "worldId": "same-synthetic-world"})
        self.assertEqual(payload["alignmentStatus"], "draft")
        for key in ("product", "actions", "evidence", "placement", "shots", "render", "coordinates", "sceneId"):
            self.assertEqual(payload["a"][key], payload["b"][key])
        for key in ("plinth", "props", "worldColor"):
            self.assertEqual(payload["a"]["environment"][key], payload["b"]["environment"][key])
            self.assertEqual(payload["b"]["environment"][key], self.scene["environment"][key])
        for side in ("a", "b"):
            self.assertNotIn("comparison", payload[side])
            self.assertIs(validate_scene(payload[side]), payload[side])
        self.assertNotEqual(payload["a"]["environment"]["asset"]["sha256"], payload["b"]["environment"]["asset"]["sha256"])
        for frame in range(1, 361):
            self.assertEqual(evaluate(payload["a"], frame), evaluate(payload["b"], frame))
        payload["b"]["environment"]["plinth"]["sizeM"][0] = 999
        self.assertEqual(self.scene, before)
        self.assertEqual(payload["a"]["environment"]["plinth"]["sizeM"][0], 0.48)

    def test_world_selection_discards_library_nearfield_and_preserves_primary_plinth(self):
        alternative = self.scene["comparison"]["alternative"]
        self.assertFalse({"plinth", "props", "worldColor"} & set(alternative))
        self.assertEqual(self.scene["environment"]["plinth"]["sizeM"], [0.48, 0.08, 0.48])
        self.assertEqual(comparison.materialize(self.scene, "b")["environment"]["plinth"]["sizeM"], [0.48, 0.08, 0.48])
        self.assertIn("plinth", self.right["environment"])

    def test_shared_digest_covers_all_invariant_state_but_ignores_world_alignment(self):
        initial = comparison.comparison_payload(self.scene)
        moved = copy.deepcopy(self.scene)
        moved["comparison"]["alternative"]["asset"]["translationM"] = [3, 4, 5]
        changed = comparison.comparison_payload(moved)
        self.assertEqual(changed["sharedDigest"], initial["sharedDigest"])
        self.assertNotEqual(changed["alignmentDigest"], initial["alignmentDigest"])
        variants = [
            lambda s: s["product"]["label"].update(text="APPROVED ARTWORK B"),
            lambda s: s["shots"][0]["camera"]["from"].update(focalLengthMm=51),
            lambda s: s["render"].update(samples=16),
            lambda s: s["environment"].update(worldColor=[0.3, 0.3, 0.3]),
            lambda s: s["environment"]["props"][0]["translationM"].__setitem__(0, 0.2),
        ]
        for index, edit in enumerate(variants):
            scene = copy.deepcopy(self.scene)
            edit(scene)
            with self.subTest(index=index):
                self.assertNotEqual(comparison.comparison_payload(scene)["sharedDigest"], initial["sharedDigest"])

    def test_distinct_known_provider_worlds_are_rejected_and_unknown_lineage_is_explicit(self):
        bad = copy.deepcopy(self.scene)
        bad["comparison"]["alternative"]["provenance"]["providerWorldId"] = "another-world"
        with self.assertRaisesRegex(ValueError, "same source world"):
            validate_scene(bad)
        with self.assertRaisesRegex(ValueError, "same source world"):
            comparison.comparison_payload(bad)
        unknown = copy.deepcopy(self.scene)
        unknown["comparison"]["alternative"]["provenance"].pop("providerWorldId")
        self.assertEqual(comparison.comparison_payload(unknown)["pairing"], {"sameWorld": False, "worldId": None})
        unknown["environment"]["provenance"].pop("providerWorldId")
        self.assertEqual(comparison.comparison_payload(unknown)["pairing"], {"sameWorld": False, "worldId": None})

    def test_comparison_contract_rejects_hidden_shared_state_nonmesh_and_invalid_records(self):
        variants = [
            lambda s: s["comparison"].update(schemaVersion=True),
            lambda s: s["comparison"].update(unknown=True),
            lambda s: s["comparison"].update(calibration=[]),
            lambda s: s["comparison"].update(calibration={"c": {}}),
            lambda s: s["comparison"].update(calibration={"a": []}),
            lambda s: s["comparison"].update(reviewedAlignmentDigest="invalid"),
            lambda s: s["comparison"]["alternative"].update(kind="splat"),
            lambda s: s["comparison"]["alternative"].update(plinth=copy.deepcopy(s["environment"]["plinth"])),
            lambda s: s["comparison"]["alternative"].update(props=[]),
            lambda s: s["comparison"]["alternative"].update(worldColor=[0.2, 0.2, 0.2]),
            lambda s: s["comparison"]["alternative"]["provenance"].update(owner=""),
            lambda s: s["comparison"]["alternative"]["provenance"].update(providerWorldId=42),
            lambda s: s["comparison"]["alternative"].update(providerWorldId="conflicting-source"),
        ]
        for index, edit in enumerate(variants):
            invalid = copy.deepcopy(self.scene)
            edit(invalid)
            with self.subTest(index=index), self.assertRaises(ValueError):
                validate_scene(invalid)
        absent = comparison.materialize(self.scene, "a")
        for call in (lambda: comparison.comparison_payload(absent), lambda: comparison.materialize(self.scene, "left"),
                     lambda: comparison.review_alignment(absent)):
            with self.assertRaises(ValueError):
                call()

    def test_both_geometry_hashes_are_bundled_and_verified_without_recursive_scene_loading(self):
        before = copy.deepcopy(self.scene)
        output = self.root / "bundle"
        records = worlds.bundle_assets(self.scene, self.library, output)
        self.assertEqual(len(records), 2)
        self.assertEqual({item["sha256"] for item in records}, {self.left["environment"]["asset"]["sha256"], self.right["environment"]["asset"]["sha256"]})
        self.assertEqual(worlds.verify_scene_assets(self.scene, output), records)
        self.assertEqual(self.scene, before)
        right_path = output / self.scene["comparison"]["alternative"]["asset"]["path"]
        right_path.write_bytes(b"changed alternative geometry")
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            worlds.verify_scene_assets(self.scene, output)

    def test_identical_geometry_on_both_sides_is_copied_only_once(self):
        scene = copy.deepcopy(self.scene)
        scene["comparison"]["alternative"]["asset"] = copy.deepcopy(scene["environment"]["asset"])
        scene["comparison"]["alternative"]["asset"]["translationM"][0] = 2
        self.assertEqual(len(worlds.bundle_assets(scene, self.library, self.root / "deduplicated")), 1)

    def test_full_scene_snapshot_preserves_alternative_asset_after_source_is_removed(self):
        renderer = self.root / "renderer.py"
        renderer.write_bytes(jobs._RENDERER.read_bytes())
        source = self.library / "comparison.scene.json"
        source.write_text(json.dumps(self.scene))
        output = self.root / "job"
        with patch.object(jobs, "_RENDERER", renderer):
            job = jobs.create_job(source, output, width=144, height=256, samples=1)
            self.assertEqual(len(job["assets"]), 2)
            (self.library / self.scene["comparison"]["alternative"]["asset"]["path"]).unlink()
            self.assertEqual(jobs._verify_snapshots(output, job), self.scene)

    def test_floor_measurement_and_yaw_compose_in_raw_source_frame_without_product_motion(self):
        scene = copy.deepcopy(self.scene)
        asset = scene["environment"]["asset"]
        asset.update(translationM=[4, 10, 6], rotationXyzw=[math.sqrt(0.5), 0, 0, math.sqrt(0.5)], scaleToMeters=0.1)
        before = copy.deepcopy(scene)
        data = {"sourceFloorPoint": [1, 2, 3], "measurement": {"sourcePoints": [[0, 0, 0], [1, 2, 2]], "realDistanceM": 6},
                "yawDeltaDegrees": 90}
        result = comparison.calibrate_scene(scene, "a", data)
        calibrated = result["environment"]["asset"]
        self.assertEqual(calibrated["scaleToMeters"], 2)
        for actual, expected in zip(calibrated["rotationXyzw"], [0.5, 0.5, -0.5, 0.5]):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(calibrated["translationM"][::2], [4, 6])
        self.assertAlmostEqual(calibrated["translationM"][1], 5.92)
        record = result["comparison"]["calibration"]["a"]
        self.assertEqual(record["measurement"], data["measurement"])
        self.assertEqual(record["sourceFloorPoint"], data["sourceFloorPoint"])
        self.assertEqual(record["yawDeltaDegrees"], 90)
        self.assertEqual(record["sourceDistance"], 3)
        self.assertEqual(record["result"]["translationM"], calibrated["translationM"])
        self.assertEqual(record["history"][0]["inputs"], data)
        for frame in (1, 120, 130, 166, 240, 360):
            self.assertEqual(evaluate(scene, frame), evaluate(result, frame))
        self.assertEqual(result["comparison"]["alternative"], scene["comparison"]["alternative"])
        self.assertEqual(scene, before)
        self.assertEqual(comparison.calibrate_scene(scene, "a", data), result)

    def test_recalibrating_scale_reuses_saved_floor_and_only_changes_selected_world(self):
        floor = comparison.calibrate_scene(self.scene, "b", {"sourceFloorPoint": [0, -2, 0]})
        self.assertAlmostEqual(floor["comparison"]["alternative"]["asset"]["translationM"][1], 1.92)
        scaled = comparison.calibrate_scene(floor, "b", {"measurement": {"sourcePoints": [[0, 0, 0], [0, 3, 4]], "realDistanceM": 10}})
        self.assertAlmostEqual(scaled["comparison"]["alternative"]["asset"]["translationM"][1], 3.92)
        record = scaled["comparison"]["calibration"]["b"]
        self.assertEqual(record["sourceFloorPoint"], [0, -2, 0])
        self.assertEqual(len(record["history"]), 2)
        self.assertEqual(scaled["environment"], self.scene["environment"])
        self.assertEqual(scaled["product"], self.scene["product"])
        self.assertEqual(scaled["shots"], self.scene["shots"])

    def test_scale_without_floor_preserves_translation_and_yaw_is_normalized(self):
        scene = copy.deepcopy(self.scene)
        scene["comparison"]["alternative"]["asset"]["translationM"] = [1, 2, 3]
        result = comparison.calibrate_scene(scene, "b", {"measurement": {"sourcePoints": [[1, 1, 1], [1, 1, 3]], "realDistanceM": 0.5},
                                                        "yawDeltaDegrees": 450})
        asset = result["comparison"]["alternative"]["asset"]
        self.assertEqual(asset["scaleToMeters"], 0.25)
        self.assertEqual(asset["translationM"], [1, 2, 3])
        self.assertAlmostEqual(sum(value * value for value in asset["rotationXyzw"]), 1)
        self.assertAlmostEqual(asset["rotationXyzw"][1], math.sqrt(0.5))

    def test_malformed_or_degenerate_calibration_never_changes_the_scene(self):
        invalid = [None, {}, {"side": "a"}, {"sourceFloorPoint": [0, 1]}, {"sourceFloorPoint": [0, float("nan"), 0]},
                   {"yawDeltaDegrees": True}, {"yawDeltaDegrees": float("inf")}, {"measurement": {}},
                   {"measurement": {"sourcePoints": [[0, 0, 0], [0, 0, 0]], "realDistanceM": 1}},
                   {"measurement": {"sourcePoints": [[0, 0, 0], [1, 0, 0]], "realDistanceM": 0}},
                   {"measurement": {"sourcePoints": [[0, 0, 0], [1, 0, 0]], "realDistanceM": True}},
                   {"measurement": {"sourcePoints": [[0, 0, 0], [1, 0, 0]], "realDistanceM": 1, "units": "unknown"}}]
        before = copy.deepcopy(self.scene)
        for data in invalid:
            with self.subTest(data=data), self.assertRaises(ValueError):
                comparison.calibrate_scene(self.scene, "a", data)
        self.assertEqual(self.scene, before)

    def test_review_is_derived_and_stales_on_world_or_contact_changes(self):
        original = comparison.comparison_payload(self.scene)
        reviewed = comparison.review_alignment(self.scene)
        payload = comparison.comparison_payload(reviewed)
        self.assertEqual(payload["alignmentStatus"], "reviewed")
        self.assertEqual(payload["sharedDigest"], original["sharedDigest"])
        self.assertEqual(payload["alignmentDigest"], original["alignmentDigest"])
        self.assertNotIn("reviewedAlignmentDigest", self.scene["comparison"])
        variants = [
            lambda s: s["environment"]["asset"]["translationM"].__setitem__(0, 1),
            lambda s: s["comparison"]["alternative"]["asset"].update(scaleToMeters=2),
            lambda s: s["environment"]["plinth"]["translationM"].__setitem__(1, -0.1),
            lambda s: s["environment"]["props"][0]["translationM"].__setitem__(0, 0.2),
            lambda s: s["placement"]["translationM"].__setitem__(0, 0.01),
        ]
        for index, edit in enumerate(variants):
            stale = copy.deepcopy(reviewed)
            edit(stale)
            with self.subTest(index=index):
                self.assertIs(validate_scene(stale), stale)
                self.assertEqual(comparison.comparison_payload(stale)["alignmentStatus"], "draft")
                self.assertEqual(comparison.comparison_payload(comparison.review_alignment(stale))["alignmentStatus"], "reviewed")
        recalibrated = comparison.calibrate_scene(reviewed, "b", {"sourceFloorPoint": [0, 0, 0]})
        self.assertEqual(comparison.comparison_payload(recalibrated)["alignmentStatus"], "draft")

    def test_camera_ambient_and_calibration_bookkeeping_do_not_forge_or_remove_alignment_review(self):
        reviewed = comparison.review_alignment(self.scene)
        edited = copy.deepcopy(reviewed)
        edited["shots"][0]["camera"]["from"]["focalLengthMm"] = 55
        edited["environment"]["worldColor"] = [0.1, 0.2, 0.3]
        self.assertEqual(comparison.comparison_payload(edited)["alignmentStatus"], "reviewed")
        self.assertNotEqual(comparison.comparison_payload(edited)["sharedDigest"], comparison.comparison_payload(reviewed)["sharedDigest"])
        recorded = comparison.calibrate_scene(reviewed, "a", {"yawDeltaDegrees": 0})
        self.assertEqual(comparison.comparison_payload(recorded)["alignmentStatus"], "reviewed")
        self.assertEqual(comparison.comparison_payload(recorded)["sharedDigest"], comparison.comparison_payload(reviewed)["sharedDigest"])

    def test_lifting_the_rigid_product_100mm_invalidates_saved_placement_review(self):
        reviewed = comparison.review_alignment(self.scene)
        initial = comparison.comparison_payload(reviewed)
        lifted = copy.deepcopy(reviewed)
        for component in lifted["product"]["components"]:
            component["assembly"]["translationM"][1] += 0.1
        before = evaluate(reviewed, 1)
        after = evaluate(lifted, 1)
        for identity in before["components"]:
            self.assertAlmostEqual(after["components"][identity]["translationM"][1]
                                   - before["components"][identity]["translationM"][1], 0.1)
        self.assertEqual(before["camera"], after["camera"])
        self.assertEqual(lifted["environment"], reviewed["environment"])
        self.assertEqual(lifted["placement"], reviewed["placement"])
        payload = comparison.comparison_payload(lifted)
        self.assertEqual(initial["alignmentStatus"], "reviewed")
        self.assertEqual(payload["alignmentStatus"], "draft")
        self.assertNotEqual(payload["alignmentDigest"], initial["alignmentDigest"])
        self.assertNotEqual(payload["sharedDigest"], initial["sharedDigest"])
        self.assertEqual(comparison.comparison_payload(comparison.review_alignment(lifted))["alignmentStatus"], "reviewed")

    def test_product_geometry_motion_and_time_sampling_changes_require_fresh_placement_review(self):
        reviewed = comparison.review_alignment(self.scene)
        variants = [
            lambda s: s["product"]["dimensionsM"].__setitem__(1, 0.2),
            lambda s: s["product"]["components"][0]["sizeM"].__setitem__(1, 0.2),
            lambda s: s["product"]["components"][0]["assembly"].update(rotationXyzw=[0, math.sqrt(0.5), 0, math.sqrt(0.5)]),
            lambda s: s["actions"][0].update(distanceM=0.1),
            lambda s: s["actions"][0].update(startSeconds=5.5),
            lambda s: s["render"].update(fps=25),
            lambda s: s["shots"][-1].update(endFrame=361),
        ]
        for index, edit in enumerate(variants):
            changed = copy.deepcopy(reviewed)
            edit(changed)
            with self.subTest(index=index):
                validate_scene(changed)
                self.assertEqual(comparison.comparison_payload(changed)["alignmentStatus"], "draft")
        # Imported geometry changes are equally relevant to placement, even if
        # its declared dimensions and assembly pose are retained.
        mesh = copy.deepcopy(reviewed)
        component = mesh["product"]["components"][0]
        component.update(shape="mesh", bevelM=0, asset={"format": "glb", "sourceUp": "Y",
                         "sha256": "a" * 64, "path": "assets/" + "a" * 64 + ".glb"})
        mesh = comparison.review_alignment(mesh)
        component = mesh["product"]["components"][0]
        component["asset"].update(sha256="b" * 64, path="assets/" + "b" * 64 + ".glb")
        self.assertEqual(comparison.comparison_payload(mesh)["alignmentStatus"], "draft")


if __name__ == "__main__":
    unittest.main()
