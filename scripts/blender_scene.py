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
import json
import math
from pathlib import Path
import re
import struct
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector


BLENDER_VERSION = (4, 3, 2)
COORDINATE_ROTATION = Quaternion((1.0, 0.0, 0.0), math.pi / 2.0)


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


def specified_material(name, specification):
    return material(name, specification["baseColor"], specification["roughness"], specification["metallic"], specification.get("transmission", 0), specification.get("ior", 1.5))


def primitive(name, shape, size, surface, bevel=0.0):
    """Create geometry already expressed in Blender local coordinates."""
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


def configure_scene(source, width, height, samples):
    scene = bpy.context.scene
    settings = source["render"]
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples or settings["samples"]
    scene.cycles.seed = settings["seed"]
    scene.cycles.use_animated_seed = False
    # Avoid optional OIDN/OptiX dependencies: some Blender 4.3.2 builds omit them.
    # The same sampled scene and seed therefore use the same portable settings.
    scene.cycles.use_denoising = False
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
    background.inputs["Strength"].default_value = 0.45
    return scene


def authored_floor_height(source):
    """Use the declared floor or the visible plinth's world-space bottom."""
    specification = source["environment"]
    height = specification.get("floorY")
    if type(height) in (int, float) and math.isfinite(height):
        return height
    plinth = specification["plinth"]
    if not plinth.get("visible", True):
        return 0
    x, y, z, w = plinth.get("rotationXyzw", [0, 0, 0, 1])
    rotation = Quaternion((w, x, y, z))
    rotation.normalize()
    half = [value / 2 for value in plinth["sizeM"]]
    extent = sum(abs((rotation @ Vector(axis)).y) * radius
                 for axis, radius in zip(((1, 0, 0), (0, 1, 0), (0, 0, 1)), half))
    return plinth["translationM"][1] - extent


def sampled_product_origin(source, first_sample=None):
    """Recover the resolved rigid root from an assembled component sample.

    The standalone renderer consumes exported samples without importing the
    evaluator. Removing the component's authored assembly transform recovers
    the support/placement origin, including product yaw and off-center CAD.
    """
    if first_sample:
        # A project may reopen on a frame where its first-listed cap is already
        # lifted. A rigid component still carries the unchanged assembly root.
        moving = {action["componentId"] for action in source.get("actions", [])}
        components = sorted(source["product"]["components"], key=lambda component: component["id"] in moving)
        for component in components:
            pose = first_sample.get("components", {}).get(component["id"])
            if pose is None:
                continue
            x, y, z, w = pose["rotationXyzw"]
            world_rotation = Quaternion((w, x, y, z))
            x, y, z, w = component["assembly"]["rotationXyzw"]
            assembly_rotation = Quaternion((w, x, y, z))
            root_rotation = world_rotation @ assembly_rotation.inverted()
            root_rotation.normalize()
            return list(Vector(pose["translationM"]) - root_rotation @ Vector(component["assembly"]["translationM"]))
    return list(source["placement"]["translationM"])


def environment(source, first_sample=None):
    """Build only explicit near-field geometry plus the common studio lights."""
    plinth = source["environment"]["plinth"]
    if plinth.get("visible", True):
        porcelain = material("Set / warm matte porcelain", (0.56, 0.54, 0.49, 1), 0.58)
        obj = primitive(plinth["id"], "box", plinth["sizeM"], porcelain, 0.004)
        obj.location = blender_position(plinth["translationM"])
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = blender_rotation(plinth.get("rotationXyzw", [0, 0, 0, 1]))
    props = {}
    for prop in source["environment"].get("props", []):
        if not prop.get("visible", True):
            continue
        if bpy.data.objects.get(prop["id"]):
            raise ValueError(f"Near-field prop ID collides with an existing object: {prop['id']}")
        obj = primitive(prop["id"], prop["shape"], prop["sizeM"], specified_material(prop["id"] + " / surface", prop["material"]), prop.get("bevelM", 0))
        pose = (first_sample or {}).get("props", {}).get(prop["id"], prop)
        obj.location = blender_position(pose["translationM"])
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = blender_rotation(pose["rotationXyzw"])
        obj["role"] = "Explicit near-field prop; independent of imported world alignment"
        props[prop["id"]] = obj
    if source["environment"]["kind"] == "authored":
        # The authored fallback sweep must never cover a mesh or splat plate.
        floor_height = authored_floor_height(source)
        radius = max(source["product"]["dimensionsM"]) * 3
        sweep = [(-radius * 15, floor_height), (radius, floor_height)]
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
        floor.data.materials.append(material("Set / warm gray background", (0.26, 0.28, 0.26, 1), 0.72))
    # Scale illumination with the product, keeping intensity stable for metre units.
    size = max(source["product"]["dimensionsM"])
    scale = size / 0.12
    position = blender_position(sampled_product_origin(source, first_sample))
    target = Vector(position) + Vector((0, 0, size * 0.52))
    for name, offset, power, diameter, color in (
        ("Studio / large soft key", (-0.19, -0.24, 0.32), 2.6, 0.23, (1.0, 0.93, 0.82)),
        ("Studio / cool fill", (0.22, -0.07, 0.19), 0.8, 0.20, (0.82, 0.91, 1.0)),
        ("Studio / edge strip", (0.06, 0.19, 0.30), 3.4, 0.16, (1.0, 0.98, 0.90)),
    ):
        area_light(name, Vector(position) + Vector(offset) * scale, target, power * scale * scale, diameter * scale, color)
    return props


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


