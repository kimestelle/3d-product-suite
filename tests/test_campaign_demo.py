"""Explicit campaign publication keeps canonical frames and a closed asset set."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film.scene import evaluate
from film.worlds import verify_scene_assets
from scripts.build_campaign_demo import build_campaign_demo, public_metadata
from scripts.build_static_demo import build_demo


class CampaignDemoTests(unittest.TestCase):
    def fixture(self, root):
        source = root / "library"
        fixture = build_demo(source)
        scene = deepcopy(fixture["project"]["scene"])
        scene["product"]["provenance"]["sourceFile"] = "/Users/private/person/draft.blend"
        path = root / "revision.json"
        path.write_text(json.dumps({"createdAt": "ignored", "scene": scene}))
        return path, source

    def test_selected_assets_and_frames_are_exact_and_private_metadata_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene_path, source = self.fixture(root)
            before = scene_path.read_bytes()
            # Unreferenced workspace files must never be published.
            (source / "private.txt").write_text("not part of this campaign")
            out = root / "public"
            with patch("urllib.request.urlopen", side_effect=AssertionError("No network")):
                bootstrap, manifest = build_campaign_demo(scene_path, source, out, name="Selected demo")
            scene = bootstrap["project"]["scene"]
            self.assertEqual(bootstrap["project"]["id"], "demo")
            self.assertEqual(bootstrap["demo"]["playbackMode"], "sampled")
            self.assertEqual(bootstrap["project"]["name"], "Selected demo")
            self.assertEqual(scene["product"]["provenance"]["sourceFile"], "draft.blend")
            samples = json.loads((out / "samples.json").read_text())
            for frame in (1, 120, 203, 360):
                self.assertEqual(samples["frames"][frame - 1], evaluate(scene, frame))
            self.assertEqual(scene_path.read_bytes(), before)
            self.assertNotIn("/Users/", (out / "bootstrap.json").read_text())
            self.assertEqual(len(manifest["assets"]), 3)
            self.assertEqual({path.relative_to(out).as_posix() for path in out.rglob("*") if path.is_file()},
                             {"bootstrap.json", "samples.json", "manifest.json", *[item["path"] for item in manifest["assets"]]})
            verify_scene_assets(scene, out)
            self.assertEqual(build_campaign_demo(scene_path, source, out, name="Selected demo"), (bootstrap, manifest))

    def test_unexpected_output_is_not_published_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene_path, source = self.fixture(root)
            out = root / "public"; out.mkdir()
            (out / "unrelated.mp4").write_bytes(b"private")
            with self.assertRaisesRegex(ValueError, "unexpected file"):
                build_campaign_demo(scene_path, source, out)
            self.assertEqual((out / "unrelated.mp4").read_bytes(), b"private")
            self.assertFalse((out / "bootstrap.json").exists())

    def test_explicit_world_replaces_only_one_room_and_keeps_saved_motion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene_path, source = self.fixture(root)
            fixture = json.loads((source / "bootstrap.json").read_text())
            world = deepcopy(fixture["worlds"][0])
            world["id"] = world["environment"]["revisionId"] = "selected-botanical-mesh"
            world["name"] = world["environment"]["displayName"] = "Selected Botanical visual mesh"
            world_path = root / "world.json"
            world_path.write_text(json.dumps(world))
            out = root / "public"
            bootstrap, manifest = build_campaign_demo(scene_path, source, out,
                world_replacements={"botanical-room": world_path})
            expected = deepcopy(world)
            baseline_environment = bootstrap["project"]["scene"]["environment"]
            for key in ("plinth", "props", "floorY", "studioSizeM"):
                if key in baseline_environment:
                    expected["environment"][key] = deepcopy(baseline_environment[key])
                else:
                    expected["environment"].pop(key, None)
            self.assertEqual(bootstrap["worlds"][-1], expected)
            self.assertEqual(len(bootstrap["worlds"]), 2)
            omitted = fixture["worlds"][1]["environment"]["asset"]["path"]
            self.assertNotIn(omitted, {asset["path"] for asset in manifest["assets"]})
            self.assertFalse((out / omitted).exists())
            samples = json.loads((out / "samples.json").read_text())
            original = json.loads((source / "samples.json").read_text())
            self.assertEqual(samples["frames"], original["frames"])
            verify_scene_assets({"environment": world["environment"]}, out)
            with self.assertRaisesRegex(ValueError, "Unknown offline"):
                build_campaign_demo(scene_path, source, root / "unknown",
                    world_replacements={"misspelled-room": world_path})
            world["environment"]["asset"]["sha256"] = "0" * 64
            world_path.write_text(json.dumps(world))
            with self.assertRaises(ValueError):
                build_campaign_demo(scene_path, source, root / "corrupt",
                    world_replacements={"botanical-room": world_path})

    def test_private_metadata_and_credential_fields_fail_closed(self):
        self.assertEqual(public_metadata({"owner": "Credited author", "path": "C:\\Users\\Person\\model.blend"}),
                         {"owner": "Credited author", "path": "model.blend"})
        with self.assertRaisesRegex(ValueError, "credential"):
            public_metadata({"api_key": "must not publish"})
        with self.assertRaisesRegex(ValueError, "embedded private"):
            public_metadata({"source": "Copied from /Users/private/model.blend"})


if __name__ == "__main__":
    unittest.main()
