"""Blender conversion boundaries and optional real Blender product imports."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from film import blend_import, products
from film.products import inspect_product_glb
from tests.test_products import product_glb

BLENDER = os.environ.get("BLENDER", "/private/tmp/gesso-blender-4.3.2/Blender.app/Contents/MacOS/Blender")
REPORT = {"sourceFormat": "blend", "sourceScene": "Product", "sourceFrame": 7,
          "blenderVersion": "4.3.2", "sourceUnitSystem": "METRIC", "sourceScaleToMeters": .001,
          "objectCount": 4, "meshCount": 2, "warnings": []}


class BlendImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "product.blend"
        self.source.write_bytes(b"BLENDER-v403" + b"synthetic wrapper fixture")
        self.output = self.root / "converted.glb"
        self.conversion_paths = []

    def converted_process(self, command, **kwargs):
        output = Path(command[command.index("--output") + 1])
        report = Path(command[command.index("--report") + 1])
        self.conversion_paths.extend((output, report))
        output.write_bytes(product_glb())
        report.write_text(json.dumps(REPORT))
        self.assertIsInstance(command, list)
        self.assertIn("--background", command)
        self.assertIn("--factory-startup", command)
        self.assertIn("--disable-autoexec", command)
        self.assertEqual(command[command.index("--python-exit-code") + 1], "1")
        self.assertFalse(kwargs.get("shell", False))
        self.assertGreater(kwargs["timeout"], 0)
        self.assertLessEqual(kwargs["timeout"], 300)
        self.assertNotEqual(output, self.output)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    def assert_cleaned(self):
        for path in self.conversion_paths:
            self.assertFalse(path.exists(), f"Conversion temporary file retained: {path}")

    def test_safe_conversion_validates_before_publish_and_keeps_source(self):
        before = self.source.read_bytes()
        with patch.object(blend_import.subprocess, "run", side_effect=self.converted_process) as run:
            report = blend_import.convert_blend_product(self.source, self.output, blender="/configured/blender")
        self.assertEqual(run.call_args.args[0][0], "/configured/blender")
        for key, value in REPORT.items():
            self.assertEqual(report[key], value)
        self.assertEqual(self.output.read_bytes(), product_glb())
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(report["sourceSha256"], hashlib.sha256(before).hexdigest())
        self.assert_cleaned()

    def test_missing_blender_is_actionable_and_keeps_existing_output(self):
        self.output.write_bytes(b"existing output")
        with patch.object(blend_import.subprocess, "run", side_effect=FileNotFoundError("missing")):
            with self.assertRaisesRegex(ValueError, "(?i)blender"):
                blend_import.convert_blend_product(self.source, self.output, blender="missing-blender")
        self.assertEqual(self.output.read_bytes(), b"existing output")

    def test_empty_source_is_rejected_before_launching_blender(self):
        self.source.write_bytes(b"")
        with patch.object(blend_import.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                blend_import.convert_blend_product(self.source, self.output)
        run.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_missing_source_does_not_run_blender(self):
        self.source.unlink()
        with patch.object(blend_import.subprocess, "run") as run:
            with self.assertRaises((ValueError, FileNotFoundError)):
                blend_import.convert_blend_product(self.source, self.output)
        run.assert_not_called()

    def test_timeout_preserves_output_and_cleans_temporary_artifacts(self):
        self.output.write_bytes(b"existing output")
        def timeout(command, **kwargs):
            self.converted_process(command, **kwargs)
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        with patch.object(blend_import.subprocess, "run", side_effect=timeout):
            with self.assertRaisesRegex(ValueError, "(?i)time|seconds|took too long"):
                blend_import.convert_blend_product(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing output")
        self.assert_cleaned()

    def test_blender_error_keeps_actionable_diagnostic_and_discards_partial_output(self):
        def failed(command, **kwargs):
            self.converted_process(command, **kwargs)
            report = Path(command[command.index("--report") + 1])
            report.write_text(json.dumps({"error": "Pack external textures into the .blend file before import."}))
            return subprocess.CompletedProcess(command, 1, stdout="conversion failed", stderr="")
        with patch.object(blend_import.subprocess, "run", side_effect=failed):
            with self.assertRaisesRegex(ValueError, "Pack external textures"):
                blend_import.convert_blend_product(self.source, self.output)
        self.assertFalse(self.output.exists())
        self.assert_cleaned()

    def test_invalid_converted_geometry_never_replaces_existing_output(self):
        self.output.write_bytes(b"existing output")
        def invalid_geometry(command, **kwargs):
            result = self.converted_process(command, **kwargs)
            Path(command[command.index("--output") + 1]).write_bytes(
                product_glb(change=lambda document: document["nodes"][0].update(translation=[1, 0, 0])))
            return result
        with patch.object(blend_import.subprocess, "run", side_effect=invalid_geometry):
            with self.assertRaisesRegex(ValueError, "(?i)center"):
                blend_import.convert_blend_product(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing output")
        self.assert_cleaned()

    def test_source_changed_during_conversion_is_not_published(self):
        self.output.write_bytes(b"existing output")
        def changed_source(command, **kwargs):
            result = self.converted_process(command, **kwargs)
            self.source.write_bytes(self.source.read_bytes() + b"changed")
            return result
        with patch.object(blend_import.subprocess, "run", side_effect=changed_source):
            with self.assertRaisesRegex(ValueError, "(?i)changed"):
                blend_import.convert_blend_product(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing output")
        self.assert_cleaned()

    def test_process_success_without_a_glb_is_a_failed_import(self):
        def missing_output(command, **kwargs):
            result = self.converted_process(command, **kwargs)
            Path(command[command.index("--output") + 1]).unlink()
            return result
        with patch.object(blend_import.subprocess, "run", side_effect=missing_output):
            with self.assertRaises(ValueError):
                blend_import.convert_blend_product(self.source, self.output)
        self.assertFalse(self.output.exists())
        self.assert_cleaned()


# Original fixture: mm units, offsets, saved animation frame, an unapplied Array
# modifier and camera/light scene objects that must not become product geometry.
FIXTURE_SCRIPT = r'''
import bpy, pathlib, sys
args=sys.argv[sys.argv.index('--')+1:]
output=pathlib.Path(args[0])
mode=args[1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.name='Synthetic product'
scene.unit_settings.system='METRIC'
scene.unit_settings.scale_length=.001
scene.unit_settings.length_unit='MILLIMETERS'
root=bpy.data.objects.new('Assembly',None)
scene.collection.objects.link(root)
root.location=(100,200,300)
nested=bpy.data.objects.new('Product parts',None)
scene.collection.objects.link(nested)
nested.parent=root
nested.location=(20,-10,5)
if mode != 'empty':
    for name,scale,location,color,roughness in (
        ('Body',(30,20,10),(0,0,0),(.12,.4,.6,1),.27),
        ('Cap',(10,10,5),(0,0,20),(.72,.08,.12,1),.63),
    ):
        bpy.ops.mesh.primitive_cube_add(size=2)
        obj=bpy.context.object
        obj.name=name
        obj.scale=scale
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        obj.parent=nested
        obj.location=location
        if name=='Cap':
            obj.scale.x=-1
        material=bpy.data.materials.new(name+' finish')
        material.use_nodes=True
        shader=material.node_tree.nodes.get('Principled BSDF')
        shader.inputs['Base Color'].default_value=color
        shader.inputs['Roughness'].default_value=.1
        shader.inputs['Roughness'].keyframe_insert(data_path='default_value',frame=1)
        shader.inputs['Roughness'].default_value=roughness
        shader.inputs['Roughness'].keyframe_insert(data_path='default_value',frame=7)
        obj.data.materials.append(material)
        if name=='Body':
            modifier=obj.modifiers.new('Repeat body','ARRAY')
            modifier.count=2
            modifier.use_relative_offset=False
            modifier.use_constant_offset=True
            modifier.constant_offset_displace=(70,0,0)
            obj.keyframe_insert(data_path='location',frame=1)
            obj.location.x=10
            obj.keyframe_insert(data_path='location',frame=7)
        if mode in {'unpacked','packed'} and name=='Cap':
            image=bpy.data.images.new('External label',width=2,height=2)
            image.filepath_raw=str(output.parent/'unpacked-label.png')
            image.file_format='PNG'
            image.save()
            image.source='FILE'
            if mode=='packed':
                image.pack()
            image.filepath='//unpacked-label.png'
            texture=material.node_tree.nodes.new('ShaderNodeTexImage')
            texture.image=image
            material.node_tree.links.new(texture.outputs['Color'],shader.inputs['Base Color'])
    if mode.startswith('glass'):
        material=bpy.data.materials.new('LiquidPerfume')
        material.use_nodes=True
        nodes=material.node_tree.nodes
        links=material.node_tree.links
        nodes.clear()
        surface=nodes.new('ShaderNodeOutputMaterial')
        glass=nodes.new('ShaderNodeBsdfGlass')
        glass.inputs['Color'].default_value=(.8,.95,.7,1)
        for input_name,initial,final in (('Roughness',.1,.23),('IOR',1.333,1.47)):
            socket=glass.inputs[input_name]
            socket.default_value=initial
            socket.keyframe_insert(data_path='default_value',frame=1)
            socket.default_value=final
            socket.keyframe_insert(data_path='default_value',frame=7)
        output_socket=glass.outputs['BSDF']
        if mode=='glass_packed':
            reroute=nodes.new('NodeReroute')
            links.new(output_socket,reroute.inputs[0])
            output_socket=reroute.outputs[0]
            ior=nodes.new('ShaderNodeValue')
            ior.outputs[0].default_value=1.333
            ior.outputs[0].keyframe_insert(data_path='default_value',frame=1)
            ior.outputs[0].default_value=1.47
            ior.outputs[0].keyframe_insert(data_path='default_value',frame=7)
            ior_reroute=nodes.new('NodeReroute')
            links.new(ior.outputs[0],ior_reroute.inputs[0])
            links.new(ior_reroute.outputs[0],glass.inputs['IOR'])
            for kind,pixel in (('color',(.8,.95,.7,1)),('normal',(.5,.5,1,1))):
                image=bpy.data.images.new('Glass '+kind,width=2,height=2)
                image.pixels=list(pixel)*4
                if kind=='normal':
                    image.colorspace_settings.name='Non-Color'
                image.filepath_raw=str(output.parent/('glass-'+kind+'.png'))
                image.file_format='PNG'
                image.save()
                image.source='FILE'
                image.pack()
                texture=nodes.new('ShaderNodeTexImage')
                texture.image=image
                if kind=='color':
                    links.new(texture.outputs['Color'],glass.inputs['Color'])
                else:
                    normal=nodes.new('ShaderNodeNormalMap')
                    normal.space='TANGENT'
                    strength=nodes.new('ShaderNodeValue')
                    strength.outputs[0].default_value=.1
                    strength.outputs[0].keyframe_insert(data_path='default_value',frame=1)
                    strength.outputs[0].default_value=.35
                    strength.outputs[0].keyframe_insert(data_path='default_value',frame=7)
                    strength_reroute=nodes.new('NodeReroute')
                    links.new(strength.outputs[0],strength_reroute.inputs[0])
                    links.new(strength_reroute.outputs[0],normal.inputs['Strength'])
                    links.new(texture.outputs['Color'],normal.inputs['Color'])
                    links.new(normal.outputs['Normal'],glass.inputs['Normal'])
        if mode=='glass_mixed':
            diffuse=nodes.new('ShaderNodeBsdfDiffuse')
            mixed=nodes.new('ShaderNodeMixShader')
            mixed.inputs[0].default_value=.35
            links.new(output_socket,mixed.inputs[1])
            links.new(diffuse.outputs['BSDF'],mixed.inputs[2])
            output_socket=mixed.outputs[0]
        if mode=='glass_normal_rgb':
            color=nodes.new('ShaderNodeRGB')
            color.outputs[0].default_value=(.5,.5,1,1)
            links.new(color.outputs[0],glass.inputs['Normal'])
        if mode=='glass_varying_ior':
            noise=nodes.new('ShaderNodeTexNoise')
            links.new(noise.outputs['Fac'],glass.inputs['IOR'])
        links.new(output_socket,surface.inputs['Surface'])
        if mode=='glass_volume':
            volume=nodes.new('ShaderNodeVolumeAbsorption')
            links.new(volume.outputs['Volume'],surface.inputs['Volume'])
        for name in ('Body','Cap'):
            bpy.data.objects[name].data.materials.clear()
            bpy.data.objects[name].data.materials.append(material)
    if mode in {'mixed_surfaces','procedural'}:
        def surface_material(name):
            material=bpy.data.materials.new(name)
            material.use_nodes=True
            material.node_tree.nodes.clear()
            surface=material.node_tree.nodes.new('ShaderNodeOutputMaterial')
            return material,surface
        if mode=='mixed_surfaces':
            mask=bpy.data.images.new('Packed split mask',width=8,height=8)
            mask.colorspace_settings.name='Non-Color'
            mask.pixels=[channel for y in range(8) for x in range(8)
                         for channel in ((0,0,0,1) if x<4 else (1,1,1,1))]
            mask.filepath_raw=str(output.parent/'mixed-mask.png')
            mask.file_format='PNG'
            mask.save()
            mask.source='FILE'
            mask.pack()
            for object_name,material_name in (('Body','Masked bottle'),('Cap','Two-finish label')):
                material,surface=surface_material(material_name)
                nodes=material.node_tree.nodes
                links=material.node_tree.links
                mask_node=nodes.new('ShaderNodeTexImage')
                mask_node.image=mask
                mask_node.interpolation='Closest'
                first=nodes.new('ShaderNodeBsdfPrincipled')
                first.inputs['IOR'].default_value=1.45
                if object_name=='Body':
                    first.inputs['Base Color'].default_value=(.02,.03,.04,1)
                    first.inputs['Roughness'].default_value=.2
                    first.inputs['Metallic'].default_value=0
                    second=nodes.new('ShaderNodeBsdfGlass')
                    second.inputs['Color'].default_value=(.8,.95,1,1)
                    second.inputs['Roughness'].default_value=.05
                    second.inputs['IOR'].default_value=1.45
                else:
                    first.inputs['Base Color'].default_value=(.75,.5,.12,1)
                    first.inputs['Roughness'].default_value=.17
                    first.inputs['Metallic'].default_value=1
                    second=nodes.new('ShaderNodeBsdfPrincipled')
                    second.inputs['Base Color'].default_value=(.02,.03,.04,1)
                    second.inputs['Roughness'].default_value=.6
                    second.inputs['Metallic'].default_value=0
                    second.inputs['IOR'].default_value=1.45
                mixed=nodes.new('ShaderNodeMixShader')
                links.new(mask_node.outputs['Color'],mixed.inputs[0])
                links.new(first.outputs[0],mixed.inputs[1])
                links.new(second.outputs[0],mixed.inputs[2])
                links.new(mixed.outputs[0],surface.inputs['Surface'])
                obj=bpy.data.objects[object_name]
                obj.data.materials.clear()
                obj.data.materials.append(material)
        else:
            material,surface=surface_material('Procedural finish')
            nodes=material.node_tree.nodes
            links=material.node_tree.links
            shader=nodes.new('ShaderNodeBsdfPrincipled')
            shader.inputs['Base Color'].default_value=(.3,.15,.05,1)
            coords=nodes.new('ShaderNodeTexCoord')
            wave=nodes.new('ShaderNodeTexWave')
            wave.inputs['Scale'].default_value=.25
            wave.bands_direction='X'
            noise=nodes.new('ShaderNodeTexNoise')
            noise.inputs['Scale'].default_value=.2
            noise.inputs['Detail'].default_value=0
            bump=nodes.new('ShaderNodeBump')
            bump.inputs['Strength'].default_value=.4
            bump.inputs['Distance'].default_value=2
            links.new(coords.outputs['Object'],wave.inputs['Vector'])
            links.new(coords.outputs['Object'],noise.inputs['Vector'])
            links.new(wave.outputs['Fac'],shader.inputs['Roughness'])
            links.new(noise.outputs['Fac'],bump.inputs['Height'])
            links.new(bump.outputs['Normal'],shader.inputs['Normal'])
            links.new(shader.outputs[0],surface.inputs['Surface'])
            obj=bpy.data.objects['Body']
            obj.data.materials.clear()
            obj.data.materials.append(material)
    if mode=='real_instance':
        instance_source=bpy.data.collections.new('Real instance source')
        instance_source.objects.link(bpy.data.objects['Cap'])
        instancer=bpy.data.objects.new('Real collection instance',None)
        instancer.instance_type='COLLECTION'
        instancer.instance_collection=instance_source
        scene.collection.objects.link(instancer)
    if mode.startswith('filter_'):
        def plane(name,size,location,parent=None,emission=False):
            bpy.ops.mesh.primitive_plane_add(size=size)
            obj=bpy.context.object
            obj.name=name
            obj.parent=parent
            obj.location=location
            if emission:
                material=bpy.data.materials.new(name+' emission')
                material.use_nodes=True
                material.node_tree.nodes.clear()
                output_node=material.node_tree.nodes.new('ShaderNodeOutputMaterial')
                light_node=material.node_tree.nodes.new('ShaderNodeEmission')
                light_node.inputs['Strength'].default_value=4
                material.node_tree.links.new(light_node.outputs[0],output_node.inputs['Surface'])
                obj.data.materials.append(material)
            return obj
        def put_in(obj,collection):
            for membership in list(obj.users_collection):
                membership.objects.unlink(obj)
            collection.objects.link(obj)
        if mode in {'filter_stage','filter_product_override'}:
            ground=plane('Ground',2000,(165,190,280))
            if mode=='filter_product_override':
                ground['gesso_role']='product'
            else:
                plane('FillLight',1000,(700,190,500),emission=True)
                plane('Label',10,(0,0,6),parent=nested)
                plane('Ground',10,(0,0,0),parent=nested)
                plane('Screen',10,(0,0,8),parent=nested,emission=True)
                plane('Unnamed panel',8,(165,190,310))
        if mode=='filter_roles':
            environment=bpy.data.collections.new('Stage setup')
            environment['gesso_role']='environment'
            scene.collection.children.link(environment)
            extras=bpy.data.collections.new('Stage extras')
            environment.children.link(extras)
            unsupported=plane('Stage volume',3000,(5000,5000,5000))
            put_in(unsupported,extras)
            material=bpy.data.materials.new('Unsupported stage volume')
            material.use_nodes=True
            volume=material.node_tree.nodes.new('ShaderNodeVolumeAbsorption')
            material.node_tree.links.new(volume.outputs[0],material.node_tree.nodes.get('Material Output').inputs['Volume'])
            unsupported.data.materials.append(material)
            bpy.ops.mesh.primitive_cube_add(size=1000,location=(5000,5000,5000))
            particles=bpy.context.object
            particles.name='Stage particles'
            bpy.ops.object.particle_system_add()
            particles.particle_systems[-1].settings.count=1
            particles.particle_systems[-1].settings.frame_start=100
            particles.particle_systems[-1].settings.frame_end=100
            put_in(particles,extras)
            excluded_parent=plane('Excluded stage ancestor',2000,(0,0,0),parent=root)
            excluded_parent['gesso_role']='environment'
            put_in(excluded_parent,extras)
            insert=plane('Product insert',8,(20,-10,10),parent=excluded_parent)
            insert['gesso_role']='product'
            put_in(insert,extras)
            detail=plane('Insert detail',4,(0,0,0),parent=insert)
            put_in(detail,extras)
            # Nearest object role must override the product parent as well.
            excluded_detail=plane('Stage detail',2000,(0,0,0),parent=insert)
            excluded_detail['gesso_role']='environment'
            # An explicit product collection does not override an object's own
            # environment declaration, even when it has no environment parent.
            products=bpy.data.collections.new('Product collection')
            products['gesso_role']='product'
            scene.collection.children.link(products)
            explicit_stage=plane('Explicit stage',2000,(4000,4000,4000))
            explicit_stage['gesso_role']='environment'
            put_in(explicit_stage,products)
    text=bpy.data.texts.new('embedded_startup.py')
    text.use_module=True
    text.write('from pathlib import Path\nPath('+repr(str(output.parent/'startup-executed'))+').write_text("executed")\n')
camera=bpy.data.objects.new('Do not import camera',bpy.data.cameras.new('Camera'))
scene.collection.objects.link(camera)
light=bpy.data.objects.new('Do not import light',bpy.data.lights.new('Light','POINT'))
scene.collection.objects.link(light)
# A render-hidden ancestor collection excludes its otherwise-visible children.
hidden=bpy.data.collections.new('Hidden workshop')
scene.collection.children.link(hidden)
hidden.hide_render=True
hidden_child=bpy.data.collections.new('Hidden workshop child')
hidden.children.link(hidden_child)
bpy.ops.mesh.primitive_cube_add(size=1000,location=(3000,0,0))
hidden_obj=bpy.context.object
hidden_obj.name='Do not import hidden prop'
for collection in list(hidden_obj.users_collection):
    collection.objects.unlink(hidden_obj)
hidden_child.objects.link(hidden_obj)
scene.frame_set(7)
bpy.ops.wm.save_as_mainfile(filepath=str(output))
'''


def make_blend_fixture(output, mode="valid", *, blender=BLENDER):
    """Create synthetic .blend data for integration checks or a local UI check."""
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    script = output.parent / "make_blend_import_fixture.py"
    script.write_text(FIXTURE_SCRIPT)
    result = subprocess.run(
        [str(blender), "--background", "--factory-startup", "--disable-autoexec",
         "--python-exit-code", "1", "--python", str(script), "--", str(output), mode],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    return output


def read_glb_document(path):
    payload = Path(path).read_bytes()
    length = struct.unpack_from("<I", payload, 12)[0]
    return json.loads(payload[20:20 + length])


def glb_texture_image(path, document, texture_info):
    """Read embedded texture pixels without relying on exporter accessor bounds."""
    payload = Path(path).read_bytes()
    json_length = struct.unpack_from("<I", payload, 12)[0]
    binary = payload[28 + json_length:]
    texture = document["textures"][texture_info["index"]]
    image = document["images"][texture["source"]]
    if "uri" in image:
        raise AssertionError("Converted material texture must be embedded")
    view = document["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset", 0)
    return Image.open(io.BytesIO(binary[start:start + view["byteLength"]])).convert("RGB")


def linear_rgb(pixel):
    return tuple(value / 255 / 12.92 if value / 255 <= .04045
                 else ((value / 255 + .055) / 1.055) ** 2.4 for value in pixel[:3])


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1",
                     "Set RUN_BLENDER_TESTS=1 to exercise real Blender conversion")
class BlendImportBlenderTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(shutil.which(BLENDER), "Blender 4.3.2 must be installed")
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "synthetic-product.blend"
        self.output = self.root / "converted.glb"

    def test_nested_mm_product_is_a_centered_static_snapshot_with_materials(self):
        make_blend_fixture(self.source)
        source_digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        report = blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        measured = inspect_product_glb(self.output.read_bytes())
        for actual, expected in zip(measured["dimensionsM"], (.130, .035, .040)):
            self.assertAlmostEqual(actual, expected, places=6)
        for lower, upper in zip(*measured["boundsM"]):
            self.assertAlmostEqual(lower + upper, 0, places=6)
        self.assertEqual(report["sourceFrame"], 7)
        self.assertEqual(report["sourceScene"], "Synthetic product")
        self.assertAlmostEqual(report["sourceScaleToMeters"], .001)
        self.assertEqual(report["meshCount"], 2)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_digest)
        self.assertFalse((self.root / "startup-executed").exists())
        document = read_glb_document(self.output)
        self.assertFalse(document.get("animations"))
        self.assertFalse(document.get("skins"))
        self.assertFalse(document.get("cameras"))
        self.assertNotIn("KHR_lights_punctual", document.get("extensions", {}))
        by_name = {node["name"]: index for index, node in enumerate(document["nodes"]) if "name" in node}
        for name in ("Assembly", "Product parts", "Body", "Cap"):
            self.assertIn(name, by_name)
        self.assertNotIn("Do not import camera", by_name)
        self.assertNotIn("Do not import light", by_name)
        self.assertNotIn("Do not import hidden prop", by_name)
        self.assertIn(by_name["Product parts"], document["nodes"][by_name["Assembly"]]["children"])
        self.assertEqual(set(document["nodes"][by_name["Product parts"]]["children"]),
                         {by_name["Body"], by_name["Cap"]})
        # The cap is 45 mm left of the normalized center only at saved frame 7.
        # At frame 1 it would be 35 mm left, even though overall dimensions match.
        payload = self.output.read_bytes()
        json_length = struct.unpack_from("<I", payload, 12)[0]
        binary = payload[28 + json_length:]
        positions = {}
        def visit(index, parent):
            node = document["nodes"][index]
            matrix = products._multiply(parent, products._node_matrix(node))
            if "mesh" in node:
                points = []
                for primitive in document["meshes"][node["mesh"]]["primitives"]:
                    for point in products._accessor_rows(document, [binary], primitive["attributes"]["POSITION"], positions=True):
                        points.append([sum(matrix[row][column] * point[column] for column in range(3)) + matrix[row][3]
                                       for row in range(3)])
                positions[node["name"]] = points
            for child in node.get("children", []):
                visit(child, matrix)
        for index in document["scenes"][0]["nodes"]:
            visit(index, products._IDENTITY)
        self.assertAlmostEqual((min(p[0] for p in positions["Cap"]) + max(p[0] for p in positions["Cap"])) / 2,
                               -.045, places=6)
        # The source cap has a negative X scale. Baking it must preserve outward
        # triangle winding as well as dimensions; front-side rendering relies on it.
        cap_mesh = document["meshes"][document["nodes"][by_name["Cap"]]["mesh"]]
        for primitive in cap_mesh["primitives"]:
            vertices = list(products._accessor_rows(document, [binary], primitive["attributes"]["POSITION"], positions=True))
            normals = list(products._accessor_rows(document, [binary], primitive["attributes"]["NORMAL"], positions=True))
            indices = [row[0] for row in products._accessor_rows(document, [binary], primitive["indices"])]
            for first, second, third in zip(indices[::3], indices[1::3], indices[2::3]):
                edge_a = [vertices[second][axis] - vertices[first][axis] for axis in range(3)]
                edge_b = [vertices[third][axis] - vertices[first][axis] for axis in range(3)]
                cross = (edge_a[1]*edge_b[2]-edge_a[2]*edge_b[1],
                         edge_a[2]*edge_b[0]-edge_a[0]*edge_b[2],
                         edge_a[0]*edge_b[1]-edge_a[1]*edge_b[0])
                self.assertGreater(sum(cross[axis] * normals[first][axis] for axis in range(3)), 0)
        surfaces = {material["name"]: material["pbrMetallicRoughness"] for material in document["materials"]}
        for name, color, roughness in (("Body finish", (.12, .4, .6, 1), .27),
                                       ("Cap finish", (.72, .08, .12, 1), .63)):
            self.assertIn(name, surfaces)
            for actual, expected in zip(surfaces[name]["baseColorFactor"], color):
                self.assertAlmostEqual(actual, expected, places=6)
            # Animated from .1 at frame 1; export must retain saved-frame appearance.
            self.assertAlmostEqual(surfaces[name]["roughnessFactor"], roughness, places=6)

    def test_packed_label_texture_is_embedded_in_the_glb(self):
        make_blend_fixture(self.source, "packed")
        # A packed texture must remain usable without its source image file.
        (self.root / "unpacked-label.png").unlink()
        blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        document = read_glb_document(self.output)
        self.assertTrue(document.get("images"))
        self.assertTrue(all("bufferView" in image and "uri" not in image for image in document["images"]))
        cap = next(material for material in document["materials"] if material["name"] == "Cap finish")
        self.assertIn("baseColorTexture", cap["pbrMetallicRoughness"])
        inspect_product_glb(self.output.read_bytes())

    def assert_glass_snapshot(self, document, report, source_digest):
        materials = document["materials"]
        glass = next(material for material in materials if material["name"] == "LiquidPerfume")
        index = materials.index(glass)
        self.assertEqual(sum(material["name"] == "LiquidPerfume" for material in materials), 1)
        for node in document["nodes"]:
            if node.get("name") in {"Body", "Cap"}:
                self.assertTrue(all(primitive["material"] == index
                                    for primitive in document["meshes"][node["mesh"]]["primitives"]))
        self.assertAlmostEqual(glass["extensions"]["KHR_materials_transmission"]["transmissionFactor"], 1)
        self.assertAlmostEqual(glass["extensions"]["KHR_materials_ior"]["ior"], 1.47, places=6)
        self.assertEqual(glass["pbrMetallicRoughness"].get("metallicFactor", 1), 0)
        self.assertAlmostEqual(glass["pbrMetallicRoughness"]["roughnessFactor"], .23, places=6)
        self.assertEqual(glass.get("alphaMode", "OPAQUE"), "OPAQUE")
        self.assertEqual(glass["pbrMetallicRoughness"].get("baseColorFactor", [1, 1, 1, 1])[3], 1)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_digest)
        self.assertEqual(report["sourceSha256"], source_digest)
        self.assertFalse(document.get("animations"))
        self.assertTrue(any("LiquidPerfume" in warning for warning in report["warnings"]))
        inspect_product_glb(self.output.read_bytes())
        return glass

    def test_shared_glass_bsdf_keeps_saved_frame_optics_without_alpha_blending(self):
        make_blend_fixture(self.source, "glass")
        source_digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        report = blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        glass = self.assert_glass_snapshot(read_glb_document(self.output), report, source_digest)
        for actual, expected in zip(glass["pbrMetallicRoughness"]["baseColorFactor"], (.8, .95, .7, 1)):
            self.assertAlmostEqual(actual, expected, places=6)

    def test_rerouted_glass_preserves_packed_maps_and_linked_saved_frame_ior(self):
        make_blend_fixture(self.source, "glass_packed")
        (self.root / "glass-color.png").unlink()
        (self.root / "glass-normal.png").unlink()
        source_digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        report = blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        document = read_glb_document(self.output)
        glass = self.assert_glass_snapshot(document, report, source_digest)
        self.assertIn("baseColorTexture", glass["pbrMetallicRoughness"])
        self.assertIn("normalTexture", glass)
        self.assertAlmostEqual(glass["normalTexture"].get("scale", 1), .35, places=6)
        self.assertGreaterEqual(len(document["images"]), 2)
        self.assertTrue(all("bufferView" in image and "uri" not in image for image in document["images"]))

    def test_mixed_glass_shader_remains_an_actionable_error(self):
        make_blend_fixture(self.source, "glass_mixed")
        with self.assertRaisesRegex(ValueError, "(?i)mix|bake|principled"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def test_glass_with_volume_remains_an_actionable_error(self):
        make_blend_fixture(self.source, "glass_volume")
        with self.assertRaisesRegex(ValueError, "(?i)volume"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def test_glass_with_arbitrary_normal_input_is_rejected_without_silent_fallback(self):
        make_blend_fixture(self.source, "glass_normal_rgb")
        with self.assertRaisesRegex(ValueError, "(?i)normal"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def test_glass_with_spatially_varying_ior_is_rejected_without_silent_fallback(self):
        make_blend_fixture(self.source, "glass_varying_ior")
        with self.assertRaisesRegex(ValueError, "(?i)ior|index of refraction"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def test_masked_glass_and_two_principled_label_preserve_shader_weight_regions(self):
        make_blend_fixture(self.source, "mixed_surfaces")
        (self.root / "mixed-mask.png").unlink()
        source_digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        report = blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        document = read_glb_document(self.output)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_digest)
        self.assertEqual(report["sourceSha256"], source_digest)
        inspect_product_glb(self.output.read_bytes())
        self.assertTrue(document.get("images"))
        self.assertTrue(all("bufferView" in image and "uri" not in image for image in document["images"]))
        for name in ("Masked bottle", "Two-finish label"):
            with self.subTest(material=name):
                material = next(value for value in document["materials"] if value["name"].startswith(name))
                pbr = material["pbrMetallicRoughness"]
                base = glb_texture_image(self.output, document, pbr["baseColorTexture"])
                metal_rough = glb_texture_image(self.output, document, pbr["metallicRoughnessTexture"])
                self.assertEqual(material.get("alphaMode", "OPAQUE"), "OPAQUE")
                transmission = None
                if name == "Masked bottle":
                    self.assertAlmostEqual(material["extensions"]["KHR_materials_ior"]["ior"], 1.45, places=6)
                    extension = material["extensions"]["KHR_materials_transmission"]
                    self.assertAlmostEqual(extension["transmissionFactor"], 1, places=6)
                    transmission = glb_texture_image(self.output, document, extension["transmissionTexture"])
                size = (min(base.width, metal_rough.width), min(base.height, metal_rough.height))
                base = base.resize(size, Image.Resampling.NEAREST)
                metal_rough = metal_rough.resize(size, Image.Resampling.NEAREST)
                if transmission is not None:
                    transmission = transmission.resize(size, Image.Resampling.NEAREST)
                regions = [0, 0]
                # Read corresponding map pixels: preserving extrema alone would
                # miss reversed weights or a transmission pattern losing its color.
                for y in range(0, size[1], max(1, size[1] // 64)):
                    for x in range(0, size[0], max(1, size[0] // 64)):
                        color = tuple(value * factor for value, factor in zip(linear_rgb(base.getpixel((x, y))),
                                                                               pbr.get("baseColorFactor", [1, 1, 1, 1])))
                        _, rough, metal = metal_rough.getpixel((x, y))
                        rough = rough / 255 * pbr.get("roughnessFactor", 1)
                        metal = metal / 255 * pbr.get("metallicFactor", 1)
                        trans = transmission.getpixel((x, y))[0] / 255 if transmission is not None else 0
                        if name == "Masked bottle":
                            expected = (((.02, .03, .04), .2, 0, 0), ((.8, .95, 1), .05, 0, 1))
                        else:
                            expected = (((.75, .5, .12), .17, 1, 0), ((.02, .03, .04), .6, 0, 0))
                        for index, (rgb, r, m, t) in enumerate(expected):
                            if (max(abs(a - b) for a, b in zip(color, rgb)) < .04
                                    and abs(rough - r) < .03 and abs(metal - m) < .03 and abs(trans - t) < .03):
                                regions[index] += 1
                self.assertGreater(regions[0], 8, f"First shader region disappeared: {regions}")
                self.assertGreater(regions[1], 8, f"Second shader region disappeared: {regions}")

    def test_object_space_procedural_roughness_and_bump_become_embedded_maps(self):
        make_blend_fixture(self.source, "procedural")
        source_digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        document = read_glb_document(self.output)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_digest)
        material = next(value for value in document["materials"] if value["name"].startswith("Procedural finish"))
        rough = glb_texture_image(self.output, document, material["pbrMetallicRoughness"]["metallicRoughnessTexture"])
        normal = glb_texture_image(self.output, document, material["normalTexture"])
        rough_range = rough.getextrema()[1]
        self.assertGreater(rough_range[1] - rough_range[0], 128)
        # Exclude empty atlas pixels; a flat blue normal texture is not a baked bump.
        sampled = normal.resize((256, 256), Image.Resampling.NEAREST)
        mapped = [pixel for y in range(256) for x in range(256)
                  if (pixel := sampled.getpixel((x, y)))[2] > 128]
        self.assertTrue(mapped)
        self.assertGreater(max(pixel[0] for pixel in mapped) - min(pixel[0] for pixel in mapped), 8)
        self.assertGreater(max(pixel[1] for pixel in mapped) - min(pixel[1] for pixel in mapped), 8)
        self.assertTrue(all("bufferView" in image and "uri" not in image for image in document["images"]))
        inspect_product_glb(self.output.read_bytes())

    def test_real_collection_instances_still_require_realization(self):
        make_blend_fixture(self.source, "real_instance")
        with self.assertRaisesRegex(ValueError, "(?i)instances|make instances real"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def import_filter_fixture(self, mode):
        make_blend_fixture(self.source, mode)
        source_digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        report = blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_digest)
        self.assertEqual(report["sourceSha256"], source_digest)
        return read_glb_document(self.output), report, inspect_product_glb(self.output.read_bytes())

    def test_studio_ground_and_fill_card_are_excluded_but_product_planes_are_kept(self):
        document, report, measured = self.import_filter_fixture("filter_stage")
        names = {node.get("name") for node in document["nodes"]}
        self.assertNotIn("Ground", names)
        self.assertNotIn("FillLight", names)
        self.assertTrue({"Assembly", "Body", "Cap", "Label", "Ground.001", "Screen", "Unnamed panel"}.issubset(names))
        for actual, expected in zip(measured["dimensionsM"], (.130, .035, .040)):
            self.assertAlmostEqual(actual, expected, places=6)
        excluded = {entry["object"]: entry["reason"] for entry in report["excludedObjects"]}
        self.assertIn("Ground", excluded)
        self.assertIn("FillLight", excluded)
        self.assertTrue(all(isinstance(reason, str) and reason.strip() for reason in excluded.values()))
        self.assertGreaterEqual(report["excludedObjectCount"], 2)
        for name in ("Label", "Ground.001", "Screen", "Unnamed panel"):
            self.assertNotIn(name, excluded)

    def test_product_role_keeps_a_large_ground_named_product_part(self):
        document, report, measured = self.import_filter_fixture("filter_product_override")
        self.assertIn("Ground", {node.get("name") for node in document["nodes"]})
        self.assertNotIn("Ground", {entry["object"] for entry in report["excludedObjects"]})
        self.assertAlmostEqual(measured["dimensionsM"][0], 2, places=6)
        self.assertAlmostEqual(measured["dimensionsM"][2], 2, places=6)

    def test_environment_roles_skip_unsupported_scene_content_and_bypass_excluded_ancestors(self):
        document, report, measured = self.import_filter_fixture("filter_roles")
        nodes = document["nodes"]
        by_name = {node["name"]: index for index, node in enumerate(nodes) if "name" in node}
        expected_exclusions = {"Stage volume", "Stage particles", "Excluded stage ancestor", "Stage detail", "Explicit stage"}
        self.assertTrue(expected_exclusions.isdisjoint(by_name))
        self.assertTrue({"Assembly", "Body", "Cap", "Product insert", "Insert detail"}.issubset(by_name))
        self.assertIn(by_name["Product insert"], nodes[by_name["Assembly"]].get("children", []))
        self.assertIn(by_name["Insert detail"], nodes[by_name["Product insert"]].get("children", []))
        for actual, expected in zip(measured["dimensionsM"], (.130, .035, .040)):
            self.assertAlmostEqual(actual, expected, places=6)
        excluded = {entry["object"]: entry["reason"] for entry in report["excludedObjects"]}
        self.assertTrue(expected_exclusions.issubset(excluded))
        self.assertTrue(all(excluded[name].strip() for name in expected_exclusions))
        self.assertNotIn("Product insert", excluded)
        self.assertNotIn("Insert detail", excluded)
        self.assertNotIn("Unsupported stage volume", {material["name"] for material in document.get("materials", [])})

    def test_malformed_blend_is_rejected_without_a_partial_glb(self):
        self.source.write_bytes(b"not a Blender document")
        with self.assertRaisesRegex(ValueError, "(?i)open|read|blend"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def test_empty_scene_has_an_actionable_error_and_no_output(self):
        make_blend_fixture(self.source, "empty")
        with self.assertRaisesRegex(ValueError, "(?i)mesh|geometry|empty"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())

    def test_unpacked_texture_requires_packing_instead_of_silent_artwork_loss(self):
        make_blend_fixture(self.source, "unpacked")
        with self.assertRaisesRegex(ValueError, "(?i)pack"):
            blend_import.convert_blend_product(self.source, self.output, blender=BLENDER)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
