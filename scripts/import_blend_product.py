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
from blend_material_bake import bake_material_inputs, material_needs_bake
from blend_scene_filter import select_product_objects


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
        allowed |= {"TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_GRADIENT", "TEX_MAGIC", "TEX_CHECKER",
                    "TEX_BRICK", "TEX_WHITE_NOISE", "VALTORGB", "MATH", "VECT_MATH", "MIX", "MIX_RGB",
                    "BUMP", "NEW_GEOMETRY", "VECTOR_ROTATE", "COMBRGB", "COMBINE_COLOR", "COMBXYZ", "SEPXYZ"}

    def visit(node):
        if node.as_pointer() in seen:
            return
        seen.add(node.as_pointer())
        require(node.type in allowed,
                f'Material “{material.name}” uses {node.name}, which cannot be preserved as a static product material. Bake its appearance to image textures and connect them to a Principled BSDF before importing.')
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


def convert(source, output):
    require(bpy.app.version == (4, 3, 2),
            "Blender product import requires Blender 4.3.2. Configure the server's --blender executable to use that version, then try again.")
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    try:
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    except Exception as error:
        raise ValueError("Blender could not open this .blend file. Open and save it in the configured Blender version, then try again.") from error
    scene = bpy.context.scene
    scene_name, frame = scene.name, scene.frame_current
    view_layer_name = bpy.context.view_layer.name
    unit_system = scene.unit_settings.system
    scale = scene.unit_settings.scale_length if unit_system != "NONE" else 1.0
    require(math.isfinite(scale) and scale > 0, "Blender scene unit scale must be positive and finite")
    warnings = []
    converted_materials = set()
    mixed_materials = set()
    baked_materials = []

    def prepare_material(material):
        require(not material.library,
                f'Material “{material.name}” is linked from another file. Make the product materials local, pack resources, and save before importing.')
        if normalize_mix_surface(material, glass_shader, source_socket):
            mixed_materials.add(material.name)
        if normalize_glass_surface(material):
            converted_materials.add(material.name)
        material_resources(material, for_bake=True)
        # Freeze saved-frame values before switching to a temporary bake scene.
        material.animation_data_clear()
        if material.node_tree:
            material.node_tree.animation_data_clear()

    if unit_system == "NONE":
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
        for slot in obj.material_slots:
            if slot.material:
                prepare_material(slot.material)
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
        for material in mesh.materials:
            if material:
                prepare_material(material)
        if any(material_needs_bake(material) for material in mesh.materials if material):
            if bake_scene is None:
                bake_scene = bpy.data.scenes.new("gesso material maps")
                bake_scene.frame_current = frame
            bake_object = bpy.data.objects.new(obj.name + " material maps", mesh)
            bake_object.matrix_world = world_matrix
            bake_scene.collection.objects.link(bake_object)
            try:
                bpy.context.window.scene = bake_scene
                bpy.context.view_layer.update()
                baked_materials.append(bake_material_inputs(bake_object))
            finally:
                bpy.context.window.scene = scene
                bpy.data.objects.remove(bake_object, do_unlink=True)
        for material in mesh.materials:
            if material:
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
                material_resources(material)
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
        snapshots[obj.name] = {"mesh": mesh, "parent": parent.name if parent else None}
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
            "blenderVersion": bpy.app.version_string, "sourceUnitSystem": unit_system,
            "sourceScaleToMeters": scale, "objectCount": len(records), "meshCount": len(snapshots),
            "transformsBaked": True, "warnings": warnings,
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
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    report = Path(args.report)
    try:
        result = convert(Path(args.input), Path(args.output))
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else "Blender could not convert this saved frame. Convert unsupported geometry to meshes, bake materials to image textures, pack resources, and save before importing."
        report.write_text(json.dumps({"error": message[:1600]}), encoding="utf-8")
        raise
    report.write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
