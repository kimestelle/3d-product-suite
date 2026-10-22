"""Native source-part / artwork parity; enable with RUN_BLENDER_TESTS=1.

The fixture has duplicate names, shared mesh data, original material slots,
UVs and a nested cap child. Checks consume actual exported .blend objects and
packed PNG bytes; no GPU shading or full-resolution render is required.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

from film import products
from film.scene import evaluate, load_scene, sample_scene, validate_scene
from film.decal_geometry import primitive_triangles
from tests import test_product_mesh_blender as mesh_tests
from tests.test_worlds import PROVENANCE


ROOT = Path(__file__).resolve().parents[1]


def png_bytes():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    red, green, blue, yellow = (255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255), (255, 255, 0, 255)
    scanlines = b"".join(b"\0" + bytes(a + a + b + b) for a, b in ((red, green), (red, green), (blue, yellow), (blue, yellow)))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def write_uv_product(path):
    """Extend the original integration boxes with native UV0 and a cap child."""
    mesh_tests.write_product_glb(path)
    payload = path.read_bytes()
    length = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + length])
    binary = bytearray(payload[28 + length:])
    offset = len(binary)
    # Uploaded artwork uses the editor material convention: UV V=1 is PNG top.
    uvs = [value for _ in range(6) for pair in ((0, 0), (1, 0), (1, 1), (0, 1)) for value in pair]
    binary.extend(struct.pack("<" + "f" * len(uvs), *uvs))
    document["bufferViews"].append({"buffer": 0, "byteOffset": offset,
                                   "byteLength": len(binary) - offset, "target": 34962})
    document["accessors"].append({"bufferView": len(document["bufferViews"]) - 1,
                                  "componentType": 5126, "count": 24, "type": "VEC2"})
    uv0 = len(document["accessors"]) - 1
    offset = len(binary)
    uv1 = [1 - value if index % 2 == 0 else value for index, value in enumerate(uvs)]
    binary.extend(struct.pack("<" + "f" * len(uv1), *uv1))
    document["bufferViews"].append({"buffer": 0, "byteOffset": offset,
                                   "byteLength": len(binary) - offset, "target": 34962})
    document["accessors"].append({"bufferView": len(document["bufferViews"]) - 1,
                                  "componentType": 5126, "count": 24, "type": "VEC2"})
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"].update(TEXCOORD_0=uv0, TEXCOORD_1=len(document["accessors"]) - 1)
    offset = len(binary)
    binary.extend(png_bytes())
    document["bufferViews"].append({"buffer": 0, "byteOffset": offset,
                                   "byteLength": len(binary) - offset})
    document["images"] = [{"bufferView": len(document["bufferViews"]) - 1, "mimeType": "image/png"}]
    document["textures"] = [{"source": 0}]
    for surface in document["materials"]:
        surface["pbrMetallicRoughness"]["metallicRoughnessTexture"] = {"index": 0, "texCoord": 1}
    document["nodes"][2]["children"] = [4]
    document["nodes"].append({"name": "Repeated", "mesh": 1,
                               "translation": [0, .006, 0], "scale": [.25, .25, .25]})
    for node in document["nodes"]:
        node["name"] = "Repeated"
    document["buffers"][0]["byteLength"] = len(binary)
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 28 + len(encoded) + len(binary))
                     + struct.pack("<I4s", len(encoded), b"JSON") + encoded
                     + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_artwork(root):
    """Asymmetric opaque quadrants make flips and regenerated text detectable."""
    payload = png_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    asset = {"path": f"assets/{digest}.png", "sha256": digest, "format": "png", "width": 4, "height": 4}
    (root / asset["path"]).write_bytes(payload)
    return asset


def bottle_scene(root):
    source = root / "source.glb"
    write_uv_product(source)
    scene = products.create_product_scene(source, root, name="Nested bottle workflow fixture", provenance=PROVENANCE)
    asset = write_artwork(root)
    scene["product"]["artwork"] = [{"componentId": "product", "partId": "product::node:2", "asset": asset, "finish": "original"}]
    scene["product"]["decals"] = [{
        "id": "cap-mark", "componentId": "product", "partId": "product::node:2",
        "text": "", "subtitle": "", "artwork": asset, "centerUv": [.5, .5], "sizeUv": [.5, .4],
        "rotationDeg": 17, "heightM": .0002, "bevelM": .0001,
    }]
    scene["shots"][0]["motions"] = [{
        "id": name, "target": "product::node:2", "kind": kind, "axis": axis, "amount": amount,
        "startFrame": 1, "durationFrames": 13, "easing": "linear", "enabled": True,
    } for name, kind, axis, amount in (("lift", "move", "y", .03), ("turn", "rotate", "z", 40), ("scale", "scale", "y", 1.2))]
    scene["shots"][0]["motions"].append({"id": "child-slide", "target": "product::node:4",
        "kind": "move", "axis": "x", "amount": .004, "startFrame": 1, "durationFrames": 13,
        "easing": "linear", "enabled": True})
    return validate_scene(scene)


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1",
                     "Set RUN_BLENDER_TESTS=1 for native bottle workflow checks")
class BottleWorkflowBlenderTests(unittest.TestCase):
    run_blender = mesh_tests.ProductMeshBlenderTests.run_blender
    build = mesh_tests.ProductMeshBlenderTests.build
    verify_native = mesh_tests.ProductMeshBlenderTests.verify_native

    def test_nested_part_motion_and_artwork_survive_native_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = bottle_scene(root)
            original = (root / scene["product"]["components"][0]["asset"]["path"]).read_bytes()
            payload = sample_scene(scene)
            payload["frames"] = [frame for frame in payload["frames"] if frame["frame"] in (1, 7, 13, 120, 121, 240, 241, 360)]
            base, moved = evaluate(scene, 1), evaluate(scene, 13)
            self.assertEqual(base["parts"]["product::node:3"]["worldMatrix"], moved["parts"]["product::node:3"]["worldMatrix"])
            self.assertNotEqual(base["parts"]["product::node:2"]["worldMatrix"], moved["parts"]["product::node:2"]["worldMatrix"])
            self.assertNotEqual(base["parts"]["product::node:4"]["worldMatrix"], moved["parts"]["product::node:4"]["worldMatrix"])
            samples = self.build(root, payload)
            self.assertEqual((root / scene["product"]["components"][0]["asset"]["path"]).read_bytes(), original)
            self.verify_native(root, samples, r'''
import hashlib
conversion = Matrix.Rotation(math.pi / 2, 4, 'X')
def matrix(values):
    return Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
def close(actual, expected, label):
    error = max(abs(actual[row][column] - expected[row][column]) for row in range(4) for column in range(4))
    assert error < 2e-6, (label, error, actual, expected)
parts = {obj['source_part_id']: obj for obj in bpy.data.objects if 'gesso_source_node_index' in obj}
assert set(parts) == {f'product::node:{index}' for index in range(5)}, list(parts)
for sample in payload['frames']:
    bpy.context.scene.frame_set(sample['frame'])
    for part_id, pose in sample['parts'].items():
        close(parts[part_id].matrix_world, conversion @ matrix(pose['worldMatrix']) @ conversion.inverted(), (sample['frame'], part_id))
scene = payload['scene']
asset = scene['product']['artwork'][0]['asset']
cap = parts['product::node:2']
assert len(cap.material_slots) == 2
def upstream_images(socket, seen=None):
    seen = set() if seen is None else seen
    result = []
    for link in socket.links:
        node = link.from_node
        if node.as_pointer() in seen:
            continue
        seen.add(node.as_pointer())
        if node.type == 'TEX_IMAGE':
            result.append(node)
        for input_socket in node.inputs:
            result.extend(upstream_images(input_socket, seen))
    return result
def uv_maps(socket, seen=None):
    seen = set() if seen is None else seen
    result = set()
    for link in socket.links:
        node = link.from_node
        if node.as_pointer() in seen:
            continue
        seen.add(node.as_pointer())
        if node.type == 'UVMAP':
            result.add(node.uv_map)
        for input_socket in node.inputs:
            result.update(uv_maps(input_socket, seen))
    return result
for slot in cap.material_slots:
    surface = slot.material
    shader = surface.node_tree.nodes.get('Principled BSDF')
    links = list(shader.inputs['Base Color'].links)
    assert len(links) == 1, surface.name
    image = links[0].from_node.image
    assert image.packed_file and image.colorspace_settings.name == 'sRGB'
    assert hashlib.sha256(bytes(image.packed_file.data)).hexdigest() == asset['sha256']
    artwork_node = links[0].from_node
    assert artwork_node.inputs['Vector'].is_linked
    assert uv_maps(artwork_node.inputs['Vector']) == {cap.data.uv_layers[0].name}
    # Only artwork changes: original finish textures retain their separate UV1 atlas.
    for channel in ('Roughness', 'Metallic'):
        finishes = upstream_images(shader.inputs[channel])
        assert finishes, (surface.name, channel)
        for finish in finishes:
            assert finish.inputs['Vector'].is_linked
            assert uv_maps(finish.inputs['Vector']) == {cap.data.uv_layers[1].name}
for part_id in ('product::node:3', 'product::node:4'):
    for slot in parts[part_id].material_slots:
        shader = slot.material.node_tree.nodes.get('Principled BSDF')
        assert not shader.inputs['Base Color'].is_linked, (part_id, slot.material.name)
decals = [obj for obj in bpy.data.objects if obj.name.startswith('Decal / cap-mark')]
assert {obj['attachment_part_id'] for obj in decals} == {'product::node:2', 'product::node:4'}
for decal in decals:
    assert decal['source_part_id'] == 'product::node:2'
    target = parts[decal['attachment_part_id']]
    bpy.context.scene.frame_set(1)
    base_matrix = target.matrix_world.copy()
    base_points = [decal.matrix_world @ vertex.co for vertex in decal.data.vertices]
    bpy.context.scene.frame_set(13)
    delta = target.matrix_world @ base_matrix.inverted()
    for before, vertex in zip(base_points, decal.data.vertices):
        assert (decal.matrix_world @ vertex.co - delta @ before).length < 2e-6
assert all(key.interpolation == 'CONSTANT' for obj in bpy.data.objects
           if obj.animation_data and obj.animation_data.action
           for curve in obj.animation_data.action.fcurves for key in curve.keyframe_points)
# Render only the source mesh's actual artwork graph, unlit, to prove image
# orientation. This changes the in-memory verification scene, never the saved file.
scene = bpy.context.scene
scene.frame_set(1)
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        obj.hide_render = obj != cap
for slot in cap.material_slots:
    surface = slot.material.copy()
    slot.material = surface
    nodes, links = surface.node_tree.nodes, surface.node_tree.links
    shader = nodes.get('Principled BSDF')
    source = shader.inputs['Base Color'].links[0].from_socket
    source.node.interpolation = 'Closest'
    emission = nodes.new('ShaderNodeEmission')
    links.new(source, emission.inputs['Color'])
    links.new(emission.outputs['Emission'], nodes.get('Material Output').inputs['Surface'])
camera_data = bpy.data.cameras.new('Artwork orientation proof')
camera_data.type = 'ORTHO'
camera_data.ortho_scale = .05
camera = bpy.data.objects.new('Artwork orientation proof', camera_data)
scene.collection.objects.link(camera)
camera.location = conversion @ Vector((-.02, .02, .15))
target = conversion @ Vector((-.02, .02, 0))
camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.timeline_markers.clear()  # Exported shot markers otherwise reselect the shot camera.
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.cycles.use_denoising = False
scene.render.resolution_x = scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = args[0] + '.artwork-orientation.png'
bpy.ops.render.render(write_still=True)
proof = bpy.data.images.load(scene.render.filepath, check_existing=False)
pixels = list(proof.pixels)
for x, y, expected in ((26, 45, (1, 0, 0)), (38, 45, (0, 1, 0)),
                       (26, 19, (0, 0, 1)), (38, 19, (1, 1, 0))):
    actual = pixels[(y * 64 + x) * 4:(y * 64 + x) * 4 + 3]
    assert max(abs(a - b) for a, b in zip(actual, expected)) < .03, (x, y, actual, expected)
''')

    def test_removing_replacement_restores_source_without_changing_motion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = bottle_scene(root)
            expected = [evaluate(scene, frame) for frame in (1, 7, 13)]
            scene['product'].pop('artwork')
            scene['product'].pop('decals')
            self.assertEqual([evaluate(scene, frame) for frame in (1, 7, 13)], expected)
            payload = sample_scene(scene)
            payload['frames'] = [frame for frame in payload['frames'] if frame['frame'] in (1, 7, 13)]
            samples = self.build(root, payload)
            self.verify_native(root, samples, r'''
conversion = Matrix.Rotation(math.pi / 2, 4, 'X')
parts = {obj['source_part_id']: obj for obj in bpy.data.objects if 'gesso_source_node_index' in obj}
for sample in payload['frames']:
    bpy.context.scene.frame_set(sample['frame'])
    for part_id, pose in sample['parts'].items():
        values = pose['worldMatrix']
        expected = conversion @ Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)]) @ conversion.inverted()
        actual = parts[part_id].matrix_world
        assert max(abs(actual[row][column] - expected[row][column]) for row in range(4) for column in range(4)) < 2e-6, (sample['frame'], part_id)
meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH' and 'gesso_source_node_index' in obj]
assert len(meshes) == 3
for mesh in meshes:
    assert len(mesh.material_slots) == 2
    for slot in mesh.material_slots:
        assert slot.material.name.startswith('Original fixture surface'), slot.material.name
        assert not slot.material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].is_linked
assert not any(obj.name.startswith('Decal / ') for obj in bpy.data.objects)
''')

    def test_paper_replacement_removes_baked_finish_only_from_selected_mesh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = bottle_scene(root)
            scene['product']['artwork'][0]['finish'] = 'paper'
            scene['product'].pop('decals')
            payload = sample_scene(scene)
            payload['frames'] = [payload['frames'][0]]
            samples = self.build(root, payload)
            self.verify_native(root, samples, r'''
parts = {obj['source_part_id']: obj for obj in bpy.data.objects if 'gesso_source_node_index' in obj}
for slot in parts['product::node:2'].material_slots:
    shader = slot.material.node_tree.nodes.get('Principled BSDF')
    assert shader.inputs['Base Color'].is_linked
    for name in ('Roughness', 'Metallic', 'Transmission Weight'):
        assert not shader.inputs[name].is_linked, name
    assert abs(shader.inputs['Metallic'].default_value) < 1e-7
    assert abs(shader.inputs['Transmission Weight'].default_value) < 1e-7
    assert shader.inputs['Roughness'].default_value > .4
for part_id in ('product::node:3', 'product::node:4'):
    for slot in parts[part_id].material_slots:
        shader = slot.material.node_tree.nodes.get('Principled BSDF')
        assert not shader.inputs['Base Color'].is_linked
        assert shader.inputs['Roughness'].is_linked and shader.inputs['Metallic'].is_linked
''')

    def test_primitive_label_replacement_keeps_editor_uvs_without_old_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'assets').mkdir()
            scene = load_scene(ROOT / 'examples/bottle.scene.json')
            asset = write_artwork(root)
            label_id = scene['product']['label']['componentId']
            scene['product']['artwork'] = [{'componentId': label_id, 'partId': label_id,
                                           'asset': asset, 'finish': 'paper'}]
            label = next(component for component in scene['product']['components'] if component['id'] == label_id)
            # The preview atlas is a six-face layout. Native cube UV defaults
            # would silently move the replacement to the wrong face.
            expected = [point for triangle in primitive_triangles(label) for point in triangle]
            (root / 'editor-label-vertices.json').write_text(json.dumps(expected))
            payload = sample_scene(validate_scene(scene))
            payload['frames'] = [payload['frames'][0]]
            samples = self.build(root, payload)
            self.verify_native(root, samples, r'''
from pathlib import Path
import hashlib
label = bpy.data.objects[payload['scene']['product']['label']['componentId']]
assert not any(obj.type == 'FONT' for obj in bpy.data.objects), 'Old procedural label text overlays the replacement'
expected = json.loads((Path(args[1]).parent / 'editor-label-vertices.json').read_text())
assert len(label.data.loops) == len(expected)
assert len(label.data.uv_layers) == 1
uv = label.data.uv_layers[0]
for loop, point in zip(label.data.loops, expected):
    position = label.data.vertices[loop.vertex_index].co
    assert (position - Vector((point[0], -point[2], point[1]))).length < 1e-7
    assert max(abs(a - b) for a, b in zip(uv.data[loop.index].uv, point[6:8])) < 1e-7
shader = label.material_slots[0].material.node_tree.nodes.get('Principled BSDF')
texture = shader.inputs['Base Color'].links[0].from_node
assert texture.inputs['Vector'].links[0].from_node.uv_map == uv.name
image = texture.image
asset = payload['scene']['product']['artwork'][0]['asset']
assert image.packed_file and hashlib.sha256(bytes(image.packed_file.data)).hexdigest() == asset['sha256']
''')
