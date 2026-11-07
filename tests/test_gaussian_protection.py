"""Camera bounds for protected Gaussian worlds and legacy compatibility."""

import copy
from pathlib import Path
import unittest

from film.scene import evaluate, load_scene, sample_scene, validate_scene


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "bottle.scene.json"
DIGEST = "a" * 64


class GaussianProtectionTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(EXAMPLE)
        self.scene["actions"] = []
        pose = {"positionM": [0, .25, 1], "targetM": [0, 0, 0], "focalLengthMm": 50}
        self.shot = {"id": "test-shot", "startFrame": 1, "endFrame": 5,
                     "camera": {"from": copy.deepcopy(pose), "to": copy.deepcopy(pose)}}
        self.scene["shots"] = [self.shot]
        self.environment = self.scene["environment"]
        self.bounds = {"positionMinM": [-.5, .25, .75], "positionMaxM": [.5, .75, 1.25],
                       "targetMinM": [-.1, 0, -.1], "targetMaxM": [.1, .1, .1], "outside": "black"}
        self.environment.update(
            kind="splat", revisionId="test-splat", displayName="Test splat", reviewStatus="reviewed",
            asset={"sha256": DIGEST, "format": "spz", "path": f"assets/{DIGEST}.spz",
                   "sourceUp": "Y", "scaleToMeters": 1, "translationM": [0, 0, 0],
                   "rotationXyzw": [0, 0, 0, 1]},
            gaussianProtection=self.bounds,
        )

    def test_splat_metadata_is_optional_and_camera_bounds_are_inclusive(self):
        self.bounds["outside"] = "white"
        guarded = sample_scene(self.scene)["frames"]
        self.assertEqual(guarded[0]["camera"]["positionM"][1], self.bounds["positionMinM"][1])
        self.assertEqual(guarded[0]["camera"]["targetM"][1], self.bounds["targetMinM"][1])
        del self.environment["gaussianProtection"]
        self.assertEqual(sample_scene(self.scene)["frames"], guarded)

    def test_malformed_metadata_and_non_splat_worlds_are_rejected(self):
        invalid = [
            None,
            {key: value for key, value in self.bounds.items() if key != "targetMaxM"},
            {**self.bounds, "positionMinM": [0, 1]},
            {**self.bounds, "targetMinM": [0, False, 0]},
            {**self.bounds, "positionMaxM": [.5, float("inf"), 1.25]},
            {**self.bounds, "targetMaxM": [-.2, .1, .1]},
            {**self.bounds, "outside": "gray"},
            {**self.bounds, "extra": True},
        ]
        for protection in invalid:
            with self.subTest(protection=protection):
                self.environment["gaussianProtection"] = protection
                with self.assertRaisesRegex(ValueError, "Gaussian"):
                    validate_scene(self.scene)
        self.environment["gaussianProtection"] = self.bounds
        for kind in ("authored", "mesh"):
            with self.subTest(kind=kind):
                self.environment["kind"] = kind
                with self.assertRaisesRegex(ValueError, "requires a splat environment"):
                    validate_scene(self.scene)

    def test_each_evaluated_frame_rejects_unsafe_position_after_camera_motion(self):
        self.shot["motions"] = [
            {"id": "revolution", "target": "$camera", "kind": "orbit", "axis": "y",
             "amount": 360, "startFrame": 1, "durationFrames": 5, "easing": "linear",
             "enabled": True}
        ]
        validate_scene(self.scene)
        evaluate(self.scene, 1)
        evaluate(self.scene, 5)
        with self.assertRaisesRegex(ValueError, "Camera position.*frame 2"):
            sample_scene(self.scene)
        del self.environment["gaussianProtection"]
        self.assertAlmostEqual(sample_scene(self.scene)["frames"][1]["camera"]["positionM"][0], 1)

    def test_evaluated_target_is_validated_separately_from_position(self):
        self.shot["camera"]["to"]["targetM"][0] = .2
        validate_scene(self.scene)
        with self.assertRaisesRegex(ValueError, "Camera target.*frame 5"):
            evaluate(self.scene, 5)

    def test_black_and_image_clips_can_be_sampled_outside_the_bounds(self):
        self.scene["shots"] = []
        self.scene["render"]["durationFrames"] = 5
        self.assertEqual(sample_scene(self.scene)["frames"][0]["clip"]["kind"], "black")
        self.shot["camera"]["from"]["positionM"][0] = 2
        self.shot.update(kind="image", image={"fit": "cover", "asset": {
            "path": f"assets/{DIGEST}.png", "sha256": DIGEST, "format": "png", "width": 4, "height": 4,
        }})
        self.scene["shots"] = [self.shot]
        self.assertEqual(sample_scene(self.scene)["frames"][0]["clip"]["kind"], "image")
