"""Blender-side static product importer; invoked only by film.blend_import."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blend_material_mix import normalize_mix_surface
import blend_material_bake as material_baker
from blend_material_bake import STATIC_NODES, bake_material_inputs, material_needs_bake
from blend_scene_filter import select_product_objects

SOURCE_UNIT_SCALES = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def curve_self_entry(instance):
    """Blender may expose an old curve path as its own dependency-graph instance.

    Its evaluated geometry is already handled by the normal snapshot pass; this
    is not a collection/Geometry Nodes instance that needs realization.
    """
    if not instance.object or not instance.parent or not instance.instance_object:
        return False
    obj = instance.object.original
    return (obj.type == "CURVE" and obj.instance_type == "NONE"
            and not any(modifier.type == "NODES" for modifier in obj.modifiers)
            and instance.parent.original == obj and instance.instance_object.original == obj
            and all(abs(instance.matrix_world[row][column] - instance.object.matrix_world[row][column]) < 1e-7
                    for row in range(4) for column in range(4)))


def source_socket(socket):
    """Follow reroutes without mistaking them for a different shader/value."""
    seen = set()
    while socket.is_linked:
        socket = socket.links[0].from_socket
        if socket.node.type != "REROUTE":
            return socket
        pointer = socket.node.as_pointer()
        require(pointer not in seen, "Material contains a cyclic reroute; reconnect its shader inputs before importing")
        seen.add(pointer)
        socket = socket.node.inputs[0]
    return socket


def glass_shader(material, glass):
    """Build a glTF-compatible optical approximation in the in-memory copy."""
    tree = material.node_tree
    # The exporter silently ignores linked IOR, even a Value node.
    ior_input = glass.inputs["IOR"]
    ior_source = source_socket(ior_input)
    require(not ior_input.is_linked or ior_source.node.type == "VALUE",
            f'Material “{material.name}” uses a varying glass IOR. glTF supports one IOR value; set a numeric IOR or connect a Value node before importing.')
    ior = float(ior_source.default_value)
    require(math.isfinite(ior) and ior >= 1,
            f'Material “{material.name}” needs a glass IOR of at least 1 for glTF import.')
    normal_input = glass.inputs["Normal"]
    if normal_input.is_linked:
        normal = source_socket(normal_input).node
        require(normal.type == "NORMAL_MAP" and normal.space == "TANGENT",
                f'Material “{material.name}” needs a tangent-space Normal Map node for glass normals. Bake other normal inputs to a normal texture before importing.')
        strength = normal.inputs["Strength"]
        if strength.is_linked:
            value = source_socket(strength)
            require(value.node.type == "VALUE" and math.isfinite(value.default_value),
                    f'Material “{material.name}” uses varying normal-map strength. Bake the strength into the normal texture and use a numeric Strength before importing.')
            frozen_strength = float(value.default_value)
            for link in list(strength.links):
                tree.links.remove(link)
            strength.default_value = frozen_strength
    shader = tree.nodes.new("ShaderNodeBsdfPrincipled")
    shader.label = "Imported Glass BSDF"
    shader.inputs["Metallic"].default_value = 0
    shader.inputs["Transmission Weight"].default_value = 1
    shader.inputs["Alpha"].default_value = 1
    shader.inputs["IOR"].default_value = ior
    for original, destination in (("Color", "Base Color"), ("Roughness", "Roughness"), ("Normal", "Normal")):
        old, new = glass.inputs[original], shader.inputs[destination]
        if old.is_linked:
            tree.links.new(old.links[0].from_socket, new)
        else:
            new.default_value = old.default_value
    return shader


def normalize_glass_surface(material):
    if not material.use_nodes or material.node_tree is None:
        return False
    tree, converted = material.node_tree, {}
    for output in list(tree.nodes):
        if output.type != "OUTPUT_MATERIAL" or not output.is_active_output:
            continue
        surface = output.inputs["Surface"]
        if surface.is_linked:
            glass = source_socket(surface).node
            if glass.type == "BSDF_GLASS":
                shader = converted.setdefault(glass.as_pointer(), None)
                if shader is None:
                    shader = converted[glass.as_pointer()] = glass_shader(material, glass)
                tree.links.new(shader.outputs["BSDF"], surface)
    return bool(converted)


def material_resources(material, *, for_bake=False):
    """Inspect only nodes contributing to the active material output."""
    require(not material.library,
            f'Material “{material.name}” is linked from another file. Make the product materials local, pack resources, and save before importing.')
    if not material.use_nodes or material.node_tree is None:
        return
    outputs = [node for node in material.node_tree.nodes
               if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
    seen = set()
    # These are the standard image-driven Principled inputs supported by the
    # glTF material exporter. Procedural shading must be baked explicitly.
    allowed = {"OUTPUT_MATERIAL", "BSDF_PRINCIPLED", "EMISSION", "TEX_IMAGE", "UVMAP", "TEX_COORD",
               "MAPPING", "NORMAL_MAP", "SEPRGB", "SEPARATE_COLOR", "RGB", "VALUE", "REROUTE"}
    if for_bake:
        # Resource validation and the baker must agree about static graphs.
        # Keeping a second list made ordinary color/math nodes fail before
        # their supported parameter maps could be baked.
        allowed |= STATIC_NODES

    def visit(node):
        if node.as_pointer() in seen:
            return
        seen.add(node.as_pointer())
        require(len(seen) <= 4096, f'Material “{material.name}” exceeds the 4096-node import budget; simplify its graph before importing.')
        require(node.type in allowed,
                f'Material “{material.name}” uses {node.name}, which cannot be preserved as a static product material. Bake its appearance to image textures and connect them to a Principled BSDF before importing.')
        if node.type == "BSDF_PRINCIPLED" and for_bake:
            # Both supported exporters ignore linked IOR, even a Value node.
            # Preserve a saved-frame constant; reject spatial refraction rather
            # than silently replacing it with glTF's default IOR of 1.5.
            socket = node.inputs["IOR"]
            value = source_socket(socket)
            require(not socket.is_linked or value.node.type == "VALUE",
                    f'Material “{material.name}” uses a varying IOR. glTF supports one IOR value; set a numeric IOR or connect a Value node before importing.')
            ior = float(value.default_value)
            require(math.isfinite(ior) and ior >= 1,
                    f'Material “{material.name}” needs an IOR of at least 1 for glTF import.')
            for link in list(socket.links):
                material.node_tree.links.remove(link)
            socket.default_value = ior
        if node.type == "OUTPUT_MATERIAL":
            require(not node.inputs["Volume"].is_linked and not node.inputs["Displacement"].is_linked,
                    f'Material “{material.name}” has volume or shader displacement. Convert displacement to mesh geometry and bake volume appearance before importing.')
        if node.type == "TEX_COORD":
            coordinates = {"UV", "Generated", "Object", "Normal"} if for_bake else {"UV"}
            require(all(not socket.is_linked or socket.name in coordinates for socket in node.outputs),
                    f'Material “{material.name}” uses generated or object-space texture coordinates. Bake them to UV image textures before importing.')
        if node.type == "NEW_GEOMETRY":
            require(all(not socket.is_linked or socket.name in {"Position", "Normal", "True Normal", "Tangent", "Pointiness"}
                        for socket in node.outputs), f'Material “{material.name}” depends on the viewing ray and cannot be stored in fixed product maps.')
        if node.type == "NORMAL_MAP":
            require(for_bake or node.space == "TANGENT", f'Material “{material.name}” needs a tangent-space normal map for product import. Bake its normals before importing.')
        if node.type == "TEX_IMAGE":
            image = node.image
            require(image is not None, f'Material “{material.name}” has an empty image node. Assign its texture, then use File → External Data → Pack Resources and save the .blend file.')
            require(not image.library, f'Texture “{image.name}” is linked from another file. Make the product textures local, pack resources, and save before importing.')
            require(image.source in {"FILE", "GENERATED"},
                    f'Texture “{image.name}” uses tiles, video, or an image sequence. Bake it to a single image texture, pack resources, and save before importing.')
            packed = bool(image.packed_file or len(image.packed_files))
            require(packed or image.source == "GENERATED",
                    f'Texture “{image.name}” is external or missing. In Blender use File → External Data → Pack Resources, resolve any missing files, and save the .blend file before importing.')
            # Packed image pixels are loaded lazily after open_mainfile; a
            # false has_data flag alone does not mean its packed bytes are gone.
            width, height = image.size
            require(width * height <= 64 * 1024 * 1024,
                    f'Texture “{image.name}” exceeds the import pixel budget; reduce its resolution to 8192 × 8192 or smaller.')
            if not image.has_data and width > 0 and height > 0:
                try:
                    image.pixels[0]
                except (IndexError, RuntimeError):
                    pass
            require(image.has_data, f'Texture “{image.name}” has no image data. Resolve the missing texture, pack resources, and save the .blend file.')
        for socket in node.inputs:
            for link in socket.links:
                visit(link.from_node)

    for output in outputs:
        visit(output)


def convert(source, output, *, source_units=None):
    require(source_units is None or source_units in SOURCE_UNIT_SCALES,
            "Blender units override must be mm, cm, m, in, or ft")
    require((4, 3) <= bpy.app.version[:2] <= (5, 1),
            "Blender product import supports Blender 4.3 through 5.1. Configure the import executable to use a supported version, then try again.")
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    try:
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    except Exception as error:
        raise ValueError("Blender could not open this .blend file. Open and save it in the configured Blender version, then try again.") from error
    source_version = tuple(bpy.data.version)
    require(source_version[:2] <= bpy.app.version[:2],
            f'This file was saved in Blender {source_version[0]}.{source_version[1]}; the import executable is {bpy.app.version_string}. Use the same or a newer supported Blender version so newer scene data is not lost.')
    scene = bpy.context.scene
    scene_name, frame = scene.name, scene.frame_current
    view_layer_name = bpy.context.view_layer.name
    unit_system = scene.unit_settings.system
    original_scale = scene.unit_settings.scale_length if unit_system != "NONE" else 1.0
    scale = SOURCE_UNIT_SCALES[source_units] if source_units is not None else original_scale
    require(math.isfinite(scale) and scale > 0, "Blender scene unit scale must be positive and finite")
    warnings = []
    converted_materials = set()
    mixed_materials = set()
    baked_materials = []
    material_states = {}

    def material_repair(error):
        message = str(error).lower()
        if message.startswith('material “') and '”' in message:
            message = message.split('”', 1)[1]
        if " ior" in " " + message or "spatially varying refraction" in message:
            return "Use one numeric IOR for the material and matching IOR values in mixed surfaces, save, and reimport."
        if "no source uv" in message:
            return "Assign the image texture's original UV map in Blender, pack the images, save, and reimport."
        if "linked from another file" in message:
            return "Make the material and its textures local in Blender, use File → External Data → Pack Resources, save, and reimport."
        if any(text in message for text in ("empty image", "external or missing", "no image data")):
            return "Locate or assign the missing texture in Blender, use File → External Data → Pack Resources, save, and reimport."
        if "tiles, video, or an image sequence" in message:
            return "Bake the desired frame to a single image texture in Blender, pack it, save, and reimport."
        if "import pixel budget" in message:
            return "Reduce the texture to 8192 × 8192 or smaller in Blender, pack the reduced image, save, and reimport."
        if "normal" in message:
            return "Bake the normal input to a tangent-space normal texture in Blender, use a Normal Map node with numeric strength, pack the image, save, and reimport."
        if "volume or shader displacement" in message:
            return "Apply displacement to mesh geometry and replace volume shading with a surface material in Blender, then save and reimport."
        if "budget" in message or "eight uv" in message:
            return "Simplify the material graph or bake fewer, smaller maps in Blender, remove unused UV layers, pack the images, save, and reimport."
        return "Bake the appearance to image textures in Blender, connect them to a Principled BSDF, pack the images, save, and reimport."

    def material_state(material, object_name):
        key = material.as_pointer()
        if key not in material_states:
            material_states[key] = {"name": material.name, "source": material,
                                    "prepared": False, "fallback": None, "objects": set()}
        state = material_states[key]
        state["objects"].add(object_name)
        return state

    def fallback_material(state, error):
        if state["fallback"] is not None:
            return state["fallback"]
        name, source = state["name"], state["source"]
        # This process only edits its loaded copy. Keep a separate, named
        # surface so replacing one unsupported material cannot merge its slots
        # into a different material or alter the source .blend on disk.
        if not source.library:
            source.name = name + " / source"
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
        shader.inputs["Metallic"].default_value = 0
        shader.inputs["Roughness"].default_value = 0.6
        shader.inputs["Alpha"].default_value = 1
        shader.inputs["Transmission Weight"].default_value = 0
        material.diffuse_color = (0.5, 0.5, 0.5, 1)
        reason = str(error).strip().split(". ", 1)[0].rstrip(".")
        if reason.startswith('Material “') and '”' in reason:
            reason = reason.split('”', 1)[1].lstrip(': ')
        # Older validation messages include preparation instructions after a
        # semicolon. They are not a prerequisite now that import can continue.
        reason = reason.split(";", 1)[0].strip()
        state.update(fallback=material, reason=(reason or "The material could not be converted")[:500],
                     fix=material_repair(error))
        converted_materials.discard(name)
        mixed_materials.discard(name)
        return material

    def prepare_material(state):
        if state["fallback"] is not None:
            return state["fallback"]
        material = state["source"]
        if state["prepared"]:
            return material
        try:
            require(not material.library,
                    f'Material “{material.name}” is linked from another file. Make the product materials local, pack resources, and save before importing.')
            mixed = normalize_mix_surface(material, glass_shader, source_socket)
            glass = normalize_glass_surface(material)
            material_resources(material, for_bake=True)
            # Freeze saved-frame values before switching to a temporary bake scene.
            material.animation_data_clear()
            if material.node_tree:
                material.node_tree.animation_data_clear()
            material_needs_bake(material)
        except (ValueError, RuntimeError) as error:
            return fallback_material(state, error)
        state["prepared"] = True
        if mixed:
            mixed_materials.add(state["name"])
        if glass:
            converted_materials.add(state["name"])
        return material

    if source_units is not None:
        warnings.append(f'Units overridden to {source_units}: 1 Blender unit = {scale:g} metres. The source file is unchanged.')
    elif unit_system == "NONE":
        warnings.append("Scene units are unset; imported with 1 Blender unit = 1 metre. Set Scene Properties → Units if this is not the intended size.")
    # Excluded collections are absent from the active view layer. Render-hidden
    # objects are intentionally omitted, rather than becoming surprise parts.
    renderable = set()

    def visible_collections(layer):
        if layer.exclude or layer.collection.hide_render:
            return
        renderable.update(obj.name for obj in layer.collection.objects)
        for child in layer.children:
            visible_collections(child)

    visible_collections(bpy.context.view_layer.layer_collection)
    objects = [obj for obj in bpy.context.view_layer.objects if not obj.hide_render and obj.name in renderable]
    require(len(objects) <= 10000, "Blender product exceeds 10,000 objects; simplify the active scene before importing")
    bpy.context.view_layer.update()
    objects, excluded = select_product_objects(objects, bpy.context.evaluated_depsgraph_get())
    kept_names = {obj.name for obj in objects}
    excluded_names = {record["object"] for record in excluded}

    def product_parent(obj):
        parent = obj.parent
        while parent and parent.name in excluded_names:
            parent = parent.parent
        return parent

    for obj in objects:
        require(not obj.library and not getattr(obj.data, "library", None),
                f'Object “{obj.name}” is linked from another file. Make the product objects and mesh data local, pack resources, and save before importing.')
        require(not obj.instance_collection and obj.instance_type == "NONE",
                f'Object “{obj.name}” uses instances. Use Object → Apply → Make Instances Real, then save before importing.')
        require(not obj.particle_systems,
                f'Object “{obj.name}” uses particles. Convert the visible result to meshes before importing.')
        require(obj.type not in {"VOLUME", "POINTCLOUD", "GREASEPENCIL", "GPENCIL"},
                f'Object “{obj.name}” is not a supported product mesh. Convert its visible result to a mesh before importing.')
        if obj.type == "FONT":
            for attribute in ("font", "font_bold", "font_italic", "font_bold_italic"):
                font = getattr(obj.data, attribute, None)
                require(font is None or font.filepath == "<builtin>" or font.packed_file,
                        f'Text object “{obj.name}” uses an external font. Pack its font resources or convert the text to a mesh, then save before importing.')
        for modifier in obj.modifiers:
            if modifier.show_viewport:
                require(modifier.type not in {"FLUID", "MESH_SEQUENCE_CACHE", "MESH_CACHE", "CLOTH", "SOFT_BODY"},
                        f'Object “{obj.name}” depends on simulation or external cache data. Convert its saved-frame result to a mesh, then save before importing.')
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    require(not any(instance.is_instance and not curve_self_entry(instance)
                    and (instance.parent.original.name if instance.parent else instance.object.original.name) in kept_names
                    for instance in depsgraph.object_instances),
            "The Blender product contains generated instances. Realize instances in Geometry Nodes or use Make Instances Real, then save before importing.")
    snapshots, ancestors = {}, {}
    bake_scene = None
    minimum, maximum = Vector((math.inf,) * 3), Vector((-math.inf,) * 3)
    vertex_count = 0
    for obj in objects:
        if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT", "META"}:
            continue
        # A bake temporarily changes the active scene and invalidates evaluated
        # datablocks. Reacquire this object's graph and cache its transform.
        depsgraph = bpy.context.evaluated_depsgraph_get()
        evaluated = obj.evaluated_get(depsgraph)
        world_matrix = evaluated.matrix_world.copy()
        mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        if mesh is None or not mesh.polygons:
            if mesh is not None:
                bpy.data.meshes.remove(mesh)
            continue
        vertex_count += len(mesh.vertices)
        require(vertex_count <= 10000000, "Blender product exceeds 10 million evaluated vertices; simplify its modifiers or geometry")
        # Object-linked material slots override mesh datablock materials.
        for index, slot in enumerate(evaluated.material_slots):
            # Evaluated material IDs belong to the dependency graph. Retain
            # original datablocks before any temporary scene switch.
            material = slot.material.original if slot.material else None
            if index < len(mesh.materials):
                mesh.materials[index] = material
            else:
                mesh.materials.append(material)
        # Abandoned material slots do not contribute to the visible product.
        # Remove them before validation, preserving evaluated face assignments.
        polygon_materials = [polygon.material_index for polygon in mesh.polygons]
        used_slots = sorted(set(polygon_materials) & set(range(len(mesh.materials))))
        materials = [mesh.materials[index] for index in used_slots]
        slot_map = {old: new for new, old in enumerate(used_slots)}
        mesh.materials.clear()
        for material in materials:
            mesh.materials.append(material)
        for polygon, old in zip(mesh.polygons, polygon_materials):
            polygon.material_index = slot_map.get(old, 0)
        states = [material_state(material, obj.name) if material else None for material in mesh.materials]
        for index, state in enumerate(states):
            if state:
                mesh.materials[index] = prepare_material(state)
        # Bake one source material at a time. A trial mesh keeps UV changes,
        # material copies and partially baked maps out of the accepted snapshot
        # if that material fails. Other surfaces retain their supported maps.
        bake_states = {state["source"].as_pointer(): state for state in states
                       if state and state["fallback"] is None and material_needs_bake(state["source"])}
        bake_queue = list(bake_states.values())
        while bake_queue:
            state = bake_queue.pop(0)
            if state["fallback"] is not None:
                continue
            if bake_scene is None:
                bake_scene = bpy.data.scenes.new("gesso material maps")
                bake_scene.frame_current = frame
            trial_mesh = mesh.copy()
            bake_object = bpy.data.objects.new(obj.name + " material maps", trial_mesh)
            bake_object.matrix_world = world_matrix
            bake_scene.collection.objects.link(bake_object)
            before_images = {image.as_pointer() for image in bpy.data.images}
            before_materials = {material.as_pointer() for material in bpy.data.materials}
            before_budget = material_baker._budget.copy()
            failed = False
            try:
                bpy.context.window.scene = bake_scene
                bpy.context.view_layer.update()
                index = next(index for index, source_state in enumerate(states) if source_state is state)
                try:
                    record = bake_material_inputs(bake_object, materials=[trial_mesh.materials[index]])
                except (ValueError, RuntimeError) as error:
                    # Preparing a shared bake atlas also checks neighboring image
                    # materials. Attribute their missing-UV error to that material,
                    # then retry the selected surface with the neighbor replaced.
                    failed_state = state
                    message = str(error)
                    if message.startswith('Material “') and '”' in message:
                        failed_name = message.split('“', 1)[1].split('”', 1)[0]
                        for slot, candidate in enumerate(trial_mesh.materials):
                            if candidate and candidate.name == failed_name and states[slot] and states[slot]["fallback"] is None:
                                failed_state = states[slot]
                                break
                    fallback_material(failed_state, error)
                    failed = True
            finally:
                bpy.context.window.scene = scene
                bpy.data.objects.remove(bake_object, do_unlink=True)
            if failed:
                bpy.data.meshes.remove(trial_mesh)
                for material in list(bpy.data.materials):
                    if material.as_pointer() not in before_materials and not material.users and material != failed_state["fallback"]:
                        bpy.data.materials.remove(material)
                for image in list(bpy.data.images):
                    if image.as_pointer() not in before_images and not image.users:
                        bpy.data.images.remove(image)
                # Failed maps were discarded with the trial. They must not
                # consume the retained-image allowance of later materials.
                material_baker._budget.update(before_budget)
            else:
                bpy.data.meshes.remove(mesh)
                mesh = trial_mesh
                # Selected baking can copy a material which was already copied
                # for an earlier channel. Report its original identity.
                for entry in record["materials"]:
                    entry["sourceMaterial"] = state["name"]
                if record["materials"]:
                    baked_materials.append(record)
            for index, source_state in enumerate(states):
                if source_state and source_state["fallback"] is not None:
                    mesh.materials[index] = source_state["fallback"]
            if failed and state["fallback"] is None:
                bake_queue.insert(0, state)
        for index, material in enumerate(mesh.materials):
            if material and states[index]["fallback"] is None:
                # Remove disconnected source graphs so dead coordinate links
                # cannot affect the exporter's traversal of baked UV maps.
                if material.use_nodes and material.node_tree:
                    keep, pending = set(), [node for node in material.node_tree.nodes
                                            if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
                    while pending:
                        node = pending.pop()
                        if node.as_pointer() in keep:
                            continue
                        keep.add(node.as_pointer())
                        pending.extend(link.from_node for socket in node.inputs for link in socket.links)
                    for node in list(material.node_tree.nodes):
                        if node.as_pointer() not in keep:
                            material.node_tree.nodes.remove(node)
                try:
                    material_resources(material)
                except (ValueError, RuntimeError) as error:
                    mesh.materials[index] = fallback_material(states[index], error)
        # Bake evaluated transforms (including parent scale, constraints and
        # posed armatures) into static mesh vertices. Hierarchy remains intact
        # without glTF TRS decomposition losing a source shear transform.
        mesh.transform(world_matrix)
        if world_matrix.determinant() < 0:
            mesh.flip_normals()
        used_vertices = bytearray(len(mesh.vertices))
        for polygon in mesh.polygons:
            for vertex_index in polygon.vertices:
                used_vertices[vertex_index] = 1
        for vertex in mesh.vertices:
            if not used_vertices[vertex.index]:
                continue
            for axis in range(3):
                value = vertex.co[axis] * scale
                require(math.isfinite(value), "Blender product contains nonfinite geometry")
                minimum[axis], maximum[axis] = min(minimum[axis], value), max(maximum[axis], value)
        parent = product_parent(obj)
        snapshots[obj.name] = {"mesh": mesh, "parent": parent.name if parent else None, "materialStates": states}
        depth = 0
        while parent:
            depth += 1
            require(depth <= 80, "Blender product hierarchy exceeds 80 levels; simplify its parenting")
            next_parent = product_parent(parent)
            ancestors[parent.name] = next_parent.name if next_parent else None
            parent = next_parent
    require(snapshots, "The saved active Blender scene has no visible mesh geometry. Add or unhide the product, select its scene, save, and try again.")
    dimensions = maximum - minimum
    require(all(1e-8 < value <= 1000 for value in dimensions),
            "Blender product must have nonzero three-dimensional size no larger than 1000 metres. Check Scene Properties → Units.")
    center = (minimum + maximum) * 0.5
    normalize = Matrix.Translation(-center) @ Matrix.Scale(scale, 4)
    for record in snapshots.values():
        # A later object may expose a source material's unsupported bake path.
        # Keep all uses of that source material consistent, including snapshots
        # that were completed before the failure became known.
        for index, state in enumerate(record["materialStates"]):
            if state and state["fallback"] is not None:
                record["mesh"].materials[index] = state["fallback"]
        record["mesh"].transform(normalize)
        record["mesh"].update()
        for material in record["mesh"].materials:
            if material:
                material.animation_data_clear()
                if material.node_tree:
                    material.node_tree.animation_data_clear()
    # New scene, no cameras, lights, animations, skins, or simulation runtime.
    # Source bytes are never saved or modified by this process.
    exported_scene = bpy.data.scenes.new("gesso product")
    exported_scene.frame_current = frame
    bpy.context.window.scene = exported_scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    records = {name: {"mesh": None, "parent": parent} for name, parent in ancestors.items()}
    records.update(snapshots)
    exported_objects = {}
    for name, record in records.items():
        obj = bpy.data.objects.new(name, record["mesh"])
        exported_scene.collection.objects.link(obj)
        exported_objects[name] = obj
    for name, record in records.items():
        if record["parent"] in exported_objects:
            exported_objects[name].parent = exported_objects[record["parent"]]
    bpy.context.view_layer.update()
    result = bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_active_scene=True,
        export_yup=True, export_animations=False, export_current_frame=True, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False,
        export_gpu_instances=False, export_draco_mesh_compression_enable=False,
        export_materials="EXPORT", export_image_format="AUTO", export_apply=False,
    )
    require("FINISHED" in result and output.is_file(), "Blender could not export the static product. Check its materials and mesh geometry.")
    material_fallbacks = [{"name": state["name"], "reason": state["reason"], "fix": state["fix"],
                           "objects": sorted(state["objects"])[:8], "objectCount": len(state["objects"]),
                           "objectsTruncated": len(state["objects"]) > 8}
                          for state in material_states.values() if state["fallback"] is not None]
    material_fallbacks.sort(key=lambda record: record["name"])
    fallback_names = {record["name"] for record in material_fallbacks}
    retained_bakes = []
    for record in baked_materials:
        entries = [entry for entry in record["materials"] if entry["sourceMaterial"] not in fallback_names]
        if entries:
            retained_bakes.append({**record, "materials": entries,
                                   "imageCount": sum(len(entry["channels"]) for entry in entries)})
    baked_materials = retained_bakes
    if material_fallbacks:
        names = ", ".join(record["name"] for record in material_fallbacks[:8])
        if len(material_fallbacks) > 8:
            names += f' and {len(material_fallbacks) - 8} more'
        noun = "material" if len(material_fallbacks) == 1 else "materials"
        repair = (f'To keep the original finish: {material_fallbacks[0]["fix"]}' if len(material_fallbacks) == 1 else
                  'To keep the original finishes, see Import notes for repair steps.')
        warnings.append(f'Imported without {len(material_fallbacks)} {noun}: {names}. A neutral surface was used; assign a replacement in Material. {repair}')
    for name in sorted(converted_materials):
        warnings.append(f'Material “{name}”: converted Glass BSDF to glTF transmission, preserving color, roughness, IOR and supported normal maps. Refraction may differ from Blender.')
    for name in sorted(mixed_materials):
        warnings.append(f'Material “{name}”: converted masked shader branches into editable surface maps. Both regions are retained; blended reflectance is a glTF approximation.')
    if baked_materials:
        warnings.append(f'Baked {sum(record["imageCount"] for record in baked_materials)} material maps at 1024 px, preserving surface patterns without scene lighting.')
    if excluded:
        names = ", ".join(record["object"] for record in excluded[:8])
        suffix = f' and {len(excluded) - 8} more' if len(excluded) > 8 else ""
        warnings.append(f'Left out {len(excluded)} scene objects: {names}{suffix}. Product dimensions exclude these objects. To change this, set the Blender custom property gesso_role to product or environment on an object or collection.')
    return {"sourceFormat": "blend", "sourceScene": scene_name, "sourceViewLayer": view_layer_name, "sourceFrame": frame,
            "blenderVersion": bpy.app.version_string, "sourceBlenderVersion": ".".join(map(str, source_version)), "sourceUnitSystem": unit_system,
            "sourceUnitScaleToMeters": original_scale, "sourceUnitsOverride": source_units,
            "sourceScaleToMeters": scale, "objectCount": len(records), "meshCount": len(snapshots),
            "transformsBaked": True, "warnings": warnings,
            "materialFallbacks": material_fallbacks[:200], "materialFallbackCount": len(material_fallbacks),
            "materialFallbacksTruncated": len(material_fallbacks) > 200,
            "materialConversions": [{"material": name, "from": "Glass BSDF", "to": "Principled transmission"}
                                    for name in sorted(converted_materials)] +
                                   [{"material": name, "from": "Mix Shader", "to": "Principled parameter maps"}
                                    for name in sorted(mixed_materials)],
            "materialBakes": baked_materials,
            "excludedObjectCount": len(excluded), "excludedObjects": excluded[:200],
            "excludedObjectsTruncated": len(excluded) > 200}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--source-units", choices=tuple(SOURCE_UNIT_SCALES))
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    report = Path(args.report)
    try:
        result = convert(Path(args.input), Path(args.output), source_units=args.source_units)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else "Blender could not convert this saved frame. Convert unsupported geometry to meshes, bake materials to image textures, pack resources, and save before importing."
        report.write_text(json.dumps({"error": message[:1600]}), encoding="utf-8")
        raise
    report.write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
