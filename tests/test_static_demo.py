"""Public demo packaging uses original fixtures and the canonical evaluator only."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film.scene import evaluate, validate_scene
from film.textures import inspect_texture
from film.worlds import verify_scene_assets
from scripts.build_static_demo import build_demo


class StaticDemoTests(unittest.TestCase):
    def test_original_offline_bundle_has_verified_assets_and_real_frames(self):
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.urlopen", side_effect=AssertionError("No network in demo builder")):
            output = Path(directory)
            bootstrap = build_demo(output)
            samples = json.loads((output / "samples.json").read_text())
            scene = validate_scene(bootstrap["project"]["scene"])
            self.assertEqual(bootstrap["project"]["id"], "demo")
            self.assertTrue(bootstrap["capabilities"]["staticDemo"])
            self.assertFalse(bootstrap["capabilities"]["blenderAvailable"])
            self.assertFalse(bootstrap["capabilities"]["githubWorldsAvailable"])
            self.assertEqual(len(samples["frames"]), 360)
            for frame in (1, 120, 121, 131, 166, 203, 240, 360):
                self.assertEqual(samples["frames"][frame - 1], evaluate(scene, frame))
            self.assertFalse(scene["environment"]["plinth"]["visible"])
            self.assertEqual(scene["placement"]["restsOn"], "floor")
            self.assertEqual(len(bootstrap["worlds"]), 2)
            for world in bootstrap["worlds"]:
                self.assertTrue(world["environment"]["fixture"])
                self.assertIn("Original authored offline", world["environment"]["provenance"]["source"])
                world_scene = {**scene, "environment": world["environment"]}
                validate_scene(world_scene)
                verify_scene_assets(world_scene, output)
            verify_scene_assets(scene, output)
            label = scene["product"]["components"][-1]["labelTexture"]["asset"]
            data = (output / label["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), label["sha256"])
            self.assertEqual(inspect_texture(data, "png"), {"widthPx": 256, "heightPx": 320})
            self.assertEqual(len(list((output / "assets").iterdir())), 3)
            # Rebuilding uses the same bytes and address rather than duplicating.
            self.assertEqual(build_demo(output), bootstrap)

    def test_unexpected_output_cannot_be_published_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            private = output / "private-export.glb"
            private.write_bytes(b"must stay private")
            with self.assertRaisesRegex(ValueError, "unexpected file"):
                build_demo(output)
            self.assertEqual(private.read_bytes(), b"must stay private")
            self.assertFalse((output / "bootstrap.json").exists())

    def test_output_symlink_cannot_publish_outside_content(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "demo"
            output.mkdir()
            (output / "leak").symlink_to(Path(directory), target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "unexpected file"):
                build_demo(output)


if __name__ == "__main__":
    unittest.main()
