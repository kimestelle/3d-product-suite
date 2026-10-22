"""Build the sampled product scene inside pinned Blender 4.3.2.

Run with Blender, not system Python::

    blender --background --factory-startup --python scripts/blender_scene.py -- \
        --samples output/samples.json --output output --frames 1,48,96

Geometry is authored in metres. The manifest is right-handed Y-up; Blender is
right-handed Z-up. Every sampled pose is keyed with constant interpolation, so
opening the saved .blend at any integer frame reproduces the sampled result.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
from functools import lru_cache
import json
import math
from pathlib import Path
import re
import struct
import os
import sys
import tempfile

import bpy
from mathutils import Matrix, Quaternion, Vector


BLENDER_VERSION = (4, 3, 2)
COORDINATE_ROTATION = Quaternion((1.0, 0.0, 0.0), math.pi / 2.0)


def package_root():
    """Locate the film package from the repo or from a job directory's renderer snapshot."""
    here = Path(__file__).resolve()
    candidates = [here.parents[1], *list(here.parents)[2:6]]
    if os.environ.get("GESSO_ROOT"):
        candidates.append(Path(os.environ["GESSO_ROOT"]))
    for candidate in candidates:
        if (candidate / "film" / "__init__.py").is_file():
            return candidate
    raise ValueError("Cannot locate the film package for renderer helpers; set GESSO_ROOT to the repository root")


@lru_cache(maxsize=4)
def renderer_helper(name):
    """Load the frozen job helper; direct source runs use the repository helper."""
    renderer = Path(__file__).resolve()
    source = (renderer.with_name(name + ".py") if renderer.name == "renderer.py"
              else renderer.parents[1] / "film" / (name + ".py"))
    spec = importlib.util.spec_from_file_location("gesso_" + name, source)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load renderer geometry helper: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decal_geometry():
    return renderer_helper("decal_geometry")

def blender_position(value):
    """Rotate a canonical Y-up position into Blender Z-up."""
    x, y, z = value
    return (x, -z, y)


def blender_rotation(value):
    """Convert an XYZW quaternion without changing the represented pose."""
    x, y, z, w = value
    rotation = Quaternion((w, x, y, z))
    rotation.normalize()
    return COORDINATE_ROTATION @ rotation @ COORDINATE_ROTATION.conjugated()


def blender_matrix(values):
    canonical = Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
    basis = COORDINATE_ROTATION.to_matrix().to_4x4()
    return basis @ canonical @ basis.inverted()


def source_part_objects(objects):
    return {obj["source_part_id"]: obj for root in objects.values() for obj in root.children_recursive
            if "gesso_source_node_index" in obj}


def apply_product_removal(objects, removed_ids):
    """Hide sampled parts, their native children and attached artwork in .blend.

    Keep every object in the native file for recovery. Blender visibility does
    not inherit from an Empty, so set both render and viewport flags recursively.
    """
    parts = {**objects, **source_part_objects(objects)}
    for part_id in removed_ids:
        root = parts.get(part_id)
        if root is None:
            raise ValueError(f"Removed product part is absent from imported geometry: {part_id}")
        for obj in (root, *root.children_recursive):
            obj.hide_render = True
            obj.hide_viewport = True


def part_motion_carriers(objects):
    """Keep imported static transforms intact, including nonuniform scales.

    The sampler's parent-space delta is ordinary TRS. A separate parent avoids
    decomposing delta*source into a lossy rotation/scale at every frame.
    """
    parts = source_part_objects(objects)
    carriers = {}
    bpy.context.view_layer.update()
    for part_id, obj in parts.items():
        original_local = obj.matrix_local.copy()
        carrier = bpy.data.objects.new("Motion / " + part_id, None)
        bpy.context.collection.objects.link(carrier)
        carrier.parent = obj.parent
        carrier.matrix_parent_inverse = Matrix.Identity(4)
        carrier.matrix_basis = Matrix.Identity(4)
        carrier["source_part_motion_id"] = part_id
        obj.parent = carrier
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = original_local
        carriers[part_id] = carrier
    return carriers


def artwork_image(asset, samples_root):
    path = verified_asset_record(asset, samples_root, "Label artwork")
    renderer_helper("material_assets").validate_png(path.read_bytes())
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "sRGB"
    image.pack()
    image["artwork_sha256"] = asset["sha256"]
    return image


def connect_artwork(surface, image, uv_name=None, flip_v=False):
    nodes, links = surface.node_tree.nodes, surface.node_tree.links
    shader = nodes.get("Principled BSDF")
    if shader is None:
        raise ValueError("Selected label surface has no supported Principled material")
    texture = nodes.new("ShaderNodeTexImage")
    texture.name = "Label artwork / immutable PNG"
    texture.image = image
    if uv_name is not None:
        uv = nodes.new("ShaderNodeUVMap")
        uv.uv_map = uv_name
        coordinate = uv.outputs["UV"]
        if flip_v:
            multiply = nodes.new("ShaderNodeVectorMath")
            multiply.operation = "MULTIPLY"
            multiply.inputs[1].default_value = (1, -1, 1)
            links.new(coordinate, multiply.inputs[0])
            add = nodes.new("ShaderNodeVectorMath")
            add.operation = "ADD"
            add.inputs[1].default_value = (0, 1, 0)
            links.new(multiply.outputs["Vector"], add.inputs[0])
            coordinate = add.outputs["Vector"]
        links.new(coordinate, texture.inputs["Vector"])
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    # Match Three's alphaTest=.5 rather than independently blended transparency.
    below = nodes.new("ShaderNodeMath")
    below.operation = "LESS_THAN"
    below.inputs[1].default_value = .5
    links.new(texture.outputs["Alpha"], below.inputs[0])
    cutout = nodes.new("ShaderNodeMath")
    cutout.operation = "SUBTRACT"
    cutout.inputs[0].default_value = 1
    links.new(below.outputs["Value"], cutout.inputs[1])
    links.new(cutout.outputs["Value"], shader.inputs["Alpha"])
    surface["gesso_artwork_sha256"] = image["artwork_sha256"]


def replace_product_artwork(source, objects, samples_root):
    parts = {**objects, **source_part_objects(objects)}
    for assignment in source["product"].get("artwork", []):
        obj = parts.get(assignment["partId"])
        if obj is None or obj.type != "MESH" or not obj.data.uv_layers:
            raise ValueError("Select a source mesh with UVs to replace its artwork")
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        image = artwork_image(assignment["asset"], samples_root)
        for slot in obj.material_slots:
            if assignment["finish"] == "original":
                surface = slot.material.copy()
            else:
                surface = material("Label / plain paper", (1, 1, 1, 1), .53)
            surface.use_backface_culling = False if assignment["finish"] == "paper" else surface.use_backface_culling
            connect_artwork(surface, image, obj.data.uv_layers[0].name,
                            flip_v=not obj.get("gesso_uv0_source", False) and "gesso_source_node_index" in obj)
            slot.material = surface


