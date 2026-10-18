"""Single-frame evaluation uses the reel sampler without building the reel."""

import copy
import unittest
from unittest.mock import patch

from film import server
from film.scene import evaluate, scene_digest
from tests import test_editor_api
from tests.test_comparison_api import paired_scene


class EvaluateFrameTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_exact_current_frame_with_scaled_animation_does_not_sample_full_reel(self):
        project = self.bootstrap()["project"]
        scene = copy.deepcopy(project["scene"])
        scene["placement"]["scale"] = 2
        cap = next(c for c in scene["product"]["components"] if c["id"] == "cap")
        cap["assembly"]["scale"] = .5
        with patch.object(server, "sample_scene", wraps=server.sample_scene) as full:
            status, result, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": 166})
            full.assert_not_called()
        self.assertEqual(status, 200, result)
        self.assertEqual(result, {"scene": scene, "sample": evaluate(scene, 166), "digest": scene_digest(scene)})
        # Evaluation never persists a transient editor transform.
        self.assertEqual(self.request("GET", f"/api/projects/{project['id']}")[1], project)

    def test_frame_requires_integer_within_reel_including_null_and_boolean_rejection(self):
        scene = self.bootstrap()["project"]["scene"]
        for frame in (None, True, False, "1", 1.0, -1, 0, 361, [], {}):
            with self.subTest(frame=frame):
                status, result, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": frame})
                self.assertEqual(status, 400, result)
                self.assertIn("Frame must be in 1..360", result["error"])
        for frame in (1, 360):
            status, result, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": frame})
            self.assertEqual(status, 200, result)
            self.assertEqual(result["sample"], evaluate(scene, frame))

    def test_single_frame_preserves_scene_validation(self):
        scene = self.bootstrap()["project"]["scene"]
        scene["placement"]["scale"] = 0
        status, result, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": 1})
        self.assertEqual(status, 400, result)
        self.assertIn("product scale", result["error"])

    def test_comparison_scene_returns_same_shared_product_pose_without_pair_payload(self):
        scene = paired_scene(self.app.store)
        with patch.object(server, "comparison_payload", wraps=server.comparison_payload) as comparison:
            status, result, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": 166})
            comparison.assert_not_called()
        self.assertEqual(status, 200, result)
        self.assertEqual(result, {"scene": scene, "sample": evaluate(scene, 166), "digest": scene_digest(scene)})


if __name__ == "__main__":
    unittest.main()
