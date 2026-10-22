"""Optional real-Blender round-trip check: RUN_BLENDER_TESTS=1 python -m unittest discover -s tests."""

import json
import hashlib
import math
import os
from pathlib import Path
import shutil
import subprocess
import struct
import tempfile
import unittest
import zlib

from film.scene import load_scene, sample_scene, scene_digest
from film.worlds import import_world


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1", "Set RUN_BLENDER_TESTS=1 for the pinned Blender integration test")
class BlenderRoundTripTests(unittest.TestCase):
    def run_blender(self, *arguments, error=None):
        executable = shutil.which(os.environ.get("BLENDER", "blender"))
        self.assertIsNotNone(executable, "Blender 4.3.2 must be installed")
        result = subprocess.run(
            [executable, "--background", "--factory-startup", "--python-exit-code", "1", *map(str, arguments)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if error:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(error, result.stdout + result.stderr)
        else:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def world_payload(self, temporary, format_):
        manifest = json.loads((ROOT / "examples/worlds/manifest.json").read_text())
        entry = import_world(ROOT / f"examples/worlds/neutral-room.{format_}", temporary,
                             name="Original synthetic room QA", provenance=manifest["provenance"], fixture=True)
        scene = load_scene(ROOT / "examples/glass.scene.json")
        entry["environment"]["plinth"] = scene["environment"]["plinth"]
        scene["environment"] = entry["environment"]
        payload = sample_scene(scene)
        payload["frames"] = [payload["frames"][0], payload["frames"][239]]
        return payload

    def write_samples(self, temporary, payload):
        path = temporary / "samples.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def verify_native(self, temporary, samples, code, *extra):
        verification = temporary / "verify-native.py"
        verification.write_text("import bpy, json, sys\nfrom mathutils import Matrix, Quaternion, Vector\n"
                                "args=sys.argv[sys.argv.index('--')+1:]\n"
                                "bpy.ops.wm.open_mainfile(filepath=args[0])\n"
                                "payload=json.load(open(args[1]))\n" + code, encoding="utf-8")
        self.run_blender("--python", verification, "--", temporary / "scene.blend", samples, *extra)

    @staticmethod
    def png(path, color, width=72, height=128):
        def chunk(kind, payload):
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)
        payload = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                   + chunk(b"IDAT", zlib.compress((b"\0" + bytes(color) * width) * height)) + chunk(b"IEND", b""))
        path.write_bytes(payload)
        return hashlib.sha256(payload).hexdigest()

    def write_plate_manifest(self, temporary, payload, colors):
        plate = temporary / "plate"
        plate.mkdir(exist_ok=True)
        hashes = {str(frame): self.png(plate / f"{frame:06d}.png", color) for frame, color in colors.items()}
        manifest = {"schemaVersion": 1, "sourceDigest": scene_digest(payload["scene"]),
                    "assetSha256": payload["scene"]["environment"]["asset"]["sha256"],
                    "profile": {"width": 72, "height": 128, "frameNumbers": list(colors),
                                "renderer": "spark", "colorSpace": "srgb", "toneMapping": "none", "contents": "gaussian-world-only"},
                    "frames": hashes}
        (plate / "capture-manifest.json").write_text(json.dumps(manifest))
        return manifest

    def test_visual_glb_alignment_preserves_exact_near_field_and_glass(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload = self.world_payload(temporary, "glb")
            angle = 0.22
            asset = payload["scene"]["environment"]["asset"]
            asset.update(scaleToMeters=0.85, translationM=[0.04, 0.015, -0.03],
                         rotationXyzw=[0, math.sin(angle / 2), 0, math.cos(angle / 2)])
            payload["scene"]["environment"]["props"] = [{
                "id": "occlusion-probe", "shape": "box", "sizeM": [0.008, 0.04, 0.025],
                "translationM": [0.027, 0.02, 0.03], "rotationXyzw": [0, 0, 0, 1],
                "material": {"baseColor": [0.3, 0.2, 0.1, 1], "roughness": 0.3, "metallic": 0}, "bevelM": 0.001}]
            samples = self.write_samples(temporary, payload)
            self.run_blender("--python", ROOT / "scripts/blender_scene.py", "--", "--samples", samples,
                             "--output", temporary, "--frames", "1", "--width", 72, "--height", 128, "--samples-per-pixel", 2)
            self.assertTrue((temporary / "frames/000001.png").is_file())
            config = json.loads((temporary / "render-config.json").read_text())
            self.assertEqual(config["renderingPath"], "visual-glb-cycles")
            self.assertTrue(any("glass probe" in limitation for limitation in config["limitations"]))
            self.verify_native(temporary, samples, r'''
import itertools, math
source=payload["scene"]
asset=source["environment"]["asset"]
conversion=Matrix.Rotation(math.pi/2,4,"X")
x,y,z,w=asset["rotationXyzw"]
alignment=conversion @ Matrix.Translation(Vector(asset["translationM"])) @ Quaternion((w,x,y,z)).to_matrix().to_4x4() @ Matrix.Scale(asset["scaleToMeters"],4)
geometry=json.load(open(args[2]))["geometry"]
expected=[]
for box in geometry["boxes"]:
    for signs in itertools.product((-1,1),repeat=3):
        expected.append(alignment @ Vector([center+sign*size/2 for center,sign,size in zip(box["centerM"],signs,box["sizeM"])]))
actual=[obj.matrix_world @ vertex.co for obj in bpy.context.scene.objects if obj.type=="MESH" and obj.name.startswith("World / ") for vertex in obj.data.vertices]
assert len(actual)==192
for axis in range(3):
    assert abs(min(point[axis] for point in actual)-min(point[axis] for point in expected))<2e-6
    assert abs(max(point[axis] for point in actual)-max(point[axis] for point in expected))<2e-6
assert bpy.data.objects.get("Set / curved studio sweep") is None
plinth=bpy.data.objects[source["environment"]["plinth"]["id"]]
assert (plinth.location-conversion @ Vector(source["environment"]["plinth"]["translationM"])).length<1e-6
prop=bpy.data.objects["occlusion-probe"]
assert (prop.location-Vector((.027,-.03,.02))).length<1e-6
for sample in payload["frames"]:
    bpy.context.scene.frame_set(sample["frame"])
    for component_id,pose in sample["components"].items():
        assert (bpy.data.objects[component_id].location-conversion @ Vector(pose["translationM"])).length<1e-6
shader=bpy.data.objects["bottle-body"].data.materials[0].node_tree.nodes.get("Principled BSDF")
assert shader.inputs["Transmission Weight"].default_value==1
assert abs(shader.inputs["IOR"].default_value-1.47)<1e-6
''', ROOT / "examples/worlds/manifest.json")

    def test_gaussian_plates_are_verified_and_frame_matched_after_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload = self.world_payload(temporary, "ply")
            optics = {"enabled": True, "fStop": 1.4, "focusDistanceM": .5}
            payload["scene"]["shots"][0]["camera"]["depthOfField"] = optics
            payload["frames"][0]["camera"]["depthOfField"] = optics
            samples = self.write_samples(temporary, payload)
            arguments = ("--python", ROOT / "scripts/blender_scene.py", "--", "--samples", samples,
                         "--output", temporary, "--frames", "1,240", "--width", 72, "--height", 128, "--samples-per-pixel", 2)
            self.run_blender(*arguments, error="require plate/capture-manifest.json")
            manifest = self.write_plate_manifest(temporary, payload, {1: (120, 25, 10), 240: (10, 25, 120)})
            self.run_blender(*arguments, error="require sampled-camera depth of field capture")
            manifest["profile"]["depthOfField"] = "sampled-camera"
            (temporary / "plate/capture-manifest.json").write_text(json.dumps(manifest))
            self.png(temporary / "plate/000240.png", (10, 25, 120), width=74)
            self.run_blender(*arguments, error="plate resolution must match")
            manifest = self.write_plate_manifest(temporary, payload, {1: (120, 25, 10), 240: (10, 25, 120)})
            manifest["profile"]["depthOfField"] = "sampled-camera"
            (temporary / "plate/capture-manifest.json").write_text(json.dumps(manifest))
            self.run_blender(*arguments)
            config = json.loads((temporary / "render-config.json").read_text())
            self.assertEqual(config["renderingPath"], "gaussian-plate-cycles-foreground")
            self.assertTrue(config["environment"]["details"]["captureManifestVerified"])
            self.assertTrue(any("No splat depth" in limitation for limitation in config["limitations"]))
            self.verify_native(temporary, samples, r'''
scene=bpy.context.scene
assert scene.render.film_transparent
assert bpy.data.objects.get("World / visual mesh alignment") is None
assert bpy.data.objects.get("Set / curved studio sweep") is None
plate=scene.node_tree.nodes.get("Gaussian camera-matched plate")
assert plate.image.source=="SEQUENCE" and plate.frame_start==1
assert plate.image.filepath.startswith("//")
for frame,red in ((1,True),(240,False)):
    scene.frame_set(frame)
    image=bpy.data.images.load(args[2]+f"/{frame:06d}.png",check_existing=False)
    offset=(image.size[1]-2)*image.size[0]*4+4
    pixel=list(image.pixels[offset:offset+4])
    assert (pixel[0]>pixel[2])==red, (frame,pixel)
# Re-render the saved native sequence at the distant frame, independently of
# the adapter's loop, to catch incorrect sequence offsets after reopen.
scene.frame_set(240)
scene.render.filepath=args[2]+"/reopened.png"
bpy.ops.render.render(write_still=True)
image=bpy.data.images.load(scene.render.filepath,check_existing=False)
offset=(image.size[1]-2)*image.size[0]*4+4
pixel=list(image.pixels[offset:offset+4])
assert pixel[2]>pixel[0], pixel
''', temporary / "frames")

    def test_hidden_plinth_authored_floor_meets_product_support(self):
        # Exercise native sweep vertices directly, without rendering or changing
        # the product pose. Imported worlds must not receive an authored sweep.
        with tempfile.TemporaryDirectory() as temporary:
            verification = Path(temporary) / "verify-support.py"
            verification.write_text(r'''
import bpy, copy, json, runpy, sys
from pathlib import Path
args = sys.argv[sys.argv.index('--') + 1:]
module = runpy.run_path(args[0], run_name='gesso_adapter')
original = json.loads(Path(args[1]).read_text())
for kind in ('authored', 'mesh', 'splat'):
    for visible in (None, True, False):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        source = copy.deepcopy(original)
        source['environment']['kind'] = kind
        source['environment']['props'] = []
        source['environment'].pop('collider', None)
        plinth = source['environment']['plinth']
        plinth.update(translationM=[.1, .2, .3], sizeM=[.3, .12, .4])
        if visible is None:
            plinth.pop('visible', None)
        else:
            plinth['visible'] = visible
        module['environment'](source)
        sweep = bpy.data.objects.get('Set / curved studio sweep')
        if kind == 'authored':
            assert sweep is not None
            actual = min((sweep.matrix_world @ vertex.co).z for vertex in sweep.data.vertices)
            expected = (.26 if visible is False else .14) - .0001
            assert abs(actual - expected) < 1e-7, (visible, actual, expected)
        else:
            assert sweep is None, kind
        if kind == 'splat':
            assert abs(bpy.data.objects['World / shadow catcher'].location.z - .26) < 1e-7
        assert (bpy.data.objects.get(plinth['id']) is None) == (visible is False)
''', encoding="utf-8")
            self.run_blender("--python", verification, "--", ROOT / "scripts/blender_scene.py", ROOT / "examples/bottle.scene.json")

    def test_fixed_studio_size_preserves_native_room_lights_and_shadow_extent(self):
        with tempfile.TemporaryDirectory() as temporary:
            verification = Path(temporary) / "verify-studio-size.py"
            verification.write_text(r'''
import bpy, copy, json, runpy, sys
from pathlib import Path
args = sys.argv[sys.argv.index('--') + 1:]
module = runpy.run_path(args[0], run_name='gesso_adapter')
original = json.loads(Path(args[1]).read_text())
for kind in ('authored', 'splat'):
    snapshots = []
    for factor, reference in ((1, .32), (1000, .32), (1000, None)):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        source = copy.deepcopy(original)
        source['environment'].update(kind=kind, props=[])
        source['environment'].pop('collider', None)
        source['product']['dimensionsM'] = [dimension * factor for dimension in (.32, .16, .24)]
        source['placement']['scale'] = 1 / factor
        if reference is not None:
            source['environment']['studioSizeM'] = reference
            source['environment']['plinth']['translationM'] = [.1, .2, .3]
            if factor == 1000:
                source['placement']['translationM'] = [4, 5, -1.28]
        before = copy.deepcopy(source)
        module['environment'](source)
        size = reference if reference is not None else .32 * factor
        name = 'Set / curved studio sweep' if kind == 'authored' else 'World / shadow catcher'
        surface = bpy.data.objects[name]
        extent = max(abs(vertex.co.x) for vertex in surface.data.vertices)
        expected = size * (45 if kind == 'authored' else 40)
        assert abs(extent - expected) < max(1e-6, expected * 1e-6), (kind, extent, expected)
        lights = sorted((obj for obj in bpy.context.scene.objects if obj.type == 'LIGHT'), key=lambda obj: obj.name)
        snapshot = [(tuple(light.location), tuple(light.rotation_euler), light.data.energy, light.data.size) for light in lights]
        snapshots.append(snapshot)
        scale = size / .12
        key = bpy.data.objects['Studio / large soft key']
        assert abs(key.data.energy - 2.6 * scale * scale) < max(1e-6, key.data.energy * 1e-6)
        origin = [.1, -.3, .2 + .07 / 2] if reference is not None else [0, 0, 0]
        expected_position = [origin[i] + offset * scale for i, offset in enumerate((-.19, -.24, .32))]
        assert max(abs(actual - expected) for actual, expected in zip(key.location, expected_position)) < max(1e-6, size * 1e-6)
        assert source == before
    assert snapshots[0] == snapshots[1], (kind, snapshots[:2])
    assert snapshots[1] != snapshots[2], kind
''', encoding="utf-8")
            self.run_blender("--python", verification, "--", ROOT / "scripts/blender_scene.py", ROOT / "examples/bottle.scene.json")

    def test_saved_scene_preserves_every_sampled_pose(self):
        source = load_scene(ROOT / "examples" / "bottle.scene.json")
        source["shots"][0]["camera"]["depthOfField"] = {"enabled": True, "fStop": 1.4}
        source["shots"][1]["camera"]["depthOfField"] = {"enabled": True, "fStop": 5.6, "focusDistanceM": .5}
        # The third shot deliberately omits optics: reopening must restore sharp.
        payload = sample_scene(source)
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
    optics = camera["depthOfField"]
    assert scene.camera.data.dof.use_dof == optics["enabled"], sample["frame"]
    assert scene.camera.data.dof.focus_object is None
    assert abs(scene.camera.data.dof.focus_distance - optics["focusDistanceM"]) < 1e-6, sample["frame"]
    assert abs(scene.camera.data.dof.aperture_fstop - optics["fStop"]) < 1e-6, sample["frame"]
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