def material(name, color, roughness=0.45, metallic=0.0, transmission=0.0, ior=1.5):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = tuple(color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Transmission Weight"].default_value = transmission
    shader.inputs["IOR"].default_value = ior
    return result


def specified_material(name, specification, samples_root=None, *, source_uv_flip=False):
    result = material(name, specification["baseColor"], specification["roughness"], specification["metallic"], specification.get("transmission", 0), specification.get("ior", 1.5))
    maps = specification.get("textures", {})
    if not maps:
        return result
    if samples_root is None:
        raise ValueError("PBR maps require the sampled scene asset bundle")
    assets = renderer_helper("material_assets")
    assets.validate_material_textures(specification)
    nodes, links = result.node_tree.nodes, result.node_tree.links
    shader = nodes.get("Principled BSDF")
    uv = nodes.new("ShaderNodeTexCoord").outputs["UV"]
    if source_uv_flip:
        # glTF importer flips V. Restore source UVs for newly applied editor maps.
        flip = nodes.new("ShaderNodeVectorMath")
        flip.operation = "MULTIPLY"
        flip.inputs[1].default_value = (1, -1, 1)
        links.new(uv, flip.inputs[0])
        add = nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        add.inputs[1].default_value = (0, 1, 0)
        links.new(flip.outputs["Vector"], add.inputs[0])
        uv = add.outputs["Vector"]
    repeat = nodes.new("ShaderNodeVectorMath")
    repeat.name = "PBR / repeat"
    repeat.operation = "MULTIPLY"
    repeat.inputs[1].default_value = (*specification.get("textureRepeat", [1,1]), 1)
    links.new(uv, repeat.inputs[0])
    textures = {}
    for kind, asset in maps.items():
        path = verified_asset_record(asset, samples_root.resolve(), "Material image")
        assets.validate_png(path.read_bytes())
        # Color space is an image property; separate datablocks keep a shared
        # hash safe when the same PNG is used for color and data channels.
        image = bpy.data.images.load(str(path), check_existing=False)
        image.colorspace_settings.name = "sRGB" if kind == "basecolor" else "Non-Color"
        image.pack()
        texture = nodes.new("ShaderNodeTexImage")
        texture.name = "PBR / " + kind
        texture.image = image
        texture.extension = "REPEAT"
        links.new(repeat.outputs["Vector"], texture.inputs["Vector"])
        textures[kind] = texture
    if "basecolor" in textures:
        multiply = nodes.new("ShaderNodeMixRGB")
        multiply.name = "PBR / color multiplier"
        multiply.blend_type = "MULTIPLY"
        multiply.inputs[0].default_value = 1
        multiply.inputs[2].default_value = specification["baseColor"]
        links.new(textures["basecolor"].outputs["Color"], multiply.inputs[1])
        links.new(multiply.outputs["Color"], shader.inputs["Base Color"])
    for kind, channel, scalar, input_name in (("roughness", "Green", "roughness", "Roughness"),
                                               ("metalness", "Blue", "metallic", "Metallic")):
        if kind not in textures:
            continue
        separate = nodes.new("ShaderNodeSeparateColor")
        separate.mode = "RGB"
        links.new(textures[kind].outputs["Color"], separate.inputs["Color"])
        multiply = nodes.new("ShaderNodeMath")
        multiply.name = "PBR / " + kind + " multiplier"
        multiply.operation = "MULTIPLY"
        multiply.inputs[1].default_value = specification[scalar]
        links.new(separate.outputs[channel], multiply.inputs[0])
        links.new(multiply.outputs["Value"], shader.inputs[input_name])
    normal = None
    if "normal" in textures:
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.name = "PBR / tangent normal"
        normal_map.inputs["Strength"].default_value = specification.get("normalScale", 1)
        links.new(textures["normal"].outputs["Color"], normal_map.inputs["Color"])
        normal = normal_map.outputs["Normal"]
    if "height" in textures and specification.get("heightScaleM", 0) > 0:
        separate = nodes.new("ShaderNodeSeparateColor")
        separate.mode = "RGB"
        links.new(textures["height"].outputs["Color"], separate.inputs["Color"])
        bump = nodes.new("ShaderNodeBump")
        bump.name = "PBR / height bump"
        bump.inputs["Distance"].default_value = specification["heightScaleM"]
        bump.inputs["Strength"].default_value = 1
        links.new(separate.outputs["Red"], bump.inputs["Height"])
        if normal is not None:
            links.new(normal, bump.inputs["Normal"])
        normal = bump.outputs["Normal"]
    if normal is not None:
        links.new(normal, shader.inputs["Normal"])
    result["gesso_pbr_textures"] = True
    result["height_policy"] = "Bump only; source geometry is not displaced"
    return result


def textured_primitive(name, shape, size, surface, bevel):
    """Use the editor's exact procedural surface and UV atlas for PBR materials."""
    primitive_triangles = decal_geometry().primitive_triangles
    points = [point for triangle in primitive_triangles({"shape":shape,"sizeM":size,"bevelM":bevel}) for point in triangle]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([blender_position(point[:3]) for point in points], [],
                     [tuple(range(i,i+3)) for i in range(0,len(points),3)])
    mesh.update()
    uv = mesh.uv_layers.new(name="Source UV")
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for index in polygon.loop_indices:
            uv.data[index].uv = points[mesh.loops[index].vertex_index][6:8]
    mesh.normals_split_custom_set_from_vertices([blender_position(point[3:6]) for point in points])
    mesh.materials.append(surface)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def primitive(name, shape, size, surface, bevel=0.0):
    """Create geometry already expressed in Blender local coordinates."""
    if surface.get("gesso_pbr_textures"):
        return textured_primitive(name, shape, size, surface, bevel)
    if shape == "box":
        bpy.ops.mesh.primitive_cube_add(size=1)
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=0.5, depth=1)
    else:
        raise ValueError(f"Unsupported component shape: {shape!r}")
    obj = bpy.context.object
    obj.name = name
    # Cylinder longitudinal axis is canonical Y, which becomes Blender Z.
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(surface)
    if shape == "cylinder":
        for polygon in obj.data.polygons:
            polygon.use_smooth = len(polygon.vertices) == 4
    if bevel > 0:
        modifier = obj.modifiers.new("Manufactured edge radius", "BEVEL")
        modifier.width = min(bevel, min(size) * 0.45)
        modifier.segments = 5
        modifier.limit_method = "ANGLE"
        modifier.harden_normals = True
        modifier = obj.modifiers.new("Weighted surface normals", "WEIGHTED_NORMAL")
        modifier.keep_sharp = True
        modifier.weight = 50
    return obj


def text_on_label(parent, specification, label_size):
    """Attach declared typography to the label's canonical +Z face."""
    ink = material("Label / printed charcoal", (0.035, 0.046, 0.038, 1), 0.7)
    width, height, depth = label_size
    for name, content, vertical, maximum_width, maximum_height in (
        ("Brand", specification.get("text", ""), height * 0.13, width * 0.84, height * 0.24),
        ("Descriptor", specification.get("subtitle", ""), -height * 0.23, width * 0.85, height * 0.065),
    ):
        if not content:
            continue
        data = bpy.data.curves.new(f"Label / {name}", "FONT")
        data.body = content
        data.align_x = "CENTER"
        data.align_y = "CENTER"
        data.size = 1
        data.space_character = 1.15 if name == "Brand" else 1.03
        data.resolution_u = 10
        # Use the pinned Blender build's bundled Bfont on every host. Avoid an
        # OS-font lookup/fallback that could silently change label artwork.
        if data.font is None or data.font.filepath != "<builtin>":
            raise RuntimeError("Expected Blender's bundled default Bfont Regular")
        obj = bpy.data.objects.new(f"Label / {name}", data)
        bpy.context.collection.objects.link(obj)
        data.materials.append(ink)
        # Text starts in XY with +Z normal. Rotate its front toward canonical +Z.
        obj.parent = parent
        obj.location = blender_position((0, vertical, depth / 2 + 0.00012))
        obj.rotation_euler = (math.pi / 2.0, 0, 0)
        bpy.context.view_layer.update()
        # Font bounding boxes live in the text's native XY plane.
        bounds = [Vector(corner) for corner in obj.bound_box]
        text_width = max(v.x for v in bounds) - min(v.x for v in bounds)
        text_height = max(v.y for v in bounds) - min(v.y for v in bounds)
        scale = min(maximum_width / max(text_width, 1e-8), maximum_height / max(text_height, 1e-8))
        obj.scale = (scale, scale, scale)