def product_mesh(component, samples_root):
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
    imported, excluded = imported_hierarchy(path, f"Product / {component['id']} / ")
    anchor = parent_imported_hierarchy(imported, component["id"])
    meshes = [obj for obj in imported if obj.type == "MESH"]
    override = component.get("materialOverride", False)
    if override:
        surface = specified_material(component["id"] + " / surface", component["material"])
        for obj in meshes:
            obj.data.materials.clear()
            obj.data.materials.append(surface)
            for polygon in obj.data.polygons:
                polygon.material_index = 0
    # No sizeM scaling or recentering: input geometry has approved local metre
    # coordinates, and the external pose belongs only to this rigid anchor.
    anchor["asset_sha256"] = asset["sha256"]
    anchor["role"] = "Rigid product GLB component; centered local geometry in metres"
    anchor["material_source"] = "declared override" if override else "original GLB materials"
    return anchor, {"id": component["id"], "shape": "mesh", "asset": asset, "importedObjects": len(imported),
                    "meshObjects": len(meshes), "materialSource": "declared override" if override else "original GLB materials",
                    "excludedEmbeddedCamerasAndLights": excluded, "geometryPolicy": "Centered local metres; no rescaling or recentering"}


def plate_compositor(source, frames, requested, samples_root, output_root, scene):
    """Composite the captured Gaussian world behind transparent Cycles geometry."""
    required = requested or [frames[0]["frame"]]
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
    first_frame = frames[0]["frame"]
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


def animate(source, frames, objects, props=None):
    props = props or {}
    source_props = {prop["id"]: prop for prop in source["environment"].get("props", [])}
    sampled_objects = [("product", identity, obj) for identity, obj in objects.items()]
    sampled_objects.extend(("prop", identity, obj) for identity, obj in props.items())
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
    camera.rotation_mode = "QUATERNION"
    for sample in frames:
        frame = sample["frame"]
        for role, identity, obj in sampled_objects:
            transform = (sample["components"][identity] if role == "product"
                         else sample.get("props", {}).get(identity, source_props[identity]))
            obj.location = blender_position(transform["translationM"])
            rotation = blender_rotation(transform["rotationXyzw"])
            # Quaternion sign is arbitrary; keep neighbouring samples continuous.
            key = (role, identity)
            if key in previous_rotations and rotation.dot(previous_rotations[key]) < 0:
                rotation.negate()
            previous_rotations[key] = rotation.copy()
            obj.rotation_mode = "QUATERNION"
            obj.rotation_quaternion = rotation
            obj.keyframe_insert(data_path="location", frame=frame, group="Sampled world transform")
            obj.keyframe_insert(data_path="rotation_quaternion", frame=frame, group="Sampled world transform")
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
        camera.keyframe_insert(data_path="location", frame=frame, group="Sampled camera")
        camera.keyframe_insert(data_path="rotation_quaternion", frame=frame, group="Sampled camera")
        camera_data.keyframe_insert(data_path="lens", frame=frame)
    for item in [*objects.values(), *props.values(), camera, camera_data]:
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
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = configure_scene(source, args.width, args.height, args.samples_per_pixel)
    objects = {}
    product_components = []
    for component in source["product"]["components"]:
        if component["shape"] == "mesh":
            obj, details = product_mesh(component, args.samples.parent)
        else:
            surface = specified_material(component["id"] + " / surface", component["material"])
            obj = primitive(component["id"], component["shape"], component["sizeM"], surface, component.get("bevelM", 0))
            details = {"id": component["id"], "shape": component["shape"], "materialSource": "declared"}
        objects[component["id"]] = obj
        product_components.append(details)
    label = source["product"].get("label")
    if label:
        component = next(item for item in source["product"]["components"] if item["id"] == label["componentId"])
        text_on_label(objects[label["componentId"]], label, component["sizeM"])
    props = environment(source, frames[0])
    animate(source, frames, objects, props)
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
            world_details = plate_compositor(source, frames, args.frames, args.samples.parent, args.output, scene)
            limitations.extend([
                "Gaussian world is a camera-matched color plate, not native Cycles splat geometry or shading.",
                "No splat depth: the distant plate cannot occlude product or near-field geometry.",
                "No world-plate glass transmission, refraction, reflection, indirect illumination or shadow equivalence; Cycles sees only explicit near-field geometry and the declared world color.",
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
    scene["source_scene_id"] = source["sceneId"]
    scene["coordinate_conversion"] = "Canonical metres Y-up (x,y,z) -> Blender metres Z-up (x,-z,y)"
    scene["camera_gate"] = "36 mm vertical sensor; sampled position, target, focal length"
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
        "typography": {"font": "Bfont Regular", "source": "Blender 4.3.2 builtin"},
        "productComponents": product_components,
        "renderingPath": {"authored": "authored-cycles", "mesh": "visual-glb-cycles", "splat": "gaussian-plate-cycles-foreground"}[kind],
        "limitations": limitations,
        "environment": {"kind": kind, "revisionId": source["environment"]["revisionId"], "asset": source["environment"].get("asset"), "provenance": source["environment"]["provenance"], "fixture": source["environment"].get("fixture", False), "reviewStatus": source["environment"].get("reviewStatus"), "details": world_details},
        "nearField": {"plinth": source["environment"]["plinth"], "props": source["environment"].get("props", []),
                      "resolvedFirstFrame": {"productOriginM": sampled_product_origin(source, frames[0]),
                                             "floorY": authored_floor_height(source),
                                             "visiblePlinth": source["environment"]["plinth"].get("visible", True),
                                             "props": {prop["id"]: frames[0].get("props", {}).get(prop["id"], prop)
                                                       for prop in source["environment"].get("props", []) if prop["id"] in props}}},
        "coordinateConversion": {"from": "right-handed Y-up metres", "to": "right-handed Z-up metres", "position": "(x,-z,y)"},
        "lighting": [
            {"name": obj.name, "positionM": list(obj.location), "powerW": obj.data.energy, "diameterM": obj.data.size, "color": list(obj.data.color)}
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
