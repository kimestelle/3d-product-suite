"""Optional real-Blender round-trip check: RUN_BLENDER_TESTS=1 python -m unittest discover -s tests."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from film.scene import load_scene, sample_scene


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1", "Set RUN_BLENDER_TESTS=1 for the pinned Blender integration test")
class BlenderRoundTripTests(unittest.TestCase):
    def run_blender(self, *arguments):
        executable = shutil.which(os.environ.get("BLENDER", "blender"))
        self.assertIsNotNone(executable, "Blender 4.3.2 must be installed")
        result = subprocess.run(
            [executable, "--background", "--factory-startup", "--python-exit-code", "1", *map(str, arguments)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_saved_scene_preserves_every_sampled_pose(self):
        payload = sample_scene(load_scene(ROOT / "examples" / "bottle.scene.json"))
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            samples = temporary / "samples.json"
            output = temporary / "output"
            samples.write_text(json.dumps(payload), encoding="utf-8")
            self.run_blender(
                "--python", ROOT / "scripts" / "blender_scene.py", "--",
                "--samples", samples, "--output", output,
            )
            self.assertTrue((output / "scene.blend").is_file())
            self.assertFalse((output / "frames").exists(), "Default invocation must build without rendering")
            configuration = json.loads((output / "render-config.json").read_text())
            self.assertEqual(configuration["blenderVersion"], "4.3.2")
            self.assertEqual(configuration["seed"], payload["scene"]["render"]["seed"])
            verification = temporary / "verify.py"
            verification.write_text(
                r'''
import json
import math
import sys
import bpy
from mathutils import Matrix, Quaternion, Vector

arguments = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.open_mainfile(filepath=arguments[0])
payload = json.load(open(arguments[1]))
conversion = Matrix.Rotation(math.pi / 2, 4, "X")
scene = bpy.context.scene
assert scene.frame_end == payload["frames"][-1]["frame"]
assert scene.camera.data.sensor_fit == "VERTICAL"
assert scene.camera.data.sensor_height == 36
for obj in scene.objects:
    if obj.type == "FONT":
        assert obj.data.font is not None and obj.data.font.filepath == "<builtin>"
        assert obj.data.body and obj.dimensions.length > 0
for component in payload["scene"]["product"]["components"]:
    vertices = bpy.data.objects[component["id"]].data.vertices
    actual_size = [max(vertex.co[axis] for vertex in vertices) - min(vertex.co[axis] for vertex in vertices) for axis in range(3)]
    x, y, z = component["sizeM"]
    assert max(abs(actual - expected) for actual, expected in zip(actual_size, (x, z, y))) < 1e-7, component["id"]
scene.frame_set(payload["frames"][0]["frame"])
body = bpy.data.objects["bottle-body"]
plinth = bpy.data.objects[payload["scene"]["environment"]["plinth"]["id"]]
body_bottom = min((body.matrix_world @ Vector(corner)).z for corner in body.bound_box)
plinth_top = max((plinth.matrix_world @ Vector(corner)).z for corner in plinth.bound_box)
assert abs(body_bottom - plinth_top) < 1e-6, (body_bottom, plinth_top)
for sample in payload["frames"]:
    scene.frame_set(sample["frame"])
    for component_id, transform in sample["components"].items():
        x, y, z, w = transform["rotationXyzw"]
        canonical = Matrix.Translation(Vector(transform["translationM"])) @ Quaternion((w, x, y, z)).to_matrix().to_4x4()
        expected = conversion @ canonical @ conversion.inverted()
        actual = bpy.data.objects[component_id].matrix_world
        assert max(abs(actual[row][column] - expected[row][column]) for row in range(4) for column in range(4)) < 1e-6, (sample["frame"], component_id)
    camera = sample["camera"]
    position = conversion @ Vector(camera["positionM"])
    target = conversion @ Vector(camera["targetM"])
    assert (scene.camera.matrix_world.translation - position).length < 1e-6, sample["frame"]
    forward = scene.camera.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    assert (forward - (target - position).normalized()).length < 1e-6, sample["frame"]
    assert abs(scene.camera.data.lens - camera["focalLengthMm"]) < 1e-4, sample["frame"]
for action in bpy.data.actions:
    for curve in action.fcurves:
        assert all(key.interpolation == "CONSTANT" for key in curve.keyframe_points)
print("ROUNDTRIP_COMPLETE", len(payload["frames"]), "frames")
''',
                encoding="utf-8",
            )
            self.run_blender("--python", verification, "--", output / "scene.blend", samples)


if __name__ == "__main__":
    unittest.main()
