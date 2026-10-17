"""Optional native-scene relationship checks; enable RUN_BLENDER_TESTS=1."""

import copy
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from film.scene import load_scene, sample_scene
from film.scene_objects import resolve_scene_objects


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1", "Set RUN_BLENDER_TESTS=1 for Blender integration")
class SceneObjectsBlenderTests(unittest.TestCase):
    def run_blender(self, *arguments):
        executable = shutil.which(os.environ.get("BLENDER", "blender"))
        self.assertIsNotNone(executable, "Blender 4.3.2 must be installed")
        result = subprocess.run([executable, "--background", "--factory-startup", "--python-exit-code", "1", *map(str, arguments)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def build(self, temporary, payload):
        samples = temporary / "samples.json"
        samples.write_text(json.dumps(payload), encoding="utf-8")
        self.run_blender("--python", ROOT / "scripts/blender_scene.py", "--", "--samples", samples,
                         "--output", temporary / "output")
        self.assertFalse((temporary / "output/frames").exists())
        return samples

    def verify_native(self, temporary, samples, code):
        verification = temporary / "verify.py"
        verification.write_text("import bpy, json, math, sys\nfrom mathutils import Matrix, Quaternion, Vector\n"
                                "args=sys.argv[sys.argv.index('--')+1:]\n"
                                "bpy.ops.wm.open_mainfile(filepath=args[0])\n"
                                "payload=json.load(open(args[1]))\n"
                                "conversion=Matrix.Rotation(math.pi/2,4,'X')\n" + code, encoding="utf-8")
        self.run_blender("--python", verification, "--", temporary / "output/scene.blend", samples)

    def test_hidden_plinth_solved_contacts_side_clearance_prop_keys_floor_and_lighting_survive_reopen(self):
        source = load_scene(ROOT / "examples/bottle.scene.json")
        source["environment"]["plinth"].update(visible=False, translationM=[7, 8, 9])
        source["environment"]["floorY"] = .25
        source["placement"].update(restsOn="table", rotationYDegrees=35)
        for component in source["product"]["components"]:
            component["assembly"]["translationM"][0] += .04
            component["assembly"]["translationM"][2] += .03
        body = source["product"]["components"][0]
        body["assembly"]["rotationXyzw"] = [0, math.sin(.15), 0, math.cos(.15)]
        # The cap is already moving at our first exported frame; it must not
        # become the lighting rig's reference merely because it is listed first.
        source["product"]["components"].sort(key=lambda component: component["id"] != "cap")
        surface = copy.deepcopy(body["material"])
        source["environment"]["props"] = [
            {"id": "table", "shape": "box", "sizeM": [.8, .2, .6], "translationM": [9, 9, 9],
             "rotationXyzw": [0, 0, 0, 1], "material": surface,
             "relationship": {"type": "on", "targetId": "floor", "offsetM": [.6, 0, -.4]}},
            {"id": "side-object", "shape": "box", "sizeM": [.05, .08, .06], "translationM": [8, 8, 8],
             "rotationXyzw": [0, math.sin(.1), 0, math.cos(.1)], "material": surface,
             "relationship": {"type": "beside", "targetId": "product", "gapM": .04}},
            {"id": "hidden-object", "shape": "box", "sizeM": [.1, .1, .1], "translationM": [0, 0, 0],
             "rotationXyzw": [0, 0, 0, 1], "material": surface, "visible": False},
        ]
        resolved = resolve_scene_objects(source)
        payload = sample_scene(source)
        payload["frames"] = [payload["frames"][179], payload["frames"][239], payload["frames"][-1]]
        # The renderer must consume each pose, even when a future evaluator
        # supplies moving props instead of today's static relationship graph.
        payload["frames"][1]["props"]["side-object"]["translationM"][0] += .2
        payload["frames"][1]["props"]["side-object"]["rotationXyzw"] = [0, math.sin(.4), 0, math.cos(.4)]
        payload["testExpected"] = resolved
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            samples = self.build(temporary, payload)
            config = json.loads((temporary / "output/render-config.json").read_text())
            self.assertFalse(config["nearField"]["resolvedFirstFrame"]["visiblePlinth"])
            self.assertEqual(set(config["nearField"]["resolvedFirstFrame"]["props"]), {"table", "side-object"})
            for actual, expected in zip(config["nearField"]["resolvedFirstFrame"]["productOriginM"], resolved["product"]["translationM"]):
                self.assertAlmostEqual(actual, expected, places=6)
            self.verify_native(temporary, samples, r'''
scene=bpy.context.scene
source=payload['scene']
assert bpy.data.objects.get(source['environment']['plinth']['id']) is None
assert bpy.data.objects.get('hidden-object') is None
floor=bpy.data.objects['Set / curved studio sweep']
assert abs(min((floor.matrix_world @ vertex.co).z for vertex in floor.data.vertices)-.25)<1e-6
for sample in payload['frames']:
    scene.frame_set(sample['frame'])
    for identity,pose in sample['props'].items():
        if identity=='hidden-object': continue
        obj=bpy.data.objects[identity]
        assert (obj.location-conversion @ Vector(pose['translationM'])).length<1e-6, (identity,obj.location,pose)
        x,y,z,w=pose['rotationXyzw']
        q=Quaternion((w,x,y,z))
        q=conversion.to_quaternion() @ q @ conversion.to_quaternion().conjugated()
        assert abs(abs(obj.rotation_quaternion.dot(q))-1)<1e-6
        assert obj.animation_data is not None
        for curve in obj.animation_data.action.fcurves:
            assert len(curve.keyframe_points)==len(payload['frames'])
            assert all(key.interpolation=='CONSTANT' for key in curve.keyframe_points)
scene.frame_set(payload['frames'][0]['frame'])
def canonical_bounds(obj):
    points=[conversion.inverted() @ obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return [[min(p[axis] for p in points) for axis in range(3)], [max(p[axis] for p in points) for axis in range(3)]]
body=canonical_bounds(bpy.data.objects['bottle-body'])
table=canonical_bounds(bpy.data.objects['table'])
assert abs(body[0][1]-table[1][1])<1e-6, (body,table)
side=canonical_bounds(bpy.data.objects['side-object'])
assert abs(side[0][0]-payload['testExpected']['product']['boundsM'][1][0]-.04)<1e-6
root=conversion @ Vector(payload['testExpected']['product']['translationM'])
size=max(source['product']['dimensionsM'])
key=bpy.data.objects['Studio / large soft key']
assert (key.location-root-Vector((-.19,-.24,.32))*(size/.12)).length<1e-6
expected_direction=(root+Vector((0,0,size*.52))-key.location).normalized()
actual_direction=key.rotation_euler.to_quaternion() @ Vector((0,0,-1))
assert (expected_direction-actual_direction).length<1e-6
''')

    def test_legacy_visible_plinth_floor_and_props_without_sampled_prop_records_remain_compatible(self):
        source = load_scene(ROOT / "examples/bottle.scene.json")
        source["environment"]["plinth"]["translationM"] = [.2, .3, -.4]
        surface = copy.deepcopy(source["product"]["components"][0]["material"])
        source["environment"]["props"] = [{"id": "legacy-prop", "shape": "box", "sizeM": [.1, .1, .1],
            "translationM": [.4, .2, -.1], "rotationXyzw": [0, 0, 0, 1], "material": surface}]
        payload = sample_scene(source)
        payload["frames"] = [payload["frames"][0], payload["frames"][-1]]
        for sample in payload["frames"]:
            sample.pop("props")
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            samples = self.build(temporary, payload)
            self.verify_native(temporary, samples, r'''
source=payload['scene']
plinth=source['environment']['plinth']
assert bpy.data.objects.get(plinth['id']) is not None
floor=bpy.data.objects['Set / curved studio sweep']
height=plinth['translationM'][1]-plinth['sizeM'][1]/2
assert abs(min(vertex.co.z for vertex in floor.data.vertices)-height)<1e-6
for sample in payload['frames']:
    bpy.context.scene.frame_set(sample['frame'])
    prop=bpy.data.objects['legacy-prop']
    assert (prop.location-conversion @ Vector((.4,.2,-.1))).length<1e-6
''')
