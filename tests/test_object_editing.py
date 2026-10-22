"""Framing follows actual editable objects without changing scene content."""

import copy
import itertools
import json
import math
from pathlib import Path
import unittest

from film.comparison import materialize, set_alternative, world_only
from film.object_editing import frame_scene_objects
from film.scene import validate_scene
from film.scene_objects import resolve_scene_objects


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "bottle.scene.json"


class ObjectEditingTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads(EXAMPLE.read_text())
        self.scene["environment"]["plinth"]["visible"] = False
        self.scene["environment"]["floorY"] = 0
        self.scene["placement"].update(restsOn="floor", translationM=[1, 0, -2], rotationYDegrees=35)
        self.scene["environment"]["props"] = [
            {"id": "vase", "shape": "cylinder", "sizeM": [0.08, 0.2, 0.08],
             "translationM": [0, 0, 0], "rotationXyzw": [0, 0, 0, 1],
             "material": copy.deepcopy(self.scene["product"]["components"][0]["material"]),
             "relationship": {"type": "beside", "targetId": "product", "gapM": 0.15}},
            {"id": "hidden", "visible": False, "shape": "box", "sizeM": [100, 100, 100],
             "translationM": [90, 100, -90], "rotationXyzw": [0, 0, 0, 1],
             "material": copy.deepcopy(self.scene["product"]["components"][0]["material"])}]

    def assertVectorAlmostEqual(self, actual, expected):
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=10)

    def assertBoundsFit(self, camera, bounds, aspect):
        forward = [target-position for position, target in zip(camera["positionM"], camera["targetM"])]
        length = math.hypot(*forward)
        forward = [axis/length for axis in forward]
        # Camera looks along -Z with world +Y up: right = forward cross up.
        right = [-forward[2], 0, forward[0]]
        length = math.hypot(*right)
        right = [axis/length for axis in right]
        up = [right[1]*forward[2]-right[2]*forward[1],
              right[2]*forward[0]-right[0]*forward[2],
              right[0]*forward[1]-right[1]*forward[0]]
        vertical_tan = 18/camera["focalLengthMm"]
        for corner in itertools.product(*zip(*bounds)):
            vector = [value-position for value, position in zip(corner, camera["positionM"])]
            depth = sum(a*b for a, b in zip(vector, forward))
            self.assertGreater(depth, 0)
            self.assertLess(abs(sum(a*b for a, b in zip(vector, right))), depth*vertical_tan*aspect)
            self.assertLess(abs(sum(a*b for a, b in zip(vector, up))), depth*vertical_tan)

    def test_moved_product_and_related_prop_are_centered_and_fit_every_camera(self):
        before = copy.deepcopy(self.scene)
        result = frame_scene_objects(self.scene)
        resolved = resolve_scene_objects(result)
        bounds = [resolved["product"]["boundsM"], resolved["props"]["vase"]["boundsM"]]
        low = [min(bound[0][axis] for bound in bounds) for axis in range(3)]
        high = [max(bound[1][axis] for bound in bounds) for axis in range(3)]
        expected = [(a+b)/2 for a, b in zip(low, high)]
        radius = math.dist(low, high)/2
        aspect = result["render"]["width"]/result["render"]["height"]
        for original_shot, shot in zip(self.scene["shots"], result["shots"]):
            for endpoint in ("from", "to"):
                camera = shot["camera"][endpoint]
                original = original_shot["camera"][endpoint]
                self.assertVectorAlmostEqual(camera["targetM"], expected)
                old_direction = [a-b for a, b in zip(original["positionM"], original["targetM"])]
                direction = [a-b for a, b in zip(camera["positionM"], camera["targetM"])]
                self.assertVectorAlmostEqual([v/math.hypot(*direction) for v in direction],
                                             [v/math.hypot(*old_direction) for v in old_direction])
                self.assertEqual(camera["focalLengthMm"], original["focalLengthMm"])
                half_fov = math.atan(min(1, aspect)*18/camera["focalLengthMm"])
                self.assertAlmostEqual(math.hypot(*direction), radius*1.15/math.sin(half_fov))
                for bound in bounds:
                    self.assertBoundsFit(camera, bound, aspect)
        self.assertEqual(self.scene, before)
        self.assertIsNot(result, self.scene)

    def test_product_only_ignores_props_and_visible_plinth(self):
        self.scene["environment"]["plinth"]["visible"] = True
        self.scene["environment"]["plinth"]["sizeM"] = [8, 1, 8]
        product_only = frame_scene_objects(self.scene, include_props=False)
        low, high = resolve_scene_objects(self.scene)["product"]["boundsM"]
        expected = [(a+b)/2 for a, b in zip(low, high)]
        for shot in product_only["shots"]:
            for endpoint in ("from", "to"):
                self.assertVectorAlmostEqual(shot["camera"][endpoint]["targetM"], expected)
        all_objects = frame_scene_objects(self.scene)
        self.assertGreater(math.dist(all_objects["shots"][0]["camera"]["from"]["positionM"],
                                     all_objects["shots"][0]["camera"]["from"]["targetM"]),
                           math.dist(product_only["shots"][0]["camera"]["from"]["positionM"], expected)*10)

    def test_only_camera_positions_and_targets_change_and_copy_is_independent(self):
        self.scene["shots"][0]["camera"]["to"]["focalLengthMm"] = 85
        result = frame_scene_objects(self.scene)
        for key in self.scene:
            if key != "shots":
                self.assertEqual(result[key], self.scene[key], key)
        for original, framed in zip(self.scene["shots"], result["shots"]):
            self.assertEqual({k: v for k, v in original.items() if k != "camera"},
                             {k: v for k, v in framed.items() if k != "camera"})
        result["product"]["components"][0]["sizeM"][0] = 99
        self.assertNotEqual(result["product"], self.scene["product"])

    def test_landscape_fit_uses_vertical_field_of_view(self):
        self.scene["render"].update(width=1920, height=1080)
        result = frame_scene_objects(self.scene)
        resolved = resolve_scene_objects(self.scene)
        for shot in result["shots"]:
            for endpoint in ("from", "to"):
                for bounds in (resolved["product"]["boundsM"], resolved["props"]["vase"]["boundsM"]):
                    self.assertBoundsFit(shot["camera"][endpoint], bounds, 1920/1080)

    def test_world_geometry_is_excluded_and_comparison_cameras_stay_shared(self):
        sha = "a" * 64
        self.scene["environment"].update(kind="mesh", displayName="Room", reviewStatus="unreviewed",
            asset={"sha256": sha, "path": f"assets/{sha}.glb", "format": "glb", "sourceUp": "Y",
                   "scaleToMeters": 1000, "translationM": [100, 200, 300], "rotationXyzw": [0, 0, 0, 1]})
        alternative = world_only(self.scene["environment"])
        alternative["revisionId"] = "alternative-world"
        alternative["asset"]["translationM"] = [-100, -200, -300]
        scene = set_alternative(self.scene, alternative)
        framed = frame_scene_objects(scene)
        self.assertEqual(framed["comparison"], scene["comparison"])
        self.assertEqual(framed["shots"], frame_scene_objects(self.scene)["shots"])
        left, right = materialize(framed, "a"), materialize(framed, "b")
        self.assertEqual(left["shots"], right["shots"])
        self.assertIs(validate_scene(left), left)
        self.assertIs(validate_scene(right), right)

    def test_invalid_scene_or_flag_is_rejected_without_mutating_input(self):
        before = copy.deepcopy(self.scene)
        for value in (None, 0, "yes"):
            with self.subTest(include_props=value), self.assertRaises(ValueError):
                frame_scene_objects(self.scene, include_props=value)
        self.assertEqual(self.scene, before)
        self.scene["placement"]["restsOn"] = "missing"
        with self.assertRaises(ValueError):
            frame_scene_objects(self.scene)


if __name__ == "__main__":
    unittest.main()
