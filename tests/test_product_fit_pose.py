"""World fitting reads the same animated product pivot used by both renderers."""

import copy
import json
from pathlib import Path
import unittest

from film.scene import evaluate, load_scene, sample_scene, validate_scene
from tests import test_editor_api
from tests.test_film_motions import motion
from tests.test_keyframes import track


EXAMPLE = Path(__file__).resolve().parents[1] / "examples/bottle.scene.json"


class ProductFitPoseTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(EXAMPLE)

    def assertPlacement(self, frame, translation, scale):
        sample = evaluate(self.scene, frame, include_placement=True)
        placement = sample["productPlacement"]
        for actual, expected in zip(placement["translationM"], translation):
            self.assertAlmostEqual(actual, expected)
        self.assertAlmostEqual(placement["scale"], scale)
        # The fixture's body has no local motion; the exposed placement must
        # reconstruct its actual canonical world pose, not a guessed envelope.
        body = self.scene["product"]["components"][0]
        for axis, local in enumerate(body["assembly"]["translationM"]):
            self.assertAlmostEqual(sample["components"][body["id"]]["translationM"][axis],
                                   placement["translationM"][axis] + local * scale)
        return placement

    def test_opt_in_adds_only_placement_and_keeps_default_samples_byte_identical(self):
        before = copy.deepcopy(self.scene)
        samples = sample_scene(self.scene)["frames"]
        for frame in (1, 166, 240, 360):
            default = evaluate(self.scene, frame)
            explicit_default = evaluate(self.scene, frame, include_placement=False)
            expanded = evaluate(self.scene, frame, include_placement=True)
            self.assertEqual(expanded.pop("productPlacement"), {"translationM": [0, 0, 0], "scale": 1})
            expected_bytes = json.dumps(samples[frame - 1], separators=(",", ":"))
            for result in (default, explicit_default, expanded):
                self.assertEqual(json.dumps(result, separators=(",", ":")), expected_bytes)
        self.assertEqual(self.scene, before)

    def test_static_support_pivot_keeps_part_scale_separate(self):
        self.scene["environment"]["plinth"].update(translationM=[4, 5, 6], sizeM=[.4, .4, .4])
        self.scene["placement"].update(translationM=[1, 2, 3], scale=2.5)
        self.scene["product"]["components"][2]["assembly"]["scale"] = 3
        validate_scene(self.scene)
        before = copy.deepcopy(self.scene)
        placement = self.assertPlacement(1, [5, 7.2, 9], 2.5)
        placement["translationM"][0] = 999
        self.assertEqual(self.scene, before)
        self.assertPlacement(1, [5, 7.2, 9], 2.5)

    def test_legacy_product_tracks_use_current_frame_and_ignore_disabled_tracks(self):
        self.scene["environment"]["plinth"].update(translationM=[4, 5, 6], sizeM=[.4, .4, .4])
        self.scene["placement"].update(translationM=[1, 2, 3], scale=2)
        self.scene["animation"] = {"tracks": [
            track("position.x", [(1, .4), (101, 1.2)], target="$product"),
            track("scale", [(1, 1), (101, 3)], target="$product"),
            track("position.y", [(1, 99)], target="$product", enabled=False),
            track("scale", [(1, 5)], target="cap"),
        ]}
        validate_scene(self.scene)
        for frame, x, scale in ((101, 5.2, 3), (1, 4.4, 1), (51, 4.8, 2), (51, 4.8, 2)):
            self.assertPlacement(frame, [x, 7.2, 9], scale)

    def test_film_ownership_exposes_shared_and_shot_local_pose_over_legacy_keys(self):
        self.scene["environment"]["plinth"].update(translationM=[4, 5, 6], sizeM=[.4, .4, .4])
        self.scene["placement"].update(translationM=[1, 2, 3], scale=2)
        self.scene["animation"] = {"tracks": [
            track("position.x", [(1, 10)], target="$product"),
            track("scale", [(1, 20)], target="$product"),
        ]}
        self.scene["motions"] = [
            {**motion(), "id": "shared-x", "axis": "x", "amount": 4, "durationFrames": 101},
            {**motion(), "id": "shared-z", "axis": "z", "amount": 6, "durationFrames": 101},
            {**motion("scale"), "id": "shared-scale", "amount": 3, "durationFrames": 101},
        ]
        self.scene["shots"][1]["motions"] = [
            {**motion(), "id": "local-x", "axis": "x", "amount": -2, "durationFrames": 101},
            {**motion("scale"), "id": "local-scale", "amount": .5, "durationFrames": 101},
        ]
        validate_scene(self.scene)
        before = copy.deepcopy(self.scene)
        self.assertPlacement(51, [7, 7.2, 12], 4)
        self.assertPlacement(171, [4, 7.2, 15], 1.5)
        self.assertPlacement(241, [9, 7.2, 15], 6)
        self.assertEqual(self.scene, before)


class ProductFitPoseApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_single_frame_requires_explicit_true_and_full_sampling_stays_unchanged(self):
        scene = self.bootstrap()["project"]["scene"]
        scene["placement"].update(translationM=[1, 2, 3], scale=2)
        scene["animation"] = {"tracks": [track("scale", [(1, 1), (101, 3)], target="$product")]}
        body = {"scene": scene, "frame": 51}
        status, default, _ = self.request("POST", "/api/evaluate", body)
        self.assertEqual(status, 200, default)
        self.assertNotIn("productPlacement", default["sample"])
        status, expanded, _ = self.request("POST", "/api/evaluate", {**body, "includePlacement": True})
        self.assertEqual(status, 200, expanded)
        self.assertEqual(expanded["sample"].pop("productPlacement"), {"translationM": [1, 2, 3], "scale": 2})
        self.assertEqual(expanded, default)
        for flag in (False, None, "true", 1):
            status, result, _ = self.request("POST", "/api/evaluate", {**body, "includePlacement": flag})
            self.assertEqual(status, 200, result)
            self.assertEqual(result, default)
        status, full, _ = self.request("POST", "/api/evaluate", {"scene": scene, "includePlacement": True})
        self.assertEqual(status, 200, full)
        self.assertTrue(all("productPlacement" not in sample for sample in full["frames"]))
        self.assertEqual(full["frames"][50], default["sample"])


if __name__ == "__main__":
    unittest.main()
