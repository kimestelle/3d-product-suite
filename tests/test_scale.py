"""Uniform product/part scale is a pose, independent of original dimensions."""

import ast
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

from film.scene import evaluate, sample_scene, scene_digest, validate_scene
from tests import test_editor_api

ROOT = Path(__file__).resolve().parents[1]


class ScaleTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads((ROOT / "examples/bottle.scene.json").read_text())
        self.cap = next(c for c in self.scene["product"]["components"] if c["id"] == "cap")

    def assertVectorAlmostEqual(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=10)

    def test_missing_scale_keeps_source_and_digest_and_matches_explicit_identity(self):
        before = copy.deepcopy(self.scene)
        digest = scene_digest(self.scene)
        validate_scene(self.scene)
        expected = sample_scene(self.scene)
        self.assertEqual(self.scene, before)
        self.assertEqual(scene_digest(self.scene), digest)
        explicit = copy.deepcopy(self.scene)
        explicit["placement"]["scale"] = 1
        for component in explicit["product"]["components"]:
            component["assembly"]["scale"] = 1
        self.assertEqual(sample_scene(explicit)["frames"], expected["frames"])
        self.assertTrue(all(pose["scale"] == 1 for frame in expected["frames"] for pose in frame["components"].values()))

    def test_scale_is_bounded_finite_positive_scalar(self):
        for field in ("placement", "assembly"):
            minimum, maximum = (1e-6, 1e6) if field == "placement" else (.01, 100)
            for value in (0, -.5, minimum * .99, maximum * 1.01, True, False, None, "2", [1, 1, 1], {}, math.inf, -math.inf, math.nan):
                with self.subTest(field=field, value=value):
                    scene = copy.deepcopy(self.scene)
                    target = scene["placement"] if field == "placement" else scene["product"]["components"][0]["assembly"]
                    target["scale"] = value
                    with self.assertRaisesRegex(ValueError, "scale"):
                        validate_scene(scene)
            for value in (minimum, 1, maximum):
                scene = copy.deepcopy(self.scene)
                target = scene["placement"] if field == "placement" else scene["product"]["components"][0]["assembly"]
                target["scale"] = value
                self.assertIs(validate_scene(scene), scene)

    def test_small_product_scale_and_absolute_keys_keep_source_and_support_coordinates(self):
        self.scene["placement"].update(translationM=[1, 2, 3], scale=.00148)
        self.cap["assembly"].update(translationM=[10, 20, 30], scale=.5)
        before = copy.deepcopy(self.scene)
        validate_scene(self.scene)
        sample = evaluate(self.scene, 1, include_placement=True)
        self.assertEqual(sample["productPlacement"], {"translationM": [1, 2, 3], "scale": .00148})
        self.assertVectorAlmostEqual(sample["components"]["cap"]["translationM"], [1.0148, 2.0296, 3.0444])
        self.assertAlmostEqual(sample["components"]["cap"]["scale"], .00074)
        self.assertEqual(self.scene, before)
        self.scene["animation"] = {"tracks": [{"id": "tiny-product", "componentId": "$product", "property": "scale", "enabled": True,
            "keys": [{"frame": 1, "value": .00148, "interpolation": "linear"}, {"frame": 25, "value": .00296, "interpolation": "linear"}]}]}
        validate_scene(self.scene)
        self.assertAlmostEqual(evaluate(self.scene, 13, include_placement=True)["productPlacement"]["scale"], .00222)
        self.assertEqual(self.scene["product"], before["product"])
        for value in (1e-6, 1e6):
            self.scene["animation"]["tracks"][0]["keys"][0]["value"] = value
            validate_scene(self.scene)
        for value in (1e-7, 1e7):
            self.scene["animation"]["tracks"][0]["keys"][0]["value"] = value
            with self.assertRaisesRegex(ValueError, "scale"):
                validate_scene(self.scene)
        self.scene["animation"]["tracks"][0].update(componentId="cap", keys=[{"frame": 1, "value": .00148, "interpolation": "linear"}])
        with self.assertRaisesRegex(ValueError, "scale"):
            validate_scene(self.scene)

    def test_relative_product_motion_keeps_existing_scale_limits(self):
        self.scene["placement"]["scale"] = .00148
        self.scene["motions"] = [{"id": "scale", "target": "$product", "kind": "scale", "axis": "y", "amount": 2,
                                  "startFrame": 1, "durationFrames": 25, "easing": "linear", "enabled": True}]
        validate_scene(self.scene)
        self.assertAlmostEqual(evaluate(self.scene, 25, include_placement=True)["productPlacement"]["scale"], .00296)
        for value in (.00148, 100.01):
            self.scene["motions"][0]["amount"] = value
            with self.assertRaisesRegex(ValueError, "Film motion amount"):
                validate_scene(self.scene)

    def test_optional_studio_size_is_bounded_without_rewriting_legacy_scenes(self):
        before = copy.deepcopy(self.scene)
        validate_scene(self.scene)
        self.assertEqual(self.scene, before)
        for value in (1e-6, .32, 1e6):
            self.scene["environment"]["studioSizeM"] = value
            self.assertIs(validate_scene(self.scene), self.scene)
        for value in (0, -1, 1e-7, 1e7, True, None, "0.32", math.inf, math.nan):
            self.scene["environment"]["studioSizeM"] = value
            with self.assertRaisesRegex(ValueError, "studio size"):
                validate_scene(self.scene)

    def test_product_scales_assembly_about_support_without_scaling_world_translation(self):
        self.scene["environment"]["plinth"].update(translationM=[4, 5, 6], sizeM=[.4, .4, .4])
        self.scene["placement"].update(translationM=[1, 2, 3], scale=2)
        self.cap["assembly"].update(translationM=[.1, .2, .3], scale=3)
        validate_scene(self.scene)
        pose = evaluate(self.scene, 1)["components"]["cap"]
        self.assertVectorAlmostEqual(pose["translationM"], [5.2, 7.6, 9.6])
        self.assertEqual(pose["scale"], 6)
        # Part scale changes its local shape, never its assembly origin.
        self.cap["assembly"]["scale"] = .5
        smaller = evaluate(self.scene, 1)["components"]["cap"]
        self.assertEqual(smaller["translationM"], pose["translationM"])
        self.assertEqual(smaller["scale"], 1)

    def test_lift_travel_scales_in_component_coordinates(self):
        s = math.sqrt(.5)
        self.cap["assembly"].update(translationM=[.1, .2, .3], rotationXyzw=[0, 0, s, s], scale=3)
        self.scene["placement"].update(translationM=[1, 2, 3], scale=2)
        self.scene["actions"][0].update(startSeconds=0, durationSeconds=2, distanceM=.06)
        validate_scene(self.scene)
        halfway = evaluate(self.scene, 25)["components"]["cap"]
        # Local +Y becomes world -X. Half of .06 m at combined 6x is .18 m.
        self.assertVectorAlmostEqual(halfway["translationM"], [1.02, 2.4, 3.6])
        self.assertVectorAlmostEqual(halfway["rotationXyzw"], [0, 0, s, s])
        self.assertEqual(halfway["scale"], 6)

    def test_screw_scales_pivot_and_lead_together_without_changing_turns(self):
        s = math.sqrt(.5)
        self.cap["assembly"].update(translationM=[.1, .2, .3], rotationXyzw=[0, 0, s, s], scale=3)
        self.scene["placement"].update(translationM=[1, 2, 3], scale=2)
        action = self.scene["actions"][0]
        action.pop("distanceM")
        action.update(type="screw", startSeconds=0, durationSeconds=2, pivotM=[.01, 0, 0],
                      turns=.5, axialTravelPerRevolutionM=.008, directionSign=1)
        validate_scene(self.scene)
        halfway = evaluate(self.scene, 25)["components"]["cap"]
        self.assertVectorAlmostEqual(halfway["translationM"], [1.188, 2.46, 3.66])
        self.assertVectorAlmostEqual(halfway["rotationXyzw"], [-.5, .5, .5, .5])
        self.assertVectorAlmostEqual(evaluate(self.scene, 49)["components"]["cap"]["translationM"], [1.176, 2.52, 3.6])
        self.assertEqual(halfway["scale"], 6)

    def test_scrubbing_scale_is_deterministic_and_never_mutates_geometry_or_actions(self):
        # Imported geometry keeps its declared source record and nominal envelope.
        digest = "a" * 64
        self.cap.update(shape="mesh", bevelM=0,
                        asset={"format": "glb", "path": f"assets/{digest}.glb", "sha256": digest, "sourceUp": "Y"})
        self.cap["assembly"]["scale"] = .35
        self.scene["placement"]["scale"] = 2.8
        before = copy.deepcopy(self.scene)
        source_digest = scene_digest(before)
        validate_scene(self.scene)
        sampled = sample_scene(self.scene)
        for frame in (360, 1, 166, 240, 1, 166):
            self.assertEqual(evaluate(self.scene, frame), sampled["frames"][frame-1])
        sampled["frames"][165]["components"]["cap"]["scale"] = 10
        self.assertAlmostEqual(evaluate(self.scene, 166)["components"]["cap"]["scale"], .98)
        self.assertEqual(self.scene, before)
        self.assertEqual(scene_digest(self.scene), source_digest)

    def test_blender_keys_sampled_scale_only_on_rigid_roots_and_accepts_old_samples(self):
        # Execute the actual animation adapter, retaining an instrumented root
        # and artwork child. This verifies the native handoff without bpy import.
        class Rotation:
            def dot(self, _): return 1
            def copy(self): return self

        class Vector:
            def __init__(self, values): self.values = values.values if isinstance(values, Vector) else values
            def __sub__(self, other): return Vector([a-b for a, b in zip(self.values, other.values)])
            @property
            def length(self): return math.sqrt(sum(x*x for x in self.values))
            def to_track_quat(self, *_): return Rotation()

        class Object:
            def __init__(self, **values):
                self.animation_data = None
                self.keys = []
                self.__dict__.update(values)
            def keyframe_insert(self, *, data_path, frame, **_):
                value = self
                for name in data_path.split("."): value = getattr(value, name)
                self.keys.append((frame, data_path, copy.deepcopy(value)))

        camera_data = Object(dof=SimpleNamespace())
        camera = Object()
        scene = SimpleNamespace(frame_set=lambda _: None, objects=[])
        objects = {"cap": Object(scale=(1, 1, 1), children=[Object(scale=(.12, .12, .12))])}
        source = ast.parse((ROOT / "scripts/blender_scene.py").read_text())
        functions = [node for node in source.body if isinstance(node, ast.FunctionDef)
                     and node.name in ("animate", "keyframe_camera_optics")]
        namespace = {
            "bpy": SimpleNamespace(context=SimpleNamespace(scene=scene, collection=SimpleNamespace(objects=SimpleNamespace(link=lambda _: None))),
                                   data=SimpleNamespace(cameras=SimpleNamespace(new=lambda _: camera_data), objects=SimpleNamespace(new=lambda *_: camera))),
            "Vector": Vector, "blender_position": lambda p: Vector([p[0], -p[2], p[1]]),
            "blender_rotation": lambda _: Rotation(), "math": math,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), "<animate>", "exec"), namespace)
        frames = [evaluate(self.scene, frame) for frame in (1, 25, 49)]
        frames[0]["components"]["cap"].pop("scale")  # Already-exported samples.
        frames[0]["camera"].pop("depthOfField")  # Pinhole before optical focus existed.
        frames[1]["camera"]["depthOfField"] = {"enabled": True, "fStop": 1.4, "focusDistanceM": .5}
        frames[1]["components"]["cap"]["scale"] = .25
        frames[2]["components"]["cap"]["scale"] = 6
        namespace["animate"]({"shots": [], "environment": {}}, frames, objects)
        self.assertEqual([key for key in objects["cap"].keys if key[1] == "scale"],
                         [(1, "scale", (1, 1, 1)), (25, "scale", (.25, .25, .25)), (49, "scale", (6, 6, 6))])
        self.assertEqual(objects["cap"].children[0].scale, (.12, .12, .12))
        self.assertEqual(objects["cap"].children[0].keys, [])
        self.assertEqual([key for key in camera_data.keys if key[1] == "dof.use_dof"],
                         [(1, "dof.use_dof", False), (25, "dof.use_dof", True), (49, "dof.use_dof", False)])
        self.assertIn((25, "dof.focus_distance", .5), camera_data.keys)
        self.assertIn((25, "dof.aperture_fstop", 1.4), camera_data.keys)


class ScaleApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_save_reopen_and_evaluate_scale_and_reject_invalid_without_touching_revision(self):
        project = self.bootstrap()["project"]
        route = f"/api/projects/{project['id']}"
        edited = copy.deepcopy(project["scene"])
        edited["placement"]["scale"] = .00148
        edited["environment"]["studioSizeM"] = .32
        edited["product"]["components"][0]["assembly"]["scale"] = .5
        status, saved, _ = self.request("PUT", route, {"scene": edited, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.request("GET", route)[1]["scene"], edited)
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": edited})
        self.assertEqual(status, 200, sampled)
        first_component = edited["product"]["components"][0]["id"]
        self.assertAlmostEqual(sampled["frames"][0]["components"][first_component]["scale"], .00074)
        self.assertEqual(sampled["frames"][0], evaluate(edited, 1))
        invalid = copy.deepcopy(edited)
        invalid["placement"]["scale"] = 0
        status, result, _ = self.request("PUT", route, {"scene": invalid, "expectedRevisionId": saved["revisionId"]})
        self.assertEqual(status, 400, result)
        reopened = self.request("GET", route)[1]
        self.assertEqual(reopened["revisionId"], saved["revisionId"])
        self.assertEqual(reopened["scene"], edited)


if __name__ == "__main__":
    unittest.main()