def decal_artwork(specification, output_root):
    """Rasterize pinned Bfont into a packed, opaque decal texture, without OS fonts."""
    digest = hashlib.sha256(json.dumps({key: specification[key] for key in ("text", "subtitle")},
                                      sort_keys=True).encode()).hexdigest()[:20]
    path = output_root / f"decal-artwork-{digest}.png"
    if not path.exists():
        artwork = bpy.data.scenes.new("Decal artwork / temporary")
        artwork.render.engine = "CYCLES"
        artwork.cycles.samples = 1
        artwork.cycles.use_denoising = False
        artwork.render.resolution_x = artwork.render.resolution_y = 1024
        artwork.render.resolution_percentage = 100
        artwork.render.image_settings.file_format = "PNG"
        artwork.render.image_settings.color_mode = "RGBA"
        artwork.render.filepath = str(path)
        artwork.view_settings.view_transform = "Standard"
        artwork.view_settings.look = "None"
        artwork.view_settings.exposure = 0
        artwork.view_settings.gamma = 1

        def emission(name, color):
            result = bpy.data.materials.new(name)
            result.use_nodes = True
            nodes = result.node_tree.nodes
            nodes.clear()
            output = nodes.new("ShaderNodeOutputMaterial")
            shader = nodes.new("ShaderNodeEmission")
            shader.inputs["Color"].default_value = tuple((x/12.92 if x <= .04045 else ((x+.055)/1.055)**2.4)
                                                         for x in color) + (1,)
            result.node_tree.links.new(shader.outputs["Emission"], output.inputs["Surface"])
            return result

        paper = emission("Decal artwork / chalk", (250/255, 249/255, 244/255))
        ink = emission("Decal artwork / charcoal", (52/255, 64/255, 54/255))
        mesh = bpy.data.meshes.new("Decal artwork / ground")
        mesh.from_pydata([(-1,-1,0), (1,-1,0), (1,1,0), (-1,1,0)], [], [(0,1,2,3)])
        ground = bpy.data.objects.new("Decal artwork / ground", mesh)
        mesh.materials.append(paper)
        artwork.collection.objects.link(ground)
        camera_data = bpy.data.cameras.new("Decal artwork / camera")
        camera = bpy.data.objects.new("Decal artwork / camera", camera_data)
        artwork.collection.objects.link(camera)
        camera.location = (0, 0, 1)
        camera_data.type = "ORTHO"
        camera_data.ortho_scale = 1
        artwork.camera = camera
        text_objects = []
        for name, key, vertical, maximum_width, maximum_height in (
            ("Brand", "text", .13, .84, .24), ("Descriptor", "subtitle", -.23, .85, .065),
        ):
            if not specification[key]:
                continue
            data = bpy.data.curves.new(f"Decal artwork / {name}", "FONT")
            data.body = specification[key]
            data.align_x = "CENTER"
            data.align_y = "CENTER"
            data.size = 1
            data.space_character = 1.15 if name == "Brand" else 1.03
            data.resolution_u = 10
            if data.font is None or data.font.filepath != "<builtin>":
                raise RuntimeError("Expected Blender's bundled default Bfont Regular")
            obj = bpy.data.objects.new(f"Decal artwork / {name}", data)
            artwork.collection.objects.link(obj)
            data.materials.append(ink)
            obj.location = (0, vertical, .01)
            text_objects.append((obj, maximum_width, maximum_height))
        # The temporary scene has its own depsgraph; no live scene camera or rig changes.
        artwork.view_layers[0].update()
        for obj, width, height in text_objects:
            bounds = [Vector(corner) for corner in obj.bound_box]
            scale = min(width/max(1e-8, max(p.x for p in bounds)-min(p.x for p in bounds)),
                        height/max(1e-8, max(p.y for p in bounds)-min(p.y for p in bounds)))
            obj.scale = (scale, scale, scale)
        artwork.view_layers[0].update()
        temporary_objects = list(artwork.objects)
        try:
            bpy.ops.render.render(write_still=True, scene=artwork.name)
        finally:
            bpy.data.scenes.remove(artwork)
            for obj in temporary_objects:
                bpy.data.objects.remove(obj, do_unlink=True)
    image = bpy.data.images.load(str(path), check_existing=True)
    image.colorspace_settings.name = "sRGB"
    image.pack()
    return image


def product_decals(source, objects, samples_root, output_root):
    """Split projected patches by source mesh so nested part motion carries ink."""
    geometry = decal_geometry()
    components = {component["id"]: component for component in source["product"]["components"]}
    source_parts = source_part_objects(objects)
    details = []
    bpy.context.view_layer.update()
    for specification in source["product"].get("decals", []):
        component = components[specification["componentId"]]
        if component["shape"] == "mesh":
            asset_path = verified_asset_record(component["asset"], samples_root, "Product decal")
            payload = asset_path.read_bytes()
            size = struct.unpack_from("<I", payload, 12)[0]
            document = json.loads(payload[20:20+size])
            selected = specification["partId"]
            indices = (document["scenes"][0]["nodes"] if selected == component["id"]
                       else [int(selected.rsplit(":", 1)[1])])
            meshes, pending = [], list(reversed(indices))
            while pending:
                index = pending.pop()
                node = document["nodes"][index]
                if "mesh" in node:
                    meshes.append(index)
                pending.extend(reversed(node.get("children", [])))
            sources = [(f"{component['id']}::node:{index}",
                        geometry.imported_triangles(payload, f"{component['id']}::node:{index}",
                                                    component["id"], descendants=False)) for index in meshes]
        else:
            sources = [(component["id"], geometry.primitive_triangles(component))]
        image = (artwork_image(specification["artwork"], samples_root) if specification.get("artwork")
                 else decal_artwork(specification, output_root))
        surface = material(f"Decal / {specification['id']} / surface", (1, 1, 1, 1), .53)
        if specification.get("artwork"):
            connect_artwork(surface, image)
        else:
            texture = surface.node_tree.nodes.new("ShaderNodeTexImage")
            texture.image = image
            surface.node_tree.links.new(texture.outputs["Color"], surface.node_tree.nodes.get("Principled BSDF").inputs["Base Color"])
        total, pieces = 0, 0
        for attachment_id, triangles in sources:
            positions, normals, uvs = [], [], []
            for triangle in triangles:
                for patch in geometry.project_triangle(triangle, specification):
                    for point in patch:
                        position = [point[axis] + point[axis+3]*.000002 for axis in range(3)]
                        positions.append(blender_position(position))
                        normals.append(blender_position(point[3:6]))
                        uvs.append(point[6:8])
            if not positions:
                continue
            name = f"Decal / {specification['id']}" + (f" / {attachment_id}" if pieces else "")
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(positions, [], [tuple(range(i, i+3)) for i in range(0, len(positions), 3)])
            mesh.update()
            uv_layer = mesh.uv_layers.new(name="Decal artwork")
            for polygon in mesh.polygons:
                polygon.use_smooth = True
                for loop_index in polygon.loop_indices:
                    uv_layer.data[loop_index].uv = uvs[mesh.loops[loop_index].vertex_index]
            mesh.normals_split_custom_set_from_vertices(normals)
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.collection.objects.link(obj)
            parent = source_parts.get(attachment_id, objects[component["id"]])
            obj.parent = parent
            obj.matrix_parent_inverse = Matrix.Identity(4)
            obj.matrix_basis = parent.matrix_world.inverted() @ objects[component["id"]].matrix_world
            obj["source_part_id"] = specification["partId"]
            obj["attachment_part_id"] = attachment_id
            obj["height_m"] = specification["heightM"]
            obj["bevel_m"] = specification["bevelM"]
            mesh.materials.append(surface)
            pieces += 1
            total += len(positions)//3
        if not total:
            raise ValueError(f"Decal {specification['id']} does not intersect the selected source UV map")
        details.append({"id": specification["id"], "componentId": component["id"], "partId": specification["partId"],
                        "triangles": total, "pieces": pieces, "heightM": specification["heightM"], "bevelM": specification["bevelM"],
                        "uvSource": "Original source TEXCOORD_0" if component["shape"] == "mesh" else "Editor procedural UV map"})
    return details


def area_light(name, position, target, power, size, color):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = power
    data.shape = "DISK"
    data.size = size
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def spot_light(name, position, target, power, cone_deg, blend, radius, color):
    """A hard, aimed Cycles spot: power is specified like a point light's, the
    cone masks it, and the emitter radius sets the shadow softness."""
    data = bpy.data.lights.new(name, "SPOT")
    data.energy = power
    data.spot_size = math.radians(cone_deg)
    data.spot_blend = blend
    data.shadow_soft_size = radius
    data.color = color
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def configure_scene(source, width, height, samples):
    scene = bpy.context.scene
    settings = source["render"]
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1
    scene.render.engine = "CYCLES"
    # CPU without denoising remains the reference profile. GESSO_CYCLES_DEVICE=METAL
    # and GESSO_CYCLES_DENOISE=1 opt into local acceleration; both are recorded in
    # render-config.json so an accelerated job is never mistaken for a reference one.
    scene.cycles.device = "CPU"
    if os.environ.get("GESSO_CYCLES_DEVICE", "").upper() == "METAL":
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = "METAL"
        preferences.get_devices()
        for device in preferences.devices:
            device.use = device.type != "CPU"
        scene.cycles.device = "GPU"
    scene.cycles.samples = samples or settings["samples"]
    scene.cycles.seed = settings["seed"]
    scene.cycles.use_animated_seed = False
    # Avoid optional OIDN/OptiX dependencies: some Blender 4.3.2 builds omit them.
    # The same sampled scene and seed therefore use the same portable settings.
    scene.cycles.use_denoising = os.environ.get("GESSO_CYCLES_DENOISE", "") == "1"
    if scene.cycles.use_denoising:
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
        scene.cycles.denoising_use_gpu = True
    scene.cycles.max_bounces = 8
    scene.cycles.transmission_bounces = 8
    scene.render.resolution_x = width or settings["width"]
    scene.render.resolution_y = height or settings["height"]
    scene.render.resolution_percentage = 100
    scene.render.fps = settings["fps"]
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (*source["environment"]["worldColor"], 1)
    background.inputs["Strength"].default_value = source.get("lighting", {}).get("ambientStrength", 0.45)
    ambient_color = source.get("lighting", {}).get("ambientColor")
    if ambient_color:
        # The camera keeps seeing the authored world colour; every other ray
        # receives the ambient colour, so a dark field can carry a warm fill.
        nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
        camera = nodes.new("ShaderNodeLightPath")
        mix = nodes.new("ShaderNodeMix")
        mix.name = "Ambient / colour for non-camera rays"
        mix.data_type = "RGBA"
        links.new(camera.outputs["Is Camera Ray"], mix.inputs["Factor"])
        mix.inputs[6].default_value = (*ambient_color, 1)
        mix.inputs[7].default_value = (*source["environment"]["worldColor"], 1)
        links.new(mix.outputs[2], background.inputs["Color"])
    return scene


