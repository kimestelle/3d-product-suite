"""Real pinned-Blender label checks; enable with RUN_BLENDER_TESTS=1."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

from film.scene import load_scene, sample_scene
from tests.test_product_mesh_blender import write_product_glb


ROOT = Path(__file__).resolve().parents[1]


def write_artwork(directory):
    """An asymmetric RGBA image: opaque red top, transparent green bottom."""
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))

    raw = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"\x00" + bytes((255, 0, 0, 255)) * 2
                                           + b"\x00" + bytes((0, 255, 0, 0)) * 2))
           + chunk(b"IEND", b""))
    digest = hashlib.sha256(raw).hexdigest()
    path = directory / "assets" / f"{digest}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return {"format": "png", "path": f"assets/{digest}.png", "sha256": digest, "widthPx": 2, "heightPx": 2}


def add_source_uv(path):
    """Attach raw glTF UVs to the independent nested GLB fixture."""
    raw = path.read_bytes()
    json_size = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + json_size])
    binary = bytearray(raw[28 + json_size:])
    position = document["accessors"][0]
    count = position["count"]
    offset = len(binary)
    uv_values = [(0.1, 0.2), (0.9, 0.2), (0.9, 0.8), (0.1, 0.8)] * (count // 4)
    binary.extend(struct.pack("<" + "f" * count * 2, *[value for uv in uv_values for value in uv]))
    document["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset, "target": 34962})
    document["accessors"].append({"bufferView": len(document["bufferViews"]) - 1,
                                  "componentType": 5126, "count": count, "type": "VEC2"})
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["attributes"]["TEXCOORD_0"] = len(document["accessors"]) - 1
    document["buffers"][0]["byteLength"] = len(binary)
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    length = 12 + 8 + len(encoded) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, length)
                     + struct.pack("<I4s", len(encoded), b"JSON") + encoded
                     + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1",
                     "Set RUN_BLENDER_TESTS=1 for pinned Blender label integration tests")
class LabelBlenderTests(unittest.TestCase):
    def run_blender(self, *arguments, error=None):
        executable = shutil.which(os.environ.get("BLENDER", "blender"))
        self.assertIsNotNone(executable, "Blender 4.3.2 must be installed")
        result = subprocess.run([executable, "--background", "--factory-startup", "--python-exit-code", "1",
                                 *map(str, arguments)], capture_output=True, text=True, timeout=120)
        diagnostic = result.stdout + result.stderr
        if error:
            self.assertNotEqual(result.returncode, 0, diagnostic)
            self.assertIn(error, diagnostic)
        else:
            self.assertEqual(result.returncode, 0, diagnostic)
        return result

    def payload(self, temporary, *, mesh=False, uv=False):
        payload = sample_scene(load_scene(ROOT / "examples/bottle.scene.json"))
        payload["frames"] = payload["frames"][:1]
        # The normal synthetic label component also has procedural text, which
        # uploaded artwork must replace without leaving the old lettering.
        component_id = payload["scene"]["product"]["label"]["componentId"]
        component = next(item for item in payload["scene"]["product"]["components"] if item["id"] == component_id)
        if mesh:
            digest = write_product_glb(temporary / "assets/product.glb")
            if uv:
                digest = add_source_uv(temporary / "assets/product.glb")
            component.update(shape="mesh", sizeM=[0.06, 0.04, 0.02],
                             asset={"format": "glb", "path": "assets/product.glb", "sha256": digest, "sourceUp": "Y"})
        component["labelTexture"] = {
            "asset": write_artwork(temporary),
            "mapping": {"mode": "uv" if uv else "planar", "face": "front", "scale": [0.8, 0.7],
                        "offset": [0.03, -0.07], "rotationDegrees": 23},
            "material": {"baseColor": [1, 0.8, 0.6, 1], "roughness": 0.82, "metallic": 0.24, "ior": 1.42},
        }
        return payload, component

    def build(self, temporary, payload, error=None):
        samples = temporary / "samples.json"
        samples.write_text(json.dumps(payload), encoding="utf-8")
        self.run_blender("--python", ROOT / "scripts/blender_scene.py", "--", "--samples", samples,
                         "--output", temporary / "output", error=error)
        return samples

    def verify(self, temporary, samples, code):
        script = temporary / "verify.py"
        script.write_text(
            "import bpy, json, math, sys\nfrom mathutils import Vector, Matrix\n"
            "args=sys.argv[sys.argv.index('--')+1:]\n"
            "bpy.ops.wm.open_mainfile(filepath=args[0])\n"
            "payload=json.load(open(args[1]))\n"
            "component=next(c for c in payload['scene']['product']['components'] if c.get('labelTexture'))\n"
            "root=bpy.data.objects[component['id']]\n"
            "meshes=[root] if root.type=='MESH' else [obj for obj in root.children_recursive if obj.type=='MESH']\n"
            + code, encoding="utf-8")
        self.run_blender("--python", script, "--", temporary / "output/scene.blend", samples)

    def test_nested_mesh_keeps_original_surfaces_and_packs_opaque_print_shader(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload, component = self.payload(temporary, mesh=True)
            samples = self.build(temporary, payload)
            # A saved blend must retain the artwork after the job bundle moves.
            (temporary / component["labelTexture"]["asset"]["path"]).unlink()
            self.verify(temporary, samples, r'''
assert len(meshes)==2
assert not any(obj.name.startswith("Label / ") for obj in bpy.data.objects)
for obj in meshes:
    assert len(obj.data.vertices)==24 and len(obj.data.polygons)==12
    assert len(obj.material_slots)==2
    for slot in obj.material_slots:
        material=slot.material
        tree=material.node_tree
        output=next(node for node in tree.nodes if node.type=="OUTPUT_MATERIAL" and node.is_active_output)
        mix=tree.nodes["Gesso Label Over Original Surface"]
        assert output.inputs["Surface"].links[0].from_node==mix
        original=mix.inputs[1].links[0].from_node
        original_index=0 if material.name.startswith("Original fixture surface 0") else 1
        assert abs(original.inputs["Roughness"].default_value-(.27,.63)[original_index])<1e-6
        assert abs(original.inputs["Metallic"].default_value-(.15,.7)[original_index])<1e-6
        printed=tree.nodes["Gesso Label Surface"]
        assert abs(printed.inputs["Roughness"].default_value-.82)<1e-6
        assert abs(printed.inputs["Metallic"].default_value-.24)<1e-6
        assert abs(printed.inputs["IOR"].default_value-1.42)<1e-6
        assert printed.inputs["Transmission Weight"].default_value==0
        image=tree.nodes["Gesso Label Artwork"].image
        assert image.packed_file and image.colorspace_settings.name=="sRGB" and image.alpha_mode=="STRAIGHT"
        assert tuple(image.size)==(2,2)
        pixels=list(image.pixels)
        assert pixels[3]==0 and pixels[11]==1, pixels
    transform=root.matrix_world.inverted() @ obj.matrix_world
    normal_transform=transform.to_3x3().inverted().transposed()
    uv=obj.data.uv_layers["Gesso Label UV"]
    coverage=obj.data.attributes["Gesso Label Coverage"]
    angle=math.radians(-23)
    for polygon in obj.data.polygons:
        n=normal_transform @ polygon.normal
        n.normalize()
        # Blender -Y is canonical +Z/front, despite animated root pose.
        for index in polygon.loop_indices:
            p=transform @ obj.data.vertices[obj.data.loops[index].vertex_index].co
            u=(p.x/.06-.03)/.8
            v=(p.z/.04+.07)/.7
            expected=(math.cos(angle)*u-math.sin(angle)*v+.5,
                      math.sin(angle)*u+math.cos(angle)*v+.5)
            assert max(abs(a-b) for a,b in zip(uv.data[index].uv,expected))<1e-5, (uv.data[index].uv,expected)
            assert coverage.data[index].value==float(n.y<0)
''')
            report = json.loads((temporary / "output/render-config.json").read_text())
            details = next(item for item in report["productComponents"] if item["id"] == component["id"])
            self.assertTrue(details["labelTexture"]["packedInBlend"])

    def test_source_uv_preserves_imported_uv_and_glTF_artwork_orientation(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload, component = self.payload(temporary, mesh=True, uv=True)
            component["labelTexture"]["mapping"].update(scale=[1, 1], offset=[0, 0], rotationDegrees=0)
            samples = self.build(temporary, payload)
            self.verify(temporary, samples, r'''
for obj in meshes:
    assert len(obj.data.uv_layers)==2
    original=obj.data.uv_layers[0]
    label=obj.data.uv_layers["Gesso Label UV"]
    assert len(original.data)==len(label.data)
    for source,target in zip(original.data,label.data):
        assert (source.uv-target.uv).length<1e-6
    # Raw glTF top edge V=.2 becomes conventional image-up V=.8.
    assert abs(min(loop.uv.y for loop in label.data)-.2)<1e-6
    assert abs(max(loop.uv.y for loop in label.data)-.8)<1e-6
    assert abs(label.data[0].uv.y-.8)<1e-6
    assert all(abs(value.value-1)<1e-6 for value in obj.data.attributes["Gesso Label Coverage"].data)
''')

    def test_no_uv_mesh_fails_with_mapping_choice_instead_of_silent_blank_artwork(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            payload, component = self.payload(temporary, mesh=True)
            component["labelTexture"]["mapping"]["mode"] = "uv"
            self.build(temporary, payload, error="no source UV map; choose Front or Wrap")

    def test_rendered_print_uses_top_orientation_and_preserves_alpha_and_outside_surface(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            asset = write_artwork(temporary)
            script = temporary / "render-label.py"
            script.write_text(r'''
import bpy, importlib.util, json, sys
from pathlib import Path
from mathutils import Vector
spec=importlib.util.spec_from_file_location("renderer", "''' + str(ROOT / "scripts/blender_scene.py") + r'''")
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
args=sys.argv[sys.argv.index('--')+1:]
directory=Path(args[0]);asset=json.loads(args[1])
assert bpy.app.version==(4,3,2)
bpy.ops.object.select_all(action="SELECT");bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine="CYCLES";scene.cycles.samples=8;scene.cycles.use_denoising=False
scene.render.resolution_x=64;scene.render.resolution_y=64;scene.render.resolution_percentage=100
scene.view_settings.view_transform="Standard";scene.render.image_settings.color_mode="RGBA"
scene.world.use_nodes=True
scene.world.node_tree.nodes["Background"].inputs["Color"].default_value=(1,1,1,1)
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value=.8
surface=r.material("Original blue substrate",(0,0,1,1))
shader=surface.node_tree.nodes["Principled BSDF"]
shader.inputs["Emission Color"].default_value=(0,0,1,1)
shader.inputs["Emission Strength"].default_value=1
shader.inputs["Specular IOR Level"].default_value=0
obj=r.primitive("product","box",(1,1,.1),surface)
component={"shape":"box","sizeM":[1,1,.1],"labelTexture":{"asset":asset,
    "mapping":{"mode":"planar","face":"front","scale":[.5,.8],"offset":[0,0],"rotationDegrees":0},
    "material":{"baseColor":[1,1,1,1],"roughness":1,"metallic":0}}}
r.apply_label_texture(obj,component,directory)
camera_data=bpy.data.cameras.new("Camera");camera=bpy.data.objects.new("Camera",camera_data)
bpy.context.collection.objects.link(camera);camera_data.type="ORTHO";camera_data.ortho_scale=1.5
camera.location=(0,-3,0);camera.rotation_euler=(Vector((0,0,0))-camera.location).to_track_quat("-Z","Y").to_euler()
scene.camera=camera
scene.render.filepath=str(directory/"label.png")
bpy.ops.render.render(write_still=True)
image=bpy.data.images.load(scene.render.filepath,check_existing=False)
pixels=list(image.pixels)
def rgb(x,y):
    return pixels[(y*64+x)*4:(y*64+x)*4+3]
red=rgb(32,40);alpha=rgb(32,23);outside=rgb(15,40)
assert red[0]>.35 and red[0]>red[2]*3, ("top opaque label",red)
assert alpha[2]>.7 and alpha[0]<.1, ("transparent lower label",alpha)
assert outside[2]>.7 and outside[0]<.1, ("outside UV bounds",outside)
for material in obj.data.materials:
    material.node_tree.nodes["Gesso Label Opacity"].inputs[1].default_value=0
scene.render.filepath=str(directory/"zero-opacity.png")
bpy.ops.render.render(write_still=True)
pixels=list(bpy.data.images.load(scene.render.filepath,check_existing=False).pixels)
original=rgb(32,40)
assert original[2]>.7 and original[0]<.1, ("zero print opacity",original)
bpy.data.objects.remove(obj,do_unlink=True)
camera.location=(0,3,0);camera.rotation_euler=(-camera.location).to_track_quat("-Z","Y").to_euler()
for name,scale,offset in (("full-wrap",[1,1],[0,0]),("rear-label",[.4,1],[.5,0])):
    obj=r.primitive(name,"cylinder",(1,1,1),surface)
    component["shape"]="cylinder";component["sizeM"]=[1,1,1]
    component["labelTexture"]["mapping"].update(mode="cylindrical",scale=scale,offset=offset)
    r.apply_label_texture(obj,component,directory)
    scene.render.filepath=str(directory/(name+".png"))
    bpy.ops.render.render(write_still=True)
    pixels=list(bpy.data.images.load(scene.render.filepath,check_existing=False).pixels)
    for x in (30,33):
        seam=rgb(x,45)
        assert seam[0]>.5 and seam[0]>seam[2]+.3 and seam[2]<.45, (name,"rear seam",x,seam)
    bpy.data.objects.remove(obj,do_unlink=True)
''', encoding="utf-8")
            self.run_blender("--python", script, "--", temporary, json.dumps(asset))

    def test_primitive_cylinder_face_masks_seams_and_six_planar_orientations(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            script = temporary / "mapping.py"
            script.write_text(r'''
import bpy, importlib.util, math
from mathutils import Vector
spec=importlib.util.spec_from_file_location("renderer", "''' + str(ROOT / "scripts/blender_scene.py") + r'''")
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
assert bpy.app.version==(4,3,2)
faces={"front":((.2,.3,.5),(0,0,1),(.7,.8)),
       "back":((.2,.3,-.5),(0,0,-1),(.3,.8)),
       "right":((.5,.3,.2),(1,0,0),(.3,.8)),
       "left":((-.5,.3,.2),(-1,0,0),(.7,.8)),
       "top":((.2,.5,.3),(0,1,0),(.7,.2)),
       "bottom":((.2,-.5,.3),(0,-1,0),(.7,.8))}
for face,(p,n,expected) in faces.items():
    uv,mask=r.label_coordinates(p,Vector(n),(1,1,1),{"mode":"planar","face":face})
    assert max(abs(a-b) for a,b in zip(uv,expected))<1e-7, (face,uv,expected)
    assert mask==1
    assert r.label_coordinates(p,-Vector(n),(1,1,1),{"mode":"planar","face":face})[1]==0
obj=r.primitive("cylinder", "cylinder", (1,2,1), r.material("base",(1,1,1,1)))
component={"shape":"cylinder","sizeM":[1,2,1],"labelTexture":{"mapping":{"mode":"cylindrical"}}}
r.label_uvs(obj,obj,component)
uv=obj.data.uv_layers["Gesso Label UV"]
mask=obj.data.attributes["Gesso Label Coverage"]
for polygon in obj.data.polygons:
    indices=list(polygon.loop_indices)
    values=[uv.data[index].uv.x for index in indices]
    if len(indices)==4:
        assert max(values)-min(values)<.02, values
        assert all(mask.data[index].value==1 for index in indices)
    else:
        assert all(mask.data[index].value==0 for index in indices)
''', encoding="utf-8")
            self.run_blender("--python", script)

    def test_direct_renderer_rejects_changed_hash_path_and_image_dimensions(self):
        cases = (({"path": "../artwork.png"}, "path must be assets/"),
                 ({"sha256": "0" * 64}, "path must be assets/"),
                 ({"widthPx": 3}, "dimensions do not match"),
                 ({"format": "svg"}, "PNG or JPEG"))
        for updates, error in cases:
            with self.subTest(updates=updates), tempfile.TemporaryDirectory() as directory:
                temporary = Path(directory)
                payload, component = self.payload(temporary)
                component["labelTexture"]["asset"].update(updates)
                self.build(temporary, payload, error=error)


if __name__ == "__main__":
    unittest.main()
