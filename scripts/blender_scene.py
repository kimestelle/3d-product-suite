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
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Quaternion, Vector


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


def material(name, color, roughness=0.45, metallic=0.0):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = tuple(color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return result


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


def environment(source):
    plinth = source["environment"]["plinth"]
    porcelain = material("Set / warm matte porcelain", (0.56, 0.54, 0.49, 1), 0.58)
    obj = primitive(plinth["id"], "box", plinth["sizeM"], porcelain, 0.004)
    obj.location = blender_position(plinth["translationM"])
    # A curved studio sweep supplies contact shadows and hides the horizon even
    # when a portrait camera sees slightly above the physical floor plane.
    floor_height = plinth["translationM"][1] - plinth["sizeM"][1] / 2
    radius = max(source["product"]["dimensionsM"]) * 3
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
    floor.data.materials.append(material("Set / warm gray background", (0.26, 0.28, 0.26, 1), 0.72))
    # Scale illumination with the product, keeping intensity stable for metre units.
    size = max(source["product"]["dimensionsM"])
    scale = size / 0.12
    position = blender_position(source["placement"]["translationM"])
    target = Vector(position) + Vector((0, 0, size * 0.52))
    for name, offset, power, diameter, color in (
        ("Studio / large soft key", (-0.19, -0.24, 0.32), 2.6, 0.23, (1.0, 0.93, 0.82)),
        ("Studio / cool fill", (0.22, -0.07, 0.19), 0.8, 0.20, (0.82, 0.91, 1.0)),
        ("Studio / edge strip", (0.06, 0.19, 0.30), 3.4, 0.16, (1.0, 0.98, 0.90)),
    ):
        area_light(name, Vector(position) + Vector(offset) * scale, target, power * scale * scale, diameter * scale, color)


def animate(source, frames, objects):
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
        for component_id, obj in objects.items():
            transform = sample["components"][component_id]
            obj.location = blender_position(transform["translationM"])
            rotation = blender_rotation(transform["rotationXyzw"])
            # Quaternion sign is arbitrary; keep neighbouring samples continuous.
            if component_id in previous_rotations and rotation.dot(previous_rotations[component_id]) < 0:
                rotation.negate()
            previous_rotations[component_id] = rotation.copy()
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
    for item in [*objects.values(), camera, camera_data]:
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
    for component in source["product"]["components"]:
        specification = component["material"]
        surface = material(component["id"] + " / surface", specification["baseColor"], specification["roughness"], specification["metallic"])
        obj = primitive(component["id"], component["shape"], component["sizeM"], surface, component.get("bevelM", 0))
        objects[component["id"]] = obj
    label = source["product"].get("label")
    if label:
        component = next(item for item in source["product"]["components"] if item["id"] == label["componentId"])
        text_on_label(objects[label["componentId"]], label, component["sizeM"])
    environment(source)
    animate(source, frames, objects)
    scene["source_scene_id"] = source["sceneId"]
    scene["coordinate_conversion"] = "Canonical metres Y-up (x,y,z) -> Blender metres Z-up (x,-z,y)"
    scene["camera_gate"] = "36 mm vertical sensor; sampled position, target, focal length"
    scene["interpolation"] = "CONSTANT: all integer frame poses are sampled and keyed"
    render_config = {
        "adapterVersion": 1,
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
