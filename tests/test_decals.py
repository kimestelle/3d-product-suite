"""Decal persistence, UV geometry, and relief stay explicit and bounded."""
import copy
import json
import math
from pathlib import Path
import struct
import unittest

from film.decal_geometry import (decal_coordinate, decal_surface_height, imported_triangles,
                                 primitive_triangles, project_triangle)
from film.scene import evaluate, scene_digest, validate_scene
from tests import test_editor_api

ROOT = Path(__file__).resolve().parents[1]


def decal(**updates):
    return {"id": "label-decal", "componentId": "label", "partId": "label", "text": "MORA",
            "subtitle": "BOTANICAL / 50mL", "centerUv": [.5, .75], "sizeUv": [.28, .36],
            "rotationDeg": 0, "heightM": .0002, "bevelM": .0001, **updates}


class DecalValidationTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads((ROOT / "examples/bottle.scene.json").read_text())

    def test_decals_round_trip_without_changing_pose_or_legacy_label(self):
        before = copy.deepcopy(self.scene)
        self.scene["product"]["decals"] = [decal()]
        self.assertEqual(validate_scene(json.loads(json.dumps(self.scene))), self.scene)
        self.assertEqual(evaluate(before, 150), evaluate(self.scene, 150))
        self.assertEqual(self.scene["product"]["label"], before["product"]["label"])
        self.assertNotEqual(scene_digest(before), scene_digest(self.scene))

    def test_rejects_unbounded_nonfinite_or_mistargeted_decals(self):
        changes = [
            {"id": ""}, {"id": "x"*121}, {"componentId": "missing"}, {"partId": "cap"},
            {"partId": "label::node:1"}, {"text": "x"*201}, {"subtitle": None},
            {"centerUv": [-.1, .5]}, {"centerUv": [.5]}, {"centerUv": [.5, math.nan]},
            {"sizeUv": [.001, 1]}, {"sizeUv": [1, math.inf]}, {"sizeUv": [True, 1]},
            {"rotationDeg": -181}, {"rotationDeg": 181}, {"heightM": .011},
            {"heightM": -1}, {"heightM": 0, "bevelM": .0001}, {"bevelM": .00011},
        ]
        for update in changes:
            with self.subTest(update=update):
                scene = copy.deepcopy(self.scene)
                scene["product"]["decals"] = [decal(**update)]
                with self.assertRaises(ValueError):
                    validate_scene(scene)
        for value in ({}, [decal(), decal()], [decal(id=str(i)) for i in range(33)]):
            self.scene["product"]["decals"] = value
            with self.assertRaises(ValueError):
                validate_scene(self.scene)


class DecalApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_save_reopen_and_reject_bad_relief_without_mutating_saved_revision(self):
        project = self.bootstrap()["project"]
        route = f"/api/projects/{project['id']}"
        edited = copy.deepcopy(project["scene"])
        edited["product"]["decals"] = [decal()]
        status, saved, _ = self.request("PUT", route, {"scene": edited, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.request("GET", route)[1]["scene"]["product"]["decals"], [decal()])
        edited["product"]["decals"][0]["bevelM"] = .003
        status, error, _ = self.request("PUT", route, {"scene": edited, "expectedRevisionId": saved["revisionId"]})
        self.assertEqual(status, 400, error)
        self.assertIn("bevel", error["error"])
        self.assertEqual(self.request("GET", route)[1]["revisionId"], saved["revisionId"])


class DecalGeometryTests(unittest.TestCase):
    def test_front_box_atlas_does_not_repeat_on_back_face(self):
        component = {"shape": "box", "sizeM": [.04, .05, .002], "bevelM": 0}
        patches = [p for t in primitive_triangles(component) for p in project_triangle(t, decal())]
        self.assertGreater(len(patches), 0)
        self.assertTrue(all(v[2] >= .001-1e-12 for triangle in patches for v in triangle))
        top = [v[2] for triangle in patches for v in triangle]
        self.assertAlmostEqual(max(top), .0012)
        self.assertAlmostEqual(min(top), .001)
        self.assertTrue(all(-1e-9 <= channel <= 1+1e-9 for triangle in patches for v in triangle for channel in v[6:8]))

    def test_rounded_box_and_lathe_retain_native_uv_seams_and_extent(self):
        for shape in ("box", "cylinder"):
            triangles = list(primitive_triangles({"shape": shape, "sizeM": [.06, .12, .06], "bevelM": .003}))
            vertices = [point for triangle in triangles for point in triangle]
            self.assertTrue(all(math.isfinite(value) for point in vertices for value in point))
            for axis, size in enumerate((.06, .12, .06)):
                self.assertAlmostEqual(max(point[axis] for point in vertices)-min(point[axis] for point in vertices), size)
            self.assertTrue(all(-1e-9 <= value <= 1+1e-9 for point in vertices for value in point[6:8]))

    def test_rounded_box_central_float32_sign_keeps_the_same_uv_arc_as_three(self):
        triangles = list(primitive_triangles({"shape": "box", "sizeM": [.06, .12, .06], "bevelM": .003}))
        # Independent Three.js RoundedBoxGeometry + 3x2 atlas reference.
        point = triangles[10][2]
        self.assertAlmostEqual(point[6], .3199562728404999, places=7)
        self.assertAlmostEqual(point[7], .5)

    def test_rotation_and_quarter_circle_bevel_are_measured_in_meters(self):
        d = decal(centerUv=[.5, .5], sizeUv=[.2, .4], rotationDeg=90)
        q = decal_coordinate([.5, .6], d)
        self.assertAlmostEqual(q[0], 1)
        self.assertAlmostEqual(q[1], .5)
        self.assertAlmostEqual(decal_surface_height(0, .002, .001), .001)
        self.assertAlmostEqual(decal_surface_height(.001, .002, .001), .002)
        self.assertGreater(decal_surface_height(.0005, .002, .001), .0015)

    def test_uv_gap_and_degenerate_uv_do_not_gain_invented_geometry(self):
        triangle = ((0,0,0,0,0,1,0,0), (1,0,0,0,0,1,.1,0), (0,1,0,0,0,1,0,.1))
        self.assertEqual(project_triangle(triangle, decal()), [])
        degenerate = tuple(v[:6]+(0,0) for v in triangle)
        self.assertEqual(project_triangle(degenerate, decal()), [])

    def test_imported_node_selection_preserves_source_uv_and_transforms(self):
        binary = struct.pack("<9f", -.1,-.1,0, .1,-.1,0, 0,.1,0) + struct.pack("<6f", 0,0, 1,0, .5,1)
        document = {"asset": {"version":"2.0"}, "scene":0, "scenes":[{"nodes":[0]}],
                    "nodes":[{"children":[1,2]}, {"mesh":0,"translation":[0,0,.1]}, {"mesh":0,"translation":[0,0,-.1]}],
                    "meshes":[{"primitives":[{"attributes":{"POSITION":0,"TEXCOORD_0":1}}]}],
                    "buffers":[{"byteLength":len(binary)}],
                    "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":24}],
                    "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},
                                 {"bufferView":1,"componentType":5126,"count":3,"type":"VEC2"}]}
        data = json.dumps(document).encode()
        data += b" " * (-len(data)%4)
        payload = struct.pack("<4sII", b"glTF",2,28+len(data)+len(binary))+struct.pack("<I4s",len(data),b"JSON")+data+struct.pack("<I4s",len(binary),b"BIN\0")+binary
        selected = list(imported_triangles(payload,"product::node:1","product"))
        self.assertEqual(len(selected),1)
        self.assertTrue(all(abs(v[2]-.1)<1e-8 for v in selected[0]))
        self.assertEqual([v[6:8] for v in selected[0]],[(0,0),(1,0),(.5,1)])
        self.assertEqual(len(list(imported_triangles(payload,"product::node:0","product"))),2)
        with self.assertRaisesRegex(ValueError,"does not exist"):
            list(imported_triangles(payload,"product::node:3","product"))
