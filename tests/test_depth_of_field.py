"""Optical focus is a sampled camera property, never an accumulated UI effect."""
import copy
import math
from pathlib import Path
import unittest

from film.scene import evaluate, load_scene, sample_scene, validate_scene

EXAMPLE = Path(__file__).resolve().parents[1] / "examples/bottle.scene.json"


class DepthOfFieldTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(EXAMPLE)
        self.camera = self.scene["shots"][0]["camera"]

    def test_legacy_scene_stays_sharp_without_mutating_source(self):
        before = copy.deepcopy(self.scene)
        for frame in (1, 60, 121, 240, 360):
            camera = evaluate(self.scene, frame)["camera"]
            self.assertEqual(camera["depthOfField"], {
                "enabled": False, "fStop": 2.8,
                "focusDistanceM": math.dist(camera["positionM"], camera["targetM"]),
            })
        self.assertEqual(self.scene, before)

    def test_automatic_focus_uses_evaluated_target_not_interpolated_endpoint_distances(self):
        self.scene["actions"] = []
        self.scene["shots"] = [self.scene["shots"][0]]
        self.scene["shots"][0]["endFrame"] = 3
        self.camera["from"].update(positionM=[1, 1, 1], targetM=[0, 0, 0])
        self.camera["to"].update(positionM=[-1, 1, 1], targetM=[0, 0, 0])
        self.camera["depthOfField"] = {"enabled": True, "fStop": 1.4}
        validate_scene(self.scene)
        optics = evaluate(self.scene, 2)["camera"]["depthOfField"]
        self.assertEqual(optics, {"enabled": True, "fStop": 1.4, "focusDistanceM": math.sqrt(2)})
        self.assertNotEqual(optics["focusDistanceM"], math.sqrt(3))

    def test_manual_focus_and_aperture_are_per_shot_and_disabled_state_does_not_leak(self):
        self.camera["depthOfField"] = {"enabled": True, "fStop": .7, "focusDistanceM": .42}
        self.scene["shots"][1]["camera"]["depthOfField"] = {"enabled": False, "fStop": 32, "focusDistanceM": .8}
        frames = sample_scene(self.scene)["frames"]
        for frame in (1, 60, 120):
            self.assertEqual(frames[frame-1]["camera"]["depthOfField"], self.camera["depthOfField"])
        self.assertEqual(frames[120]["camera"]["depthOfField"], {"enabled": False, "fStop": 32, "focusDistanceM": .8})
        self.assertFalse(frames[240]["camera"]["depthOfField"]["enabled"])
        self.assertEqual(frames[240]["camera"]["depthOfField"]["fStop"], 2.8)

    def test_optics_require_boolean_and_finite_bounded_numbers_even_when_disabled(self):
        valid = {"enabled": False, "fStop": 2.8, "focusDistanceM": .3}
        invalid = [None, [], {}, {"enabled": True}, {"fStop": 2.8}]
        for field, values in {
            "enabled": [0, 1, "true", None],
            "fStop": [True, "2.8", None, float("nan"), float("inf"), .69, 32.01],
            "focusDistanceM": [True, "1", None, float("nan"), float("inf"), 0, -.1, .0009, 1000.01],
        }.items():
            invalid += [{**valid, field: value} for value in values]
        for optics in invalid:
            with self.subTest(optics=optics):
                self.camera["depthOfField"] = optics
                with self.assertRaises(ValueError): validate_scene(self.scene)
        for distance in (.001, 1000):
            self.camera["depthOfField"] = {**valid, "focusDistanceM": distance}
            validate_scene(self.scene)

    def test_enabled_manual_focus_must_remain_beyond_both_focal_endpoints(self):
        self.camera["from"]["focalLengthMm"] = 50
        self.camera["to"]["focalLengthMm"] = 85
        for distance in (.05, .075, .085):
            with self.subTest(distance=distance):
                self.camera["depthOfField"] = {"enabled": True, "fStop": 2.8, "focusDistanceM": distance}
                with self.assertRaisesRegex(ValueError, "beyond the focal length"): validate_scene(self.scene)
        self.camera["depthOfField"]["focusDistanceM"] = .086
        validate_scene(self.scene)

    def test_enabled_auto_focus_checks_interior_of_entire_path(self):
        self.camera["from"].update(positionM=[.1, 0, .02], targetM=[0, 0, 0], focalLengthMm=50)
        self.camera["to"].update(positionM=[-.1, 0, .02], targetM=[0, 0, 0], focalLengthMm=50)
        self.camera["depthOfField"] = {"enabled": True, "fStop": 2.8}
        with self.assertRaisesRegex(ValueError, "target must remain beyond"): validate_scene(self.scene)
        self.camera["depthOfField"]["enabled"] = False
        validate_scene(self.scene)  # Existing pinhole cameras remain valid.


if __name__ == "__main__":
    unittest.main()
