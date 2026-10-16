"""Optional real-GLB product checks; enable with RUN_BLENDER_TESTS=1."""

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

from film.scene import load_scene, sample_scene


ROOT = Path(__file__).resolve().parents[1]
COMPONENT_ID = "cap"
COLORS = ((0.72, 0.08, 0.12, 1), (0.05, 0.28, 0.67, 1))


def write_product_glb(path, *, empty=False, extra=None):
    """Write original, centered metre geometry with nested nodes and two materials.

    Both mesh nodes have two material slots. Their parent translations cancel,
    leaving canonical bounds of 60 x 40 x 20 mm about the component origin.
    No Blender, numerical package, texture, or external asset is needed.
    """
    binary = bytearray()
    views, accessors = [], []

    def accessor(values, component_type, type_name, target, *, bounds=False):
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        flattened = values if type_name == "SCALAR" else [value for row in values for value in row]
        code = "f" if component_type == 5126 else "H"
        binary.extend(struct.pack("<" + code * len(flattened), *flattened))
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset, "target": target})
        item = {"bufferView": len(views) - 1, "componentType": component_type,
                "count": len(values), "type": type_name}
        if bounds:
            item["min"] = [min(point[axis] for point in values) for axis in range(3)]
            item["max"] = [max(point[axis] for point in values) for axis in range(3)]
        accessors.append(item)
        return len(accessors) - 1

    # Counterclockwise faces viewed from outside; flat normals avoid importer
    # smoothing choices affecting the original geometry or material slots.
    faces = (
        ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
        ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
        ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
        ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
        ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
        ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
    )
    positions, normals, indices = [], [], [[], []]
    half_size = (0.01, 0.02, 0.01)
    for face_index, (normal, tangent, bitangent) in enumerate(faces):
        base = len(positions)
        for first, second in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            positions.append(tuple(half_size[axis] * (normal[axis] + first * tangent[axis]
                                                     + second * bitangent[axis]) for axis in range(3)))
            normals.append(normal)
        indices[face_index % 2].extend(base + index for index in (0, 1, 2, 0, 2, 3))
    position = accessor(positions, 5126, "VEC3", 34962, bounds=True)
    normal = accessor(normals, 5126, "VEC3", 34962)
    primitive_indices = [accessor(values, 5123, "SCALAR", 34963) for values in indices]
    primitives = [{"attributes": {"POSITION": position, "NORMAL": normal},
                   "indices": primitive_indices[index], "material": index} for index in range(2)]
    document = {
        "asset": {"version": "2.0", "generator": "Original product hierarchy integration fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {"name": "Fixture root", "translation": [0.005, 0.007, -0.003], "children": [1]},
            {"name": "Fixture nested", "translation": [-0.005, -0.007, 0.003], "children": [2, 3]},
            {"name": "Fixture left", "mesh": 0, "translation": [-0.02, 0, 0]},
            {"name": "Fixture right", "mesh": 1, "translation": [0.02, 0, 0]},
        ],
        "meshes": [{"name": name, "primitives": copy.deepcopy(primitives)}
                   for name in ("Original left box", "Original right box")],
        "materials": [{"name": f"Original fixture surface {index}",
                       "pbrMetallicRoughness": {"baseColorFactor": color,
                                                "roughnessFactor": (0.27, 0.63)[index],
                                                "metallicFactor": (0.15, 0.7)[index]}}
                      for index, color in enumerate(COLORS)],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": views,
        "accessors": accessors,
    }
    if empty:
        document["nodes"] = [{"name": "Empty fixture"}]
        document["meshes"] = []
    document.update(extra or {})
    json_bytes = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    json_bytes += b" " * (-len(json_bytes) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    length = 12 + 8 + len(json_bytes) + 8 + len(binary)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, length)
                     + struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
                     + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1",
                     "Set RUN_BLENDER_TESTS=1 for the pinned Blender integration test")