def hdri_lighting(source, samples_root):
    specification = source.get("lighting", {}).get("hdri")
    if not specification:
        return
    sys.path.insert(0, str(package_root()))
    from film.material_assets import validate_hdri_asset
    from film.polyhaven import validate_hdri
    asset = validate_hdri_asset(specification["asset"])
    path = verified_asset_record(asset, samples_root.resolve(), "HDRI")
    validate_hdri(path.read_bytes())
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "Linear Rec.709"
    image.pack()
    world = bpy.context.scene.world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    background = nodes.get("Background")
    output = nodes.get("World Output")
    texture = nodes.new("ShaderNodeTexEnvironment")
    texture.name = "HDRI / environment"
    texture.image = image
    texture.projection = "EQUIRECTANGULAR"
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.vector_type = "VECTOR"
    # The editor's positive canonical-Y environment rotation is an inverse
    # lookup rotation. Canonical Y becomes Blender Z without another handedness flip.
    mapping.inputs["Rotation"].default_value[2] = -math.radians(specification["rotationDeg"])
    links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    illuminated = nodes.new("ShaderNodeBackground")
    illuminated.name = "HDRI / lighting intensity"
    illuminated.inputs["Strength"].default_value = specification["intensity"]
    links.new(texture.outputs["Color"], illuminated.inputs["Color"])
    camera = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    mix.name = "HDRI / keep authored camera background"
    links.new(camera.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(illuminated.outputs["Background"], mix.inputs[1])
    links.new(background.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    world["hdri_source"] = specification.get("sourceUrl", "")
    world["hdri_policy"] = "Lighting and reflections only; authored camera background preserved"


def environment(source, samples_root=None):
    """Build only explicit near-field geometry plus the common studio lights."""
    if source.get("lighting", {}).get("hdri"):
        if samples_root is None:
            raise ValueError("HDRI requires the sampled scene asset bundle")
        hdri_lighting(source, samples_root)
    plinth = source["environment"]["plinth"]
    studio_size = source["environment"].get("studioSizeM", max(source["product"]["dimensionsM"]))
    if plinth.get("visible", True):
        porcelain = specified_material("Set / plinth surface", plinth["material"], samples_root) if "material" in plinth else material("Set / warm matte porcelain", (0.56, 0.54, 0.49, 1), 0.58)
        obj = primitive(plinth["id"], "box", plinth["sizeM"], porcelain, min(0.004, min(plinth["sizeM"]) / 2))
        obj.location = blender_position(plinth["translationM"])
    if source["environment"]["kind"] == "splat" and source["environment"].get("collider") and samples_root is not None:
        # The provider's collider mesh stands in for the world's geometry: it catches
        # the product's shadow and, as a holdout, lets world geometry in front of the
        # product cut it out so the composited plate shows through.
        collider = source["environment"]["collider"]["asset"]
        collider_path = verified_asset_record(collider, samples_root.resolve(), "world collider")
        imported, _ = imported_hierarchy(collider_path, "World collider / ")
        anchor = parent_imported_hierarchy(imported, "World / collider alignment")
        anchor.location = blender_position(collider["translationM"])
        anchor.rotation_mode = "QUATERNION"
        anchor.rotation_quaternion = blender_rotation(collider["rotationXyzw"])
        anchor.scale = (collider["scaleToMeters"],) * 3
        for obj in imported:
            if obj.type == "MESH":
                obj.is_shadow_catcher = True
                obj.is_holdout = True
                obj.visible_glossy = False
                obj.visible_transmission = False
                obj.visible_diffuse = False
                obj["role"] = "Invisible world collider: shadow catcher and holdout for the Gaussian plate"
    elif source["environment"]["kind"] == "splat":
        # The Gaussian world is a colour plate with no geometry, so the product's
        # contact shadow would otherwise vanish. An invisible Cycles shadow catcher
        # at the support height receives the product shadow for the compositor.
        floor_height = plinth["translationM"][1] + plinth["sizeM"][1] / 2
        extent = studio_size * 40
        mesh = bpy.data.meshes.new("World / shadow catcher mesh")
        mesh.from_pydata([(-extent, -extent, 0), (extent, -extent, 0), (extent, extent, 0), (-extent, extent, 0)], [], [(0, 1, 2, 3)])
        mesh.update()
        catcher = bpy.data.objects.new("World / shadow catcher", mesh)
        bpy.context.collection.objects.link(catcher)
        catcher.location = blender_position([0, floor_height, 0])
        catcher.data.materials.append(material("World / shadow catcher surface", (0.8, 0.8, 0.8, 1), 0.9))
        catcher.is_shadow_catcher = True
        catcher.visible_glossy = False
        catcher.visible_transmission = False
        catcher["role"] = "Invisible shadow catcher at the support height for Gaussian plate worlds"
    for prop in source["environment"].get("props", []):
        if bpy.data.objects.get(prop["id"]):
            raise ValueError(f"Near-field prop ID collides with an existing object: {prop['id']}")
        if prop["shape"] == "mesh":
            if samples_root is None:
                raise ValueError("Mesh props require the sampled scene asset bundle")
            intrinsic = prop["asset"]["sourceDimensionsM"]
            source_component = dict(prop, sizeM=intrinsic)
            obj, details = product_mesh(source_component, samples_root)
            sx, sy, sz = [prop["sizeM"][axis]/intrinsic[axis] for axis in range(3)]
            obj.scale = (sx, sz, sy)
        else:
            obj = primitive(prop["id"], prop["shape"], prop["sizeM"], specified_material(prop["id"] + " / surface", prop["material"], samples_root), prop.get("bevelM", 0))
        obj.location = blender_position(prop["translationM"])
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = blender_rotation(prop["rotationXyzw"])
        obj["role"] = "Explicit near-field prop; independent of imported world alignment"
    if source["environment"]["kind"] == "authored":
        # The authored fallback sweep must never cover a mesh or splat plate.
        # Product placement stays at the support top even when the plinth is hidden.
        support_side = -1 if plinth.get("visible", True) else 1
        floor_height = plinth["translationM"][1] + support_side * plinth["sizeM"][1] / 2
        radius = studio_size * 3
        sweep = [(-radius * 15, floor_height - 0.0001), (radius, floor_height - 0.0001)]
        sweep.extend((radius + radius * math.sin(index * math.pi / 64), floor_height + radius * (1 - math.cos(index * math.pi / 64))) for index in range(1, 33))
        sweep.append((radius * 2, floor_height + radius * 15))
        vertices = [(x, y, z) for y, z in sweep for x in (-radius * 15, radius * 15)]
        faces = [(2 * index, 2 * index + 1, 2 * index + 3, 2 * index + 2) for index in range(len(sweep) - 1)]
        mesh = bpy.data.meshes.new("Set / curved sweep mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        floor = bpy.data.objects.new("Set / curved studio sweep", mesh)
        bpy.context.collection.objects.link(floor)
        sweep_color = source["environment"].get("worldColor", [0.26, 0.28, 0.26])
        floor.data.materials.append(material("Set / studio sweep", (*sweep_color, 1), 0.72))
    if "lighting" in source:
        for light in source["lighting"]["lights"]:
            if light["enabled"]:
                position, target = blender_position(light["positionM"]), blender_position(light["targetM"])
                if light.get("type", "area") == "spot":
                    obj = spot_light("Studio / " + light["name"], position, target, light["powerW"], light.get("coneDeg", 40), light.get("blend", 0.3), light["diameterM"] / 2, light["color"])
                else:
                    obj = area_light("Studio / " + light["name"], position, target, light["powerW"], light["diameterM"], light["color"])
                # The sampled light poses are matched back by scene ID, never by name.
                obj["gesso_light_id"] = light["id"]
        return
    # Use the fixed stage reference when supplied; legacy scenes follow product size.
    size = studio_size
    scale = size / 0.12
    rig_origin = (source["placement"]["translationM"] if "studioSizeM" not in source["environment"] else
                  [value + (plinth["sizeM"][1] / 2 if axis == 1 else 0)
                   for axis, value in enumerate(plinth["translationM"])])
    position = blender_position(rig_origin)
    target = Vector(position) + Vector((0, 0, size * 0.52))
    for name, offset, power, diameter, color in (
        ("Studio / large soft key", (-0.19, -0.24, 0.32), 2.6, 0.23, (1.0, 0.93, 0.82)),
        ("Studio / cool fill", (0.22, -0.07, 0.19), 0.8, 0.20, (0.82, 0.91, 1.0)),
        ("Studio / edge strip", (0.06, 0.19, 0.30), 3.4, 0.16, (1.0, 0.98, 0.90)),
    ):
        area_light(name, Vector(position) + Vector(offset) * scale, target, power * scale * scale, diameter * scale, color)


def verified_asset_record(asset, samples_root, role="World"):
    """Resolve immutable bundled assets without allowing external path reads."""
    value = asset.get("path")
    if not isinstance(value, str) or not value or any(part in {"", ".", ".."} for part in value.split("/")) or any(character in value for character in ("\\", ":", "\0")):
        raise ValueError(f"{role} asset path must be a safe relative path")
    relative = Path(value)
    if relative.is_absolute():
        raise ValueError(f"{role} asset path must be a safe relative path")
    path = (samples_root / relative).resolve()
    if not path.is_relative_to(samples_root) or not path.is_file():
        raise ValueError(f"{role} asset is missing or outside the sampled scene bundle")
    if not 0 < path.stat().st_size <= 128 * 1024 * 1024:
        raise ValueError(f"{role} asset must be nonempty and no larger than 128 MiB")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != asset["sha256"]:
        raise ValueError(f"{role} asset SHA256 does not match the scene manifest")
    return path


def verified_asset(source, samples_root):
    return verified_asset_record(source["environment"]["asset"], samples_root)


def visual_glb_document(asset, asset_path):
    """Check the same local/self-contained boundary for products and worlds."""
    if asset["format"] != "glb" or asset["sourceUp"] != "Y":
        raise ValueError("Visual GLB must declare format=glb and sourceUp=Y, as required by glTF 2")
    # Direct renderer calls receive the same self-contained constraint as import.
    with asset_path.open("rb") as stream:
        header = stream.read(20)
        if len(header) != 20 or header[:4] != b"glTF" or struct.unpack_from("<I", header, 4)[0] != 2 or struct.unpack_from("<I", header, 8)[0] != asset_path.stat().st_size or header[16:20] != b"JSON":
            raise ValueError("Visual mesh must be a self-contained GLB 2 file")
        json_size = struct.unpack_from("<I", header, 12)[0]
        if json_size > 16 * 1024 * 1024 or json_size % 4 or 20 + json_size > asset_path.stat().st_size:
            raise ValueError("GLB JSON chunk exceeds the 16 MiB limit")
        document = json.loads(stream.read(json_size))
        remainder = stream.read()
        if remainder:
            if len(remainder) < 8 or remainder[4:8] != b"BIN\0" or struct.unpack_from("<I", remainder)[0] != len(remainder) - 8 or (len(remainder) - 8) % 4:
                raise ValueError("Visual GLB contains unsupported or truncated chunks")

    def embedded_only(value, depth=0):
        if depth > 80:
            raise ValueError("GLB JSON nesting is too deep")
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in {"script", "scripts", "javascript"}:
                    raise ValueError("GLB scripts are forbidden")
                if key.lower() in {"uri", "url", "href"}:
                    if not isinstance(child, str) or not child.startswith("data:"):
                        raise ValueError("GLB visual assets cannot reference external URIs")
                    header, separator, body = child.partition(",")
                    if not separator or header[5:] not in {"application/octet-stream;base64", "application/gltf-buffer;base64", "image/png;base64", "image/jpeg;base64", "image/webp;base64"}:
                        raise ValueError("GLB data URI type is unsupported")
                    base64.b64decode(body, validate=True)
                embedded_only(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                embedded_only(child, depth + 1)
        elif type(value) is float and not math.isfinite(value):
            raise ValueError("GLB JSON must contain finite numbers")

    embedded_only(document)
    if not isinstance(document, dict) or document.get("asset", {}).get("version") != "2.0":
        raise ValueError("Visual GLB must declare glTF 2.0")
    if not isinstance(document.get("meshes"), list) or not document["meshes"]:
        raise ValueError("Visual GLB must contain nonempty mesh geometry")
    if any(re.search(r"(?:^|[ _.-])(collider|collision)(?:[ _.-]|$)", mesh.get("name", "").lower()) for mesh in document["meshes"]):
        raise ValueError("Collision GLB cannot be imported as visual mesh geometry")
    for container in (document, document.get("asset", {}), *document["meshes"]):
        extras = container.get("extras", {})
        if isinstance(extras, dict) and any(str(extras.get(key, "")).lower() in {"collision", "collider", "collision-mesh"} for key in ("role", "kind", "assetType", "type")):
            raise ValueError("Collision-only GLB cannot be imported as visual mesh geometry")
    accessors = document.get("accessors", [])
    if not any(type(primitive.get("attributes", {}).get("POSITION")) is int
               and 0 <= primitive["attributes"]["POSITION"] < len(accessors)
               and accessors[primitive["attributes"]["POSITION"]].get("count", 0) > 0
               for mesh in document["meshes"] for primitive in mesh.get("primitives", [])):
        raise ValueError("Visual GLB must contain nonempty mesh geometry")
    return document


def imported_hierarchy(asset_path, prefix):
    """Keep static visual hierarchy; imported cameras/lights never alter the rig."""
    existing = set(bpy.data.objects)
    active_camera = bpy.context.scene.camera
    bpy.ops.import_scene.gltf(filepath=str(asset_path), import_pack_images=True)
    imported = set(bpy.data.objects) - existing
    bpy.context.view_layer.update()
    excluded = {obj for obj in imported if obj.type in {"CAMERA", "LIGHT"}}
    # Cameras/lights may have visual descendants. Preserve their original world
    # transforms when removing only the embedded render apparatus.
    matrices = {obj: obj.matrix_world.copy() for obj in imported}
    kept = imported - excluded
    for obj in kept:
        if obj.parent in excluded:
            parent = obj.parent
            while parent in excluded:
                parent = parent.parent
            obj.parent = parent
            obj.matrix_world = matrices[obj]
    excluded_names = sorted(obj.name for obj in excluded)
    for obj in excluded:
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.scene.camera = active_camera
    if not any(obj.type == "MESH" and obj.data.vertices and obj.data.polygons for obj in kept):
        raise ValueError("Visual GLB import produced no nonempty mesh geometry")
    for obj in kept:
        obj.name = prefix + obj.name
    return kept, excluded_names


def parent_imported_hierarchy(imported, name):
    anchor = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(anchor)
    for obj in imported:
        if obj.parent not in imported:
            matrix = obj.matrix_world.copy()
            obj.parent = anchor
            obj.matrix_parent_inverse = Matrix.Identity(4)
            obj.matrix_basis = matrix
    return anchor


def import_visual_mesh(source, asset_path):
    """Import visual GLB, then align the imported hierarchy exactly once."""
    asset = source["environment"]["asset"]
    visual_glb_document(asset, asset_path)
    imported, excluded = imported_hierarchy(asset_path, "World / ")
    anchor = parent_imported_hierarchy(imported, "World / visual mesh alignment")
    # glTF importer already applies the canonical Y-up -> Blender Z-up change.
    # Applying COORDINATE_ROTATION again here would rotate the room on its side.
    anchor.location = blender_position(asset["translationM"])
    anchor.rotation_mode = "QUATERNION"
    anchor.rotation_quaternion = blender_rotation(asset["rotationXyzw"])
    anchor.scale = (asset["scaleToMeters"],) * 3
    anchor["asset_sha256"] = asset["sha256"]
    anchor["source_up"] = "Y; converted once by Blender glTF importer"
    return {"importedObjects": len(imported), "excludedEmbeddedCamerasAndLights": excluded}


def material_binding_nodes(component, document, material_presets):
    """Resolve node bindings on immutable glTF indices, nearest ancestor first."""
    bindings = component.get("materialBindings", [])
    if not isinstance(bindings, list) or len(bindings) > 100000:
        raise ValueError("Material section bindings must be a bounded list")
    presets = {preset["id"]: preset for preset in material_presets}
    direct = {}
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {"nodeIndex", "materialPresetId"}:
            raise ValueError("Material section binding must contain nodeIndex and materialPresetId")
        index, preset_id = binding["nodeIndex"], binding["materialPresetId"]
        if type(index) is not int or not 0 <= index < len(document["nodes"]) or index in direct:
            raise ValueError("Material section node indices must exist and be unique")
        if not isinstance(preset_id, str) or preset_id not in presets:
            raise ValueError("Material section preset does not exist")
        direct[index] = presets[preset_id]
    drawable, effective = set(), {}
    def visit(index, inherited=None):
        node = document["nodes"][index]
        selected = direct.get(index, inherited)
        has_mesh = "mesh" in node
        if has_mesh and selected is not None:
            effective[index] = selected
        for child in node.get("children", []):
            has_mesh = visit(child, selected) or has_mesh
        if has_mesh:
            drawable.add(index)
        return has_mesh
    for root in document["scenes"][document.get("scene", 0)]["nodes"]:
        visit(root)
    if any(index not in drawable for index in direct):
        raise ValueError("Material section must reference a source node with mesh geometry")
    return effective


def import_bound_product_hierarchy(path, document, prefix):
    """Add import-only indices; original GLB bytes, geometry and names stay intact.

    Blender copies node extras to object properties. Indices survive duplicate
    names and repeated mesh instances, unlike matching sanitized object names.
    """
    payload = path.read_bytes()
    old_json_length = struct.unpack_from("<I", payload, 12)[0]
    for index, node in enumerate(document["nodes"]):
        extras = dict(node["extras"]) if isinstance(node.get("extras"), dict) else {}
        extras["gesso_material_node_index"] = index
        node["extras"] = extras
    encoded = json.dumps(document, separators=(",", ":"), allow_nan=False).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    tail = payload[20 + old_json_length:]
    rewritten = (struct.pack("<4sII", b"glTF", 2, 20 + len(encoded) + len(tail))
                 + struct.pack("<I4s", len(encoded), b"JSON") + encoded + tail)
    with tempfile.TemporaryDirectory(prefix="gesso-material-import-") as directory:
        tagged = Path(directory) / "product.glb"
        tagged.write_bytes(rewritten)
        return imported_hierarchy(tagged, prefix)


def product_mesh(component, samples_root, material_presets=()):
    """A static metre-space GLB is one externally posed rigid component."""
    asset = component["asset"]
    path = verified_asset_record(asset, samples_root, "Product")
    document = visual_glb_document(asset, path)
    if document.get("animations") or document.get("skins") or any("skin" in node for node in document.get("nodes", [])):
        raise ValueError("Rigid product GLB cannot contain animations or skins")
    # Blender 4.3 imports every document node, including inactive/unreferenced
    # ones. The normalized handoff must match the hierarchy measured upstream.
    scenes, nodes = document.get("scenes", []), document.get("nodes", [])
    if len(scenes) != 1 or document.get("scene", 0) != 0 or not isinstance(nodes, list) or not nodes:
        raise ValueError("Rigid product GLB requires one fully reachable active scene with no unused nodes or meshes")
    roots = scenes[0].get("nodes", [])
    if not isinstance(roots, list) or not roots:
        raise ValueError("Rigid product GLB requires one fully reachable active scene with no unused nodes or meshes")
    stack = [(index, 0) for index in roots]
    reached, meshes = set(), set()
    while stack:
        index, depth = stack.pop()
        if type(index) is not int or not 0 <= index < len(nodes) or index in reached or depth > 80:
            raise ValueError("Rigid product GLB hierarchy must be acyclic, singly parented and fully reachable")
        reached.add(index)
        node = nodes[index]
        children = node.get("children", [])
        if not isinstance(children, list):
            raise ValueError("Rigid product GLB node children must be a list")
        stack.extend((child, depth + 1) for child in children)
        if "mesh" in node:
            meshes.add(node["mesh"])
    if len(reached) != len(nodes) or meshes != set(range(len(document["meshes"]))):
        raise ValueError("Rigid product GLB requires one fully reachable active scene with no unused nodes or meshes")
    bindings = material_binding_nodes(component, document, material_presets)
    prefix = f"Product / {component['id']} / "
    imported, excluded = import_bound_product_hierarchy(path, document, prefix)
    anchor = parent_imported_hierarchy(imported, component["id"])
    for obj in imported:
        node_index = obj.get("gesso_material_node_index")
        if type(node_index) is int:
            obj["gesso_source_node_index"] = node_index
            obj["source_part_id"] = f"{component['id']}::node:{node_index}"
    meshes = [obj for obj in imported if obj.type == "MESH"]
    override = component.get("materialOverride", False)
    surfaces = {}
    for obj in meshes:
        node_index = obj.get("gesso_material_node_index")
        if bindings and (type(node_index) is not int or not 0 <= node_index < len(nodes)):
            raise ValueError("Imported material section lost its source node identity")
        preset = bindings.get(node_index) if bindings else None
        if preset is not None:
            specification, surface_key = preset["material"], ("preset", preset["id"])
            obj["gesso_material_preset_id"] = preset["id"]
        elif override:
            specification, surface_key = component["material"], ("component", component["id"])
        else:
            continue
        if surface_key not in surfaces:
            surfaces[surface_key] = specified_material(component["id"] + " / " + (preset["name"] if preset else "surface"), specification, samples_root)
        # glTF instances may share a Blender mesh datablock. Material slots and
        # UV edits belong to this assigned object, never to its unassigned peers.
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        if specification.get("textures") and obj.data.uv_layers.active:
            # Blender flips glTF UV V on import. Restore raw source UVs for
            # editor-applied maps, including the tangent-space normal basis.
            for loop in obj.data.uv_layers.active.data:
                loop.uv.y = 1 - loop.uv.y
            obj["gesso_uv0_source"] = True
        obj.data.materials.clear()
        obj.data.materials.append(surfaces[surface_key])
        for polygon in obj.data.polygons:
            polygon.material_index = 0
    # No sizeM scaling or recentering: input geometry has approved local metre
    # coordinates, and the external pose belongs only to this rigid anchor.
    anchor["asset_sha256"] = asset["sha256"]
    anchor["role"] = "Rigid product GLB component; centered local geometry in metres"
    material_source = "section bindings" if bindings else "declared override" if override else "original GLB materials"
    anchor["material_source"] = material_source
    return anchor, {"id": component["id"], "shape": "mesh", "asset": asset, "importedObjects": len(imported),
                    "meshObjects": len(meshes), "materialSource": material_source,
                    "excludedEmbeddedCamerasAndLights": excluded, "geometryPolicy": "Centered local metres; no rescaling or recentering"}


def plate_compositor(source, frames, requested, samples_root, output_root, scene):
    """Composite the captured Gaussian world behind transparent Cycles geometry."""
    visible_frames = [sample for sample in frames if sample.get("clip", {}).get("kind", "scene") == "scene"]
    required = requested or [visible_frames[0]["frame"]]
    width, height = scene.render.resolution_x, scene.render.resolution_y
    manifest_path = (samples_root / "plate" / "capture-manifest.json").resolve()
    if not manifest_path.is_relative_to(samples_root) or not manifest_path.is_file():
        raise ValueError("Gaussian plates require plate/capture-manifest.json to verify the sampled cameras and source asset")
    if manifest_path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Gaussian capture manifest exceeds the size limit")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    digest = hashlib.sha256(json.dumps(source, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    if manifest.get("sourceDigest") != digest or manifest.get("assetSha256") != source["environment"]["asset"]["sha256"]:
        raise ValueError("Gaussian capture manifest does not match the sampled scene and world asset")
    profile = manifest.get("profile", {})
    if profile.get("width") != width or profile.get("height") != height:
        raise ValueError("Gaussian capture manifest resolution does not match the render profile")
    if profile.get("colorSpace") != "srgb" or profile.get("toneMapping") != "none" or profile.get("contents") != "gaussian-world-only":
        raise ValueError("Gaussian plate capture must contain only the world, with sRGB output and no tone mapping")
    if any(sample["camera"].get("depthOfField", {}).get("enabled", False) for sample in frames):
        if profile.get("depthOfField") != "sampled-camera":
            raise ValueError("Gaussian plates with optical focus require sampled-camera depth of field capture")
    for frame in required:
        path = (samples_root / "plate" / f"{frame:06d}.png").resolve()
        if not path.is_relative_to(samples_root) or not path.is_file():
            raise ValueError(f"Missing camera-matched Gaussian plate for frame {frame}: plate/{frame:06d}.png")
        with path.open("rb") as stream:
            header = stream.read(24)
        if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
            raise ValueError(f"Invalid Gaussian plate PNG at frame {frame}")
        if struct.unpack_from(">II", header, 16) != (width, height):
            raise ValueError(f"Gaussian plate resolution must match {width}x{height} at frame {frame}")
        with path.open("rb") as stream:
            plate_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if frame not in profile.get("frameNumbers", []) or manifest.get("frames", {}).get(str(frame)) != plate_hash:
            raise ValueError(f"Gaussian plate frame {frame} is missing from or does not match its capture manifest")
    scene.render.film_transparent = True
    scene.cycles.film_transparent_glass = False
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    layers = tree.nodes.new("CompositorNodeRLayers")
    layers.label = "Exact product + explicit near-field geometry"
    plate = tree.nodes.new("CompositorNodeImage")
    plate.name = "Gaussian camera-matched plate"
    plate.label = "sRGB / no capture tone mapping / no depth"
    first_frame = visible_frames[0]["frame"]
    image = bpy.data.images.load(str(samples_root / "plate" / f"{min(required):06d}.png"), check_existing=False)
    if tuple(image.size) != (width, height):
        raise ValueError("Gaussian plate could not be decoded at the expected resolution")
    image.colorspace_settings.name = "sRGB"
    image.source = "SEQUENCE"
    plate.image = image
    plate.frame_start = first_frame
    plate.frame_duration = scene.frame_end - first_frame + 1
    plate.use_auto_refresh = True
    image.filepath = bpy.path.relpath(str(samples_root / "plate" / f"{first_frame:06d}.png"), start=str(output_root))
    composite = tree.nodes.new("CompositorNodeAlphaOver")
    composite.inputs[0].default_value = 1
    tree.links.new(plate.outputs["Image"], composite.inputs[1])
    tree.links.new(layers.outputs["Image"], composite.inputs[2])
    output = tree.nodes.new("CompositorNodeComposite")
    tree.links.new(composite.outputs["Image"], output.inputs["Image"])
    return {"directory": "plate", "sequenceRelativeToBlend": image.filepath, "validatedFrames": required, "captureManifestVerified": True, "sourceDigest": digest, "colorSpace": "sRGB plate decoded to linear; AgX applied once after compositing", "captureToneMapping": "none", "sequenceStartFrame": first_frame}


def keyframe_camera_optics(camera_data, values, frame):
    """Apply the sampled optical lens once, inside Cycles rather than in composite."""
    optics = values.get("depthOfField", {})
    camera_data.dof.use_dof = optics.get("enabled", False)
    camera_data.dof.aperture_fstop = optics.get("fStop", 2.8)
    camera_data.dof.focus_object = None
    camera_data.dof.focus_distance = optics.get("focusDistanceM", math.dist(values["positionM"], values["targetM"]))
    for property_name in ("use_dof", "aperture_fstop", "focus_distance"):
        camera_data.keyframe_insert(data_path=f"dof.{property_name}", frame=frame, group="Sampled optical focus")


def animate(source, frames, objects, part_carriers=None):
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new("Camera / sampled 36mm vertical gate")
    camera_data.type = "PERSP"
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = 36
    camera_data.clip_start = 0.001
    camera_data.clip_end = 100
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    scene.frame_start = min(sample["frame"] for sample in frames)
    scene.frame_end = max(sample["frame"] for sample in frames)
    previous_rotations = {}
    previous_camera_rotation = None
    part_carriers = part_carriers or {}
    camera.rotation_mode = "QUATERNION"
    # Sampled light poses (present only when a scene animates a light) key the
    # studio light objects the same way as the camera: location plus a tracking
    # rotation recomputed per frame, matched by the light's scene ID.
    lights = {obj["gesso_light_id"]: obj for obj in scene.objects if obj.type == "LIGHT" and "gesso_light_id" in obj}
    previous_light_rotations = {}
    for sample in frames:
        frame = sample["frame"]
        for pose in sample.get("lights", []):
            light = lights.get(pose["id"])
            if light is None:
                continue
            light.rotation_mode = "QUATERNION"
            light.location = blender_position(pose["positionM"])
            direction = Vector(blender_position(pose["targetM"])) - light.location
            if direction.length < 1e-8:
                raise ValueError(f"Light {pose['id']} position equals its target at frame {frame}")
            rotation = direction.to_track_quat("-Z", "Y")
            if pose["id"] in previous_light_rotations and rotation.dot(previous_light_rotations[pose["id"]]) < 0:
                rotation.negate()
            previous_light_rotations[pose["id"]] = rotation.copy()
            light.rotation_quaternion = rotation
            light.keyframe_insert(data_path="location", frame=frame, group="Sampled light")
            light.keyframe_insert(data_path="rotation_quaternion", frame=frame, group="Sampled light")
        for component_id, obj in objects.items():
            transform = sample["components"][component_id]
            obj.location = blender_position(transform["translationM"])
            # Pose the rigid component root; GLB hierarchy, label typography and
            # decals inherit scale without changing their source local geometry.
            obj.scale = (transform.get("scale", 1),) * 3
            rotation = blender_rotation(transform["rotationXyzw"])
            # Quaternion sign is arbitrary; keep neighbouring samples continuous.
            if component_id in previous_rotations and rotation.dot(previous_rotations[component_id]) < 0:
                rotation.negate()
            previous_rotations[component_id] = rotation.copy()
            obj.rotation_mode = "QUATERNION"
            obj.rotation_quaternion = rotation
            obj.keyframe_insert(data_path="location", frame=frame, group="Sampled world transform")
            obj.keyframe_insert(data_path="rotation_quaternion", frame=frame, group="Sampled world transform")
            obj.keyframe_insert(data_path="scale", frame=frame, group="Sampled world transform")
        for part_id, carrier in part_carriers.items():
            pose = sample.get("parts", {}).get(part_id)
            carrier.rotation_mode = "QUATERNION"
            carrier.matrix_basis = blender_matrix(pose["deltaMatrix"]) if pose else Matrix.Identity(4)
            rotation = carrier.rotation_quaternion.copy()
            if part_id in previous_rotations and rotation.dot(previous_rotations[part_id]) < 0:
                rotation.negate()
            carrier.rotation_quaternion = rotation
            previous_rotations[part_id] = rotation.copy()
            for property_name in ("location", "rotation_quaternion", "scale"):
                carrier.keyframe_insert(data_path=property_name, frame=frame, group="Sampled part delta")
        values = sample["camera"]
        camera.location = blender_position(values["positionM"])
        direction = Vector(blender_position(values["targetM"])) - camera.location
        if direction.length < 1e-8:
            raise ValueError(f"Camera position equals target at frame {frame}")
        rotation = direction.to_track_quat("-Z", "Y")
        if previous_camera_rotation is not None and rotation.dot(previous_camera_rotation) < 0:
            rotation.negate()
        previous_camera_rotation = rotation.copy()
        camera.rotation_quaternion = rotation
        camera_data.lens = values["focalLengthMm"]
        keyframe_camera_optics(camera_data, values, frame)
        camera.keyframe_insert(data_path="location", frame=frame, group="Sampled camera")
        camera.keyframe_insert(data_path="rotation_quaternion", frame=frame, group="Sampled camera")
        camera_data.keyframe_insert(data_path="lens", frame=frame)
    for item in [*objects.values(), *part_carriers.values(), *lights.values(), camera, camera_data]:
        if item.animation_data and item.animation_data.action:
            for curve in item.animation_data.action.fcurves:
                for keyframe in curve.keyframe_points:
                    keyframe.interpolation = "CONSTANT"
    for shot in source.get("shots", []):
        marker = scene.timeline_markers.new(shot.get("name", shot["id"]), frame=shot["startFrame"])
        marker.camera = camera
    scene.frame_set(scene.frame_start)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", default="", help="Comma-separated sampled frame numbers; omit to build only")
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--samples-per-pixel", type=int)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    for name in ("width", "height", "samples_per_pixel"):
        value = getattr(args, name)
        if value is not None and value < 1:
            parser.error(f"--{name.replace('_', '-')} must be a positive integer")
    try:
        args.frames = sorted(set(int(value.strip()) for value in args.frames.split(",") if value.strip()))
    except ValueError:
        parser.error("--frames must contain comma-separated integers")
    return args


def main():
    args = arguments()
    if bpy.app.version != BLENDER_VERSION:
        raise RuntimeError(f"Blender 4.3.2 is required, found {bpy.app.version_string}")
    args.samples = args.samples.resolve()
    payload = json.loads(args.samples.read_text(encoding="utf-8"))
    source, frames = payload["scene"], payload["frames"]
    if source["render"]["blenderVersion"] != "4.3.2" or source["render"]["engine"] != "CYCLES":
        raise ValueError("Scene must declare Blender 4.3.2 and CYCLES")
    if not frames:
        raise ValueError("At least one sampled frame is required")
    frame_ids = [sample["frame"] for sample in frames]
    if frame_ids != sorted(set(frame_ids)):
        raise ValueError("Sampled frame numbers must be unique and increasing")
    missing = set(args.frames) - set(frame_ids)
    if missing:
        raise ValueError(f"Requested frames are absent from the samples: {sorted(missing)}")
    flat_requested = [sample["frame"] for sample in frames if sample["frame"] in args.frames
                      and sample.get("clip", {}).get("kind", "scene") != "scene"]
    if flat_requested:
        raise ValueError("Image and black frames must be composed by the Film export worker, which preserves sRGB colors")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = configure_scene(source, args.width, args.height, args.samples_per_pixel)
    objects = {}
    product_components = []
    for component in source["product"]["components"]:
        if component["shape"] == "mesh":
            obj, details = product_mesh(component, args.samples.parent, source["product"].get("materialPresets", []))
        else:
            surface = specified_material(component["id"] + " / surface", component["material"], args.samples.parent)
            build_primitive = textured_primitive if any(item["partId"] == component["id"]
                for item in source["product"].get("artwork", [])) else primitive
            obj = build_primitive(component["id"], component["shape"], component["sizeM"], surface, component.get("bevelM", 0))
            details = {"id": component["id"], "shape": component["shape"], "materialSource": "declared"}
        objects[component["id"]] = obj
        product_components.append(details)
    label = source["product"].get("label")
    if (label and not any(item["partId"] == label["componentId"] for item in source["product"].get("artwork", []))
            and not any(decal["componentId"] == label["componentId"] for decal in source["product"].get("decals", []))):
        component = next(item for item in source["product"]["components"] if item["id"] == label["componentId"])
        text_on_label(objects[label["componentId"]], label, component["sizeM"])
    replace_product_artwork(source, objects, args.samples.parent)
    part_carriers = part_motion_carriers(objects) if any(sample.get("parts") for sample in frames) else {}
    decal_details = product_decals(source, objects, args.samples.parent, args.output)
    removed = frames[0].get("removedPartIds", [])
    if any(sample.get("removedPartIds", []) != removed for sample in frames):
        raise ValueError("Product part removal is scene-wide and must match in every sampled frame")
    apply_product_removal(objects, removed)
    environment(source, args.samples.parent)
    animate(source, frames, objects, part_carriers)
    kind = source["environment"]["kind"]
    world_details = {}
    limitations = []
    if kind in {"mesh", "splat"}:
        asset_path = verified_asset(source, args.samples.parent)
        if kind == "mesh":
            world_details = import_visual_mesh(source, asset_path)
            limitations.append("Imported visual mesh appearance may contain baked illumination; physical material and lighting separation is unverified.")
        else:
            if source["environment"]["asset"]["format"] not in {"ply", "spz"}:
                raise ValueError("Gaussian plate environments require a PLY or SPZ source asset")
            if args.frames or (args.samples.parent / "plate" / "capture-manifest.json").is_file():
                world_details = plate_compositor(source, frames, args.frames, args.samples.parent, args.output, scene)
            else:
                world_details = {"flatContentOnly": True, "plate": "not needed for image or black frames"}
            limitations.extend([
                "Gaussian world is a camera-matched color plate, not native Cycles splat geometry or shading.",
                "No splat depth: the distant plate cannot occlude product or near-field geometry.",
                "Optical focus is sampled separately: Spark focuses Gaussian depth in the plate; Cycles focuses foreground geometry. No second blur is applied after compositing, and cross-boundary occlusion remains unavailable.",
                "No world-plate glass transmission, refraction, reflection or indirect illumination; Cycles sees explicit near-field geometry, an invisible shadow catcher at the support height and the declared world color.",
                "Keep plate/ with scene.blend: the captured frame sequence remains an external dependency of the saved native scene.",
            ])
    elif kind != "authored":
        raise ValueError(f"Unsupported environment kind: {kind}")
    if any(component.get("material", {}).get("transmission", 0) > 0 for component in [*source["product"]["components"], *source["environment"].get("props", [])]):
        limitations.append("Transmission/IOR glass probe settings do not establish validated packaging wall thickness, contents or optical quality.")
    if any(component["shape"] == "mesh" for component in source["product"]["components"]):
        limitations.append("Product GLB geometry and source materials are preserved as supplied; real-product accuracy and material appearance require review.")
    if source["environment"].get("fixture"):
        limitations.append("Original synthetic QA world fixture, not World Labs output; generated-world quality and human review gates remain unmeasured.")
    # Native 3D poses remain inspectable. Preserve the complete editorial schedule
    # and pack still sources alongside them; flat export frames bypass AgX.
    scene["film_timeline_json"] = json.dumps({"durationFrames": len(frames), "shots": source["shots"]}, sort_keys=True)
    scene["film_flat_content"] = "Image and black frames are composed in sRGB by the Film export worker; this scene preserves editable 3D poses and packed image sources."
    for shot in source.get("shots", []):
        if shot.get("kind") == "image":
            image = bpy.data.images.load(str(verified_asset_record(shot["image"]["asset"], args.samples.parent, "Film image")), check_existing=True)
            image.pack()
    scene["source_scene_id"] = source["sceneId"]
    scene["coordinate_conversion"] = "Canonical metres Y-up (x,y,z) -> Blender metres Z-up (x,-z,y)"
    scene["camera_gate"] = "36 mm vertical sensor; sampled position, target, focal length"
    scene["camera_focus"] = "Per-shot aperture; sampled axial focus distance; circular Cycles aperture; disabled by default"
    scene["interpolation"] = "CONSTANT: all integer frame poses are sampled and keyed"
    render_config = {
        "adapterVersion": 3,
        "blenderVersion": bpy.app.version_string,
        "engine": scene.render.engine,
        "device": scene.cycles.device,
        "seed": scene.cycles.seed,
        "samples": scene.cycles.samples,
        "denoising": scene.cycles.use_denoising,
        "width": scene.render.resolution_x,
        "height": scene.render.resolution_y,
        "fps": scene.render.fps,
        "viewTransform": scene.view_settings.view_transform,
        "look": scene.view_settings.look,
        "cameraGate": {"fit": "VERTICAL", "heightMm": 36},
        "depthOfField": {"policy": "sampled-camera", "renderer": "cycles-lens", "compositeBlur": False,
                         "enabledFrames": [sample["frame"] for sample in frames if sample["camera"].get("depthOfField", {}).get("enabled", False)]},
        "typography": {"font": "Bfont Regular", "source": "Blender 4.3.2 builtin"},
        "productComponents": product_components,
        "decals": decal_details,
        "renderingPath": {"authored": "authored-cycles", "mesh": "visual-glb-cycles", "splat": "gaussian-plate-cycles-foreground"}[kind],
        "limitations": limitations,
        "environment": {"kind": kind, "revisionId": source["environment"]["revisionId"], "asset": source["environment"].get("asset"), "provenance": source["environment"]["provenance"], "fixture": source["environment"].get("fixture", False), "reviewStatus": source["environment"].get("reviewStatus"), "details": world_details},
        "nearField": {"plinth": source["environment"]["plinth"], "props": source["environment"].get("props", [])},
        "coordinateConversion": {"from": "right-handed Y-up metres", "to": "right-handed Z-up metres", "position": "(x,-z,y)"},
        "lightingSource": source.get("lighting", {"preset": "legacy studio", "ambientStrength": 0.45}),
        "lighting": [
            {"name": obj.name, "type": obj.data.type, "positionM": list(obj.location), "powerW": obj.data.energy,
             "diameterM": obj.data.size if obj.data.type == "AREA" else obj.data.shadow_soft_size * 2, "color": list(obj.data.color),
             **({"coneDeg": math.degrees(obj.data.spot_size), "blend": obj.data.spot_blend} if obj.data.type == "SPOT" else {}),
             "animated": bool(obj.animation_data and obj.animation_data.action)}
            for obj in scene.objects if obj.type == "LIGHT"
        ],
    }
    scene["render_config_json"] = json.dumps(render_config, sort_keys=True)
    (args.output / "render-config.json").write_text(json.dumps(render_config, indent=2) + "\n", encoding="utf-8")
    # Keep the native artifact self-contained if bundled assets are added later.
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output / "scene.blend"))
    if args.frames:
        destination = args.output / "frames"
        destination.mkdir(exist_ok=True)
        for frame in args.frames:
            scene.frame_set(frame)
            scene.render.filepath = str(destination / f"{frame:06d}.png")
            bpy.ops.render.render(write_still=True)
            print(f"FRAME_COMPLETE {frame}", flush=True)
    print(f"SCENE_COMPLETE {args.output / 'scene.blend'}", flush=True)


if __name__ == "__main__":
    main()
