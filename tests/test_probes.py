"""Controlled probe comparisons preserve approved near-field scene state."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from film.probes import create_comparison, make_probe
from film.scene import load_scene, scene_digest
from film.worlds import import_world, verify_scene_assets

ROOT = Path(__file__).resolve().parents[1]
PROVENANCE = {"source": "Original authored synthetic comparison fixtures; not World Labs output",
              "reuseBasis": "Original QA geometry", "owner": "3d-product-suite", "allowedExternalDestinations": []}
PROBES = ("contact", "lateral", "occlusion", "glossy", "glass")
CONDITIONS = ("authored", "mesh", "splat")


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.library = self.root / "library"
        self.mesh = import_world(ROOT / "examples" / "worlds" / "neutral-room.glb", self.library,
                                 name="Synthetic authored visual mesh", provenance=PROVENANCE, fixture=True)
        self.splat = import_world(ROOT / "examples" / "worlds" / "neutral-room.ply", self.library,
                                  name="Synthetic authored Gaussian world", provenance=PROVENANCE, fixture=True)
        self.scene = load_scene(ROOT / "examples" / "bottle.scene.json")
        self.scene["environment"]["plinth"] = {"id": "plinth", "sizeM": [0.31, 0.08, 0.21], "translationM": [0.02, -0.04, -0.02]}
        self.prop = {"id": "existing-prop", "shape": "box", "sizeM": [0.025, 0.025, 0.025],
                     "translationM": [0.1, 0.0125, 0], "rotationXyzw": [0, 0, 0, 1], "bevelM": 0.001,
                     "material": {"baseColor": [0.4, 0.3, 0.2, 1], "roughness": 0.5, "metallic": 0}}
        self.scene["environment"]["props"] = [copy.deepcopy(self.prop)]
        self.source = self.library / "source.scene.json"
        self.source.write_text(json.dumps(self.scene))
        self.output = self.root / "comparison"

    def compare(self, **kwargs):
        return create_comparison(self.source, self.library, self.output, mesh_id=kwargs.pop("mesh_id", self.mesh["id"]),
                                 splat_id=kwargs.pop("splat_id", self.splat["id"]), **kwargs)

    def test_fifteen_comparison_scenes_share_exact_protected_state_per_probe(self):
        manifest = self.compare(world_id="manually-selected-pair-not-provider-verified")
        self.assertEqual(len(manifest["results"]), 15)
        self.assertEqual(manifest["sourceDigest"], scene_digest(self.scene))
        self.assertEqual({(row["probe"], row["condition"]) for row in manifest["results"]},
                         {(probe, condition) for probe in PROBES for condition in CONDITIONS})
        for probe in PROBES:
            rows = [row for row in manifest["results"] if row["probe"] == probe]
            scenes = [load_scene(self.output / row["scene"]) for row in rows]
            for field in ("product", "shots", "actions", "placement", "render"):
                self.assertTrue(all(scene[field] == scenes[0][field] for scene in scenes), f"{probe}: {field} differs across conditions")
            for scene in scenes:
                self.assertEqual(scene["environment"]["plinth"], self.scene["environment"]["plinth"])
            self.assertEqual(len({row["sceneDigest"] for row in rows}), 3)
            for field, digest in (("product", "productDigest"), ("shots", "cameraDigest"), ("actions", "actionDigest")):
                self.assertEqual(len({row[digest] for row in rows}), 1)
                self.assertEqual(rows[0][digest], scene_digest(scenes[0][field]))
            for row, scene in zip(rows, scenes):
                self.assertEqual(row["sceneDigest"], scene_digest(scene))
                self.assertEqual(scene["environment"]["kind"], row["condition"])
                if row["condition"] == "authored":
                    self.assertNotIn("asset", scene["environment"])
                else:
                    expected = self.mesh if row["condition"] == "mesh" else self.splat
                    self.assertEqual(scene["environment"]["asset"]["sha256"], expected["environment"]["asset"]["sha256"])
        self.assertNotEqual(self.mesh["environment"]["asset"]["sha256"], self.splat["environment"]["asset"]["sha256"])
        self.assertEqual(load_scene(self.source), self.scene)

    def test_all_comparison_assets_are_copied_and_verifiable_independently(self):
        manifest = self.compare()
        for entry in (self.mesh, self.splat):
            asset = entry["environment"]["asset"]
            copied = self.output / asset["path"]
            self.assertEqual(copied.read_bytes(), (self.library / asset["path"]).read_bytes())
            self.assertEqual(hashlib.sha256(copied.read_bytes()).hexdigest(), asset["sha256"])
            (self.library / asset["path"]).unlink()
        for row in manifest["results"]:
            scene = load_scene(self.output / row["scene"])
            self.assertEqual(len(verify_scene_assets(scene, self.output)), 0 if row["condition"] == "authored" else 1)

    def test_existing_props_are_preserved_including_occlusion_probe(self):
        manifest = self.compare()
        for row in manifest["results"]:
            scene = load_scene(self.output / row["scene"])
            props = scene["environment"].get("props", [])
            self.assertIn(self.prop, props, f"{row['probe']}/{row['condition']} discarded an explicit prop")
            self.assertEqual(len(props), 2 if row["probe"] == "occlusion" else 1)
        occlusion = [load_scene(self.output / row["scene"])["environment"]["props"]
                     for row in manifest["results"] if row["probe"] == "occlusion"]
        self.assertEqual(occlusion[0], occlusion[1])
        self.assertEqual(occlusion[0], occlusion[2])

    def test_added_occluder_does_not_reuse_existing_stable_id(self):
        self.scene["environment"]["props"][0]["id"] = "foreground-probe"
        existing = copy.deepcopy(self.scene["environment"]["props"][0])
        result = make_probe(self.scene, "occlusion")
        props = result["environment"]["props"]
        self.assertIn(existing, props)
        self.assertEqual(len(props), 2)
        self.assertEqual(len({prop["id"] for prop in props}), 2)

    def test_probe_variations_preserve_geometry_actions_and_source_document(self):
        before = copy.deepcopy(self.scene)
        for name in PROBES:
            result = make_probe(self.scene, name)
            self.assertEqual(result["actions"], before["actions"])
            self.assertEqual(result["placement"], before["placement"])
            for original, component in zip(before["product"]["components"], result["product"]["components"]):
                self.assertEqual({key: value for key, value in original.items() if key != "material"},
                                 {key: value for key, value in component.items() if key != "material"})
            if name == "contact":
                for shot in result["shots"]:
                    self.assertEqual(shot["camera"]["from"], shot["camera"]["to"])
            elif name == "lateral":
                self.assertLess(result["shots"][0]["camera"]["from"]["positionM"][0],
                                result["shots"][0]["camera"]["to"]["positionM"][0])
            elif name == "glass":
                for component in result["product"]["components"]:
                    if component["id"] in ("bottle-body", "neck"):
                        self.assertEqual(component["material"]["transmission"], 1)
                        self.assertGreater(component["material"]["ior"], 1)
            self.assertEqual(self.scene, before)
        with self.assertRaisesRegex(ValueError, "Unknown"):
            make_probe(self.scene, "unsupported")

    def test_outputs_cannot_be_overwritten_or_reinitialized_in_nonempty_directory(self):
        self.compare()
        before = {str(path.relative_to(self.output)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in self.output.rglob("*") if path.is_file()}
        with self.assertRaisesRegex(ValueError, "new or empty"):
            self.compare()
        after = {str(path.relative_to(self.output)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        elsewhere = self.root / "precious"
        elsewhere.mkdir()
        (elsewhere / "notes.txt").write_text("keep")
        with self.assertRaisesRegex(ValueError, "new or empty"):
            create_comparison(self.source, self.library, elsewhere, mesh_id=self.mesh["id"], splat_id=self.splat["id"])
        self.assertEqual((elsewhere / "notes.txt").read_text(), "keep")

    def test_quality_gates_measurements_and_provider_pairing_remain_unreviewed(self):
        with patch.object(subprocess, "run") as process, patch.object(subprocess, "Popen") as child:
            manifest = self.compare(world_id="manual-world-id")
        process.assert_not_called()
        child.assert_not_called()
        self.assertEqual(manifest["qualityGate"], "unreviewed")
        self.assertTrue(manifest["pairing"]["syntheticFixtures"])
        self.assertEqual(manifest["pairing"]["worldId"], "manual-world-id")
        self.assertIn("User-selected", manifest["pairing"]["basis"])
        for row in manifest["results"]:
            for field in ("review", "handsOnMinutes", "waitingMinutes", "cost"):
                self.assertIsNone(row[field])
        self.assertFalse(any(value is True for key, value in manifest.items() if "pass" in key.lower() or "approv" in key.lower()))

    def test_review_frame_numbers_are_valid_for_short_source_reels(self):
        self.scene["actions"] = []
        for index, shot in enumerate(self.scene["shots"]):
            shot.update(startFrame=index * 2 + 1, endFrame=(index + 1) * 2)
        self.source.write_text(json.dumps(self.scene))
        manifest = self.compare()
        for row in manifest["results"]:
            self.assertTrue(row["reviewFrames"])
            self.assertTrue(all(type(frame) is int and 1 <= frame <= 6 for frame in row["reviewFrames"]),
                            f"{row['probe']}/{row['condition']} has out-of-range review frames")

    def test_invalid_world_selection_reports_a_value_error_before_writes(self):
        with self.assertRaises(ValueError):
            self.compare(mesh_id="world-does-not-exist")
        self.assertFalse(self.output.exists())
        with self.assertRaisesRegex(ValueError, "visual mesh"):
            self.compare(mesh_id=self.splat["id"], splat_id=self.mesh["id"])
        self.assertFalse(self.output.exists())

    def test_authored_condition_strips_source_world_but_keeps_explicit_near_field(self):
        replacement = copy.deepcopy(self.mesh["environment"])
        replacement["plinth"] = copy.deepcopy(self.scene["environment"]["plinth"])
        replacement["props"] = copy.deepcopy(self.scene["environment"]["props"])
        self.scene["environment"] = replacement
        self.source.write_text(json.dumps(self.scene))
        manifest = self.compare()
        for row in manifest["results"]:
            scene = load_scene(self.output / row["scene"])
            self.assertEqual(scene["environment"]["plinth"], replacement["plinth"])
            if row["condition"] == "authored":
                self.assertEqual(scene["environment"]["kind"], "authored")
                self.assertNotIn("asset", scene["environment"])
                self.assertNotIn("fixture", scene["environment"])
                self.assertIn(self.prop, scene["environment"].get("props", []))


if __name__ == "__main__":
    unittest.main()