class ProductMeshBlenderTests(unittest.TestCase):
    def run_blender(self, *arguments, error=None):
        executable = shutil.which(os.environ.get("BLENDER", "blender"))
        self.assertIsNotNone(executable, "Blender 4.3.2 must be installed")
        result = subprocess.run(
            [executable, "--background", "--factory-startup", "--python-exit-code", "1", *map(str, arguments)],
            capture_output=True, text=True, timeout=120,
        )
        diagnostic = result.stdout + result.stderr
        if error:
            self.assertNotEqual(result.returncode, 0, diagnostic)
            self.assertIn(error, diagnostic)
        else:
            self.assertEqual(result.returncode, 0, diagnostic)
        return result

    def product_payload(self, temporary, *, override=False, empty=False, extra=None):
        # Start from the normal validated scene and sampler. Replacing a sampled
        # component also isolates these adapter checks from schema migrations.
        payload = sample_scene(load_scene(ROOT / "examples/bottle.scene.json"))
        digest = write_product_glb(temporary / "assets/product.glb", empty=empty, extra=extra)
        component = next(item for item in payload["scene"]["product"]["components"]
                         if item["id"] == COMPONENT_ID)
        component.update(shape="mesh", asset={"format": "glb", "path": "assets/product.glb",
                                               "sha256": digest, "sourceUp": "Y"},
                         # A loose nominal envelope must never rescale imported
                         # physical geometry or replace its component origin.
                         sizeM=[0.12, 0.08, 0.04])
        if override:
            component["materialOverride"] = True
        else:
            component.pop("materialOverride", None)
        axis_length = math.sqrt(14)
        for sample in payload["frames"]:
            half_angle = (0.25 + sample["frame"] * 0.0007) / 2
            sample["components"][COMPONENT_ID]["rotationXyzw"] = [
                math.sin(half_angle) * axis / axis_length for axis in (1, 2, 3)
            ] + [math.cos(half_angle)]
        return payload

    def build(self, temporary, payload, *, error=None):
        samples = temporary / "samples.json"
        samples.write_text(json.dumps(payload), encoding="utf-8")
        self.run_blender("--python", ROOT / "scripts/blender_scene.py", "--", "--samples", samples,
                         "--output", temporary / "output", error=error)
        return samples

    def verify_native(self, temporary, samples, code):
        verification = temporary / "verify.py"
        verification.write_text(
            "import bpy, json, math, sys\n"
            "from mathutils import Matrix, Quaternion, Vector\n"
            "args=sys.argv[sys.argv.index('--')+1:]\n"
            "bpy.ops.wm.open_mainfile(filepath=args[0])\n"
            "payload=json.load(open(args[1]))\n" + code,
            encoding="utf-8",
        )
        self.run_blender("--python", verification, "--", temporary / "output/scene.blend", samples)

    def test_saved_product_hierarchy_keeps_metres_origin_materials_and_every_pose(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload = self.product_payload(temporary)
            samples = self.build(temporary, payload)
            self.assertTrue((temporary / "output/scene.blend").is_file())
            self.assertFalse((temporary / "output/frames").exists())
            self.verify_native(temporary, samples, r'''
import itertools
scene=bpy.context.scene
root=bpy.data.objects["cap"]
assert root.type=="EMPTY" and root.parent is None
assert all(abs(value-1)<1e-7 for value in root.scale)
descendants=list(root.children_recursive)
meshes=[obj for obj in descendants if obj.type=="MESH"]
assert len(meshes)==2, [(obj.name,obj.type) for obj in descendants]
assert len(descendants)==4, [(obj.name,obj.type) for obj in descendants]
assert all(obj.name.startswith("Product / cap / ") for obj in descendants)
fixture_root=next(obj for obj in descendants if obj.name.endswith("Fixture root"))
nested=next(obj for obj in descendants if obj.name.endswith("Fixture nested"))
assert fixture_root.parent==root and nested.parent==fixture_root
assert all(obj.parent==nested for obj in meshes)
conversion=Matrix.Rotation(math.pi/2,4,"X")
assert (fixture_root.location-conversion @ Vector((.005,.007,-.003))).length<1e-7
assert (nested.location-conversion @ Vector((-.005,-.007,.003))).length<1e-7
for mesh in meshes:
    assert len(mesh.material_slots)==2
    surfaces=[slot.material for slot in mesh.material_slots]
    for index,color in enumerate(((.72,.08,.12,1),(.05,.28,.67,1))):
        surface=next(item for item in surfaces if item.name.startswith(f"Original fixture surface {index}"))
        shader=surface.node_tree.nodes.get("Principled BSDF")
        assert max(abs(a-b) for a,b in zip(shader.inputs["Base Color"].default_value,color))<1e-6
        assert abs(shader.inputs["Roughness"].default_value-(.27,.63)[index])<1e-6
        assert abs(shader.inputs["Metallic"].default_value-(.15,.7)[index])<1e-6
    assert {polygon.material_index for polygon in mesh.data.polygons}=={0,1}
canonical=[Vector((center+x,y,z)) for center in (-.02,.02)
           for x,y,z in itertools.product((-.01,.01),(-.02,.02),(-.01,.01))]
expected_local=[conversion @ point for point in canonical]
actual_local=[root.matrix_world.inverted() @ mesh.matrix_world @ vertex.co
              for mesh in meshes for vertex in mesh.data.vertices]
for axis,expected_size in enumerate((.06,.02,.04)):
    lower=min(point[axis] for point in actual_local)
    upper=max(point[axis] for point in actual_local)
    assert abs(upper-lower-expected_size)<1e-7, (axis,lower,upper)
    assert abs(upper+lower)<1e-7, (axis,lower,upper)
for point in actual_local:
    assert min((point-expected).length for expected in expected_local)<1e-7
for point in expected_local:
    assert min((point-actual).length for actual in actual_local)<1e-7
for sample in payload["frames"]:
    scene.frame_set(sample["frame"])
    pose=sample["components"]["cap"]
    x,y,z,w=pose["rotationXyzw"]
    canonical_pose=Matrix.Translation(Vector(pose["translationM"])) @ Quaternion((w,x,y,z)).to_matrix().to_4x4()
    expected_pose=conversion @ canonical_pose @ conversion.inverted()
    assert max(abs(root.matrix_world[row][column]-expected_pose[row][column])
               for row in range(4) for column in range(4))<1e-6, sample["frame"]
    actual=[mesh.matrix_world @ vertex.co for mesh in meshes for vertex in mesh.data.vertices]
    expected=[conversion @ canonical_pose @ point for point in canonical]
    for point in actual:
        assert min((point-corner).length for corner in expected)<1e-6, sample["frame"]
for obj in descendants:
    assert obj.animation_data is None, obj.name
for curve in root.animation_data.action.fcurves:
    assert len(curve.keyframe_points)==len(payload["frames"])
    assert all(key.interpolation=="CONSTANT" for key in curve.keyframe_points)
''')

    def test_explicit_material_override_replaces_every_imported_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload = self.product_payload(temporary, override=True)
            samples = self.build(temporary, payload)
            self.verify_native(temporary, samples, r'''
component=next(item for item in payload["scene"]["product"]["components"] if item["id"]=="cap")
specification=component["material"]
meshes=[obj for obj in bpy.data.objects["cap"].children_recursive if obj.type=="MESH"]
assert len(meshes)==2
materials=[]
for mesh in meshes:
    assert len(mesh.material_slots)>=1
    for slot in mesh.material_slots:
        assert slot.material is not None
        materials.append(slot.material)
        shader=slot.material.node_tree.nodes.get("Principled BSDF")
        assert max(abs(a-b) for a,b in zip(shader.inputs["Base Color"].default_value,specification["baseColor"]))<1e-6
        assert abs(shader.inputs["Roughness"].default_value-specification["roughness"])<1e-6
        assert abs(shader.inputs["Metallic"].default_value-specification["metallic"])<1e-6
assert len({material.as_pointer() for material in materials})==1
''')

    def test_direct_renderer_rejects_unsafe_or_nonrigid_product_assets(self):
        cases = (
            ("traversal", {"path": "../product.glb"}, {}, "safe relative path"),
            ("hash", {"sha256": "0" * 64}, {}, "SHA256"),
            ("empty", {}, {"empty": True}, "nonempty mesh geometry"),
            ("animation", {}, {"extra": {"animations": [{"channels": [], "samplers": []}]}}, "animation"),
            ("skin", {}, {"extra": {"skins": [{"joints": [0]}]}}, "skin"),
            ("multiple-scenes", {}, {"extra": {"scenes": [{"nodes": [0]}, {"nodes": [0]}]}}, "one fully reachable active scene"),
            ("unused-node", {}, {"extra": {"nodes": [{"children": [1, 2]}, {"mesh": 0}, {"mesh": 1}, {"mesh": 0}]}}, "no unused nodes or meshes"),
            ("unused-mesh", {}, {"extra": {"nodes": [{"mesh": 0}]}}, "no unused nodes or meshes"),
        )
        for name, asset_updates, fixture_options, error in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                temporary = Path(directory)
                payload = self.product_payload(temporary, **fixture_options)
                component = next(item for item in payload["scene"]["product"]["components"]
                                 if item["id"] == COMPONENT_ID)
                component["asset"].update(asset_updates)
                self.build(temporary, payload, error=error)


if __name__ == "__main__":
    unittest.main()
