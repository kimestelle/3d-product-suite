"""Bake static Blender material parameters, never a lit beauty image.

Call on an evaluated mesh in the active scene *before* normalizing its world
transform. Output materials remain Principled and editable in the product GLB.
"""
from __future__ import annotations

import math

import bpy


MAX_BAKE_IMAGES = 48
MAX_BAKE_PIXELS = 32 * 1024 * 1024
_budget = {"images": 0, "pixels": 0}
CHANNELS = {
    "Base Color": "color", "Metallic": "scalar", "Roughness": "scalar",
    "Transmission Weight": "scalar", "Alpha": "scalar", "Normal": "normal",
    "Coat Weight": "scalar", "Coat Roughness": "scalar", "Coat Normal": "normal",
    "Specular IOR Level": "scalar", "Specular Tint": "color", "Emission Color": "color",
}
DIRECT_NODES = {"RGB", "VALUE", "REROUTE", "TEX_IMAGE", "UVMAP", "TEX_COORD",
                "MAPPING", "NORMAL_MAP", "SEPRGB", "SEPARATE_COLOR"}
STATIC_NODES = DIRECT_NODES | {"MATH", "VECT_MATH", "MIX", "MIX_RGB", "VALTORGB",
    "RGBTOBW", "TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_GRADIENT", "TEX_CHECKER",
    "TEX_BRICK", "TEX_MAGIC", "MAP_RANGE", "CLAMP", "INVERT", "GAMMA", "HUE_SAT",
    "BRIGHTCONTRAST", "CURVE_RGB", "CURVE_VEC", "VECTOR_ROTATE", "COMBRGB",
    "COMBXYZ", "SEPXYZ", "COMBINE_COLOR", "NORMAL", "BUMP", "NEW_GEOMETRY"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _source(socket):
    seen = set()
    while socket.is_linked:
        result = socket.links[0].from_socket
        if result.node.type != "REROUTE":
            return result
        key = result.node.as_pointer()
        _require(key not in seen, "Material has a cyclic reroute; reconnect it before import")
        seen.add(key)
        socket = result.node.inputs[0]
    return socket


def _principled(material):
    if not material or not material.use_nodes or not material.node_tree:
        return None
    outputs = [node for node in material.node_tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
    for output in outputs:
        surface = output.inputs["Surface"]
        if surface.is_linked:
            node = _source(surface).node
            if node.type == "BSDF_PRINCIPLED":
                return node
    return None


def _walk(socket):
    """Yield connected outputs; keep socket identity for coordinate semantics."""
    pending = [link.from_socket for link in socket.links]
    seen = set()
    while pending:
        output = pending.pop()
        key = output.as_pointer()
        if key in seen:
            continue
        seen.add(key)
        _require(len(seen) <= 4096, "Material graph exceeds the 4096-node bake budget")
        yield output
        pending.extend(link.from_socket for input_ in output.node.inputs for link in input_.links)


def _direct(socket, kind):
    if not socket.is_linked:
        return True
    source = _source(socket)
    if kind == "normal" and (source.node.type != "NORMAL_MAP" or source.node.space != "TANGENT"):
        return False
    for output in _walk(socket):
        node = output.node
        if node.type not in DIRECT_NODES:
            return False
        if node.type == "TEX_COORD" and output.name != "UV":
            return False
        if node.type == "NORMAL_MAP" and (node.space != "TANGENT" or node.inputs["Strength"].is_linked):
            return False
        # Arbitrary mapped vectors are supported by baking, not by glTF's
        # limited 2D UV-transform extension.
        if node.type == "MAPPING":
            if node.vector_type != "POINT" or any(node.inputs[name].is_linked for name in ("Location", "Rotation", "Scale")):
                return False
            rotation = node.inputs["Rotation"].default_value
            if abs(rotation.x) > 1e-7 or abs(rotation.y) > 1e-7:
                return False
    return True


def _plan(material):
    shader = _principled(material)
    if shader is None:
        return []
    plan = []
    for name, kind in CHANNELS.items():
        socket = shader.inputs.get(name)
        if socket is not None and socket.is_linked and not _direct(socket, kind):
            for output in _walk(socket):
                node = output.node
                _require(node.type in STATIC_NODES,
                         f'Material “{material.name}” uses {node.name} in {name}; its view-dependent or unsupported behavior cannot become a static UV map.')
                _require(node.type != "TEX_COORD" or output.name not in {"Camera", "Window", "Reflection"},
                         f'Material “{material.name}” uses view-dependent coordinates in {name}; choose UV or object coordinates before importing.')
                _require(node.type != "NEW_GEOMETRY" or output.name not in {"Incoming", "Backfacing"},
                         f'Material “{material.name}” uses ray-dependent geometry in {name}; it cannot be baked as a product texture.')
            plan.append((name, kind))
    return plan


def material_needs_bake(material):
    return bool(_plan(material))


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _inside(point, triangle):
    signs = [_cross(triangle[i], triangle[(i + 1) % 3], point) for i in range(3)]
    return min(signs) > 1e-10 or max(signs) < -1e-10


def _overlap(a, b):
    # Shared boundaries are fine; only overlapping interiors need a new atlas.
    if any(_inside(point, b) for point in a) or any(_inside(point, a) for point in b):
        return True
    for first, second in ((a, b), (b, a)):
        center = (sum(p[0] for p in first) / 3, sum(p[1] for p in first) / 3)
        if _inside(center, second):
            return True
    for i in range(3):
        p, q = a[i], a[(i + 1) % 3]
        for j in range(3):
            r, s = b[j], b[(j + 1) % 3]
            if _cross(p, q, r) * _cross(p, q, s) < -1e-16 and _cross(r, s, p) * _cross(r, s, q) < -1e-16:
                return True
    return False


def _usable_uv(mesh, layer):
    if layer is None:
        return False
    mesh.calc_loop_triangles()
    if len(mesh.loop_triangles) > 100000:
        return False
    cells, triangles = {}, []
    for face in mesh.loop_triangles:
        triangle = tuple(tuple(layer.data[index].uv) for index in face.loops)
        if not all(math.isfinite(v) and -1e-6 <= v <= 1.000001 for point in triangle for v in point):
            return False
        if abs(_cross(*triangle)) < 1e-12:
            return False
        x0, x1 = max(0, int(min(p[0] for p in triangle) * 31)), min(31, int(max(p[0] for p in triangle) * 31))
        y0, y1 = max(0, int(min(p[1] for p in triangle) * 31)), min(31, int(max(p[1] for p in triangle) * 31))
        keys = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
        previous = {index for key in keys for index in cells.get(key, ())}
        if any(_overlap(triangle, triangles[index]) for index in previous):
            return False
        index = len(triangles)
        triangles.append(triangle)
        for key in keys:
            cells.setdefault(key, []).append(index)
    return bool(triangles)


def _pin_source_uv(materials, name):
    if not name:
        for material in materials:
            if not material or not material.use_nodes:
                continue
            for output in material.node_tree.nodes:
                if output.type != "OUTPUT_MATERIAL" or not output.is_active_output:
                    continue
                for socket in output.inputs:
                    for connected in _walk(socket):
                        node = connected.node
                        _require(node.type != "TEX_IMAGE" or node.inputs["Vector"].is_linked,
                                 f'Material “{material.name}” has an image texture but no source UV coordinates. Assign its source UV map before importing; creating a new atlas cannot recover the missing image placement.')
        return
    for material in materials:
        if not material or not material.use_nodes:
            continue
        tree = material.node_tree
        uv = None

        def uv_socket():
            nonlocal uv
            if uv is None:
                uv = tree.nodes.new("ShaderNodeUVMap")
                uv.uv_map = name
                uv.label = "Original product UV"
            return uv.outputs["UV"]

        for node in list(tree.nodes):
            if node.type == "TEX_IMAGE" and not node.inputs["Vector"].is_linked:
                tree.links.new(uv_socket(), node.inputs["Vector"])
            elif node.type == "TEX_COORD":
                for link in list(node.outputs["UV"].links):
                    destination = link.to_socket
                    tree.links.remove(link)
                    tree.links.new(uv_socket(), destination)
            elif node.type == "NORMAL_MAP" and not node.uv_map:
                node.uv_map = name


def _new_image(name, resolution, kind):
    image = bpy.data.images.new(name, width=resolution, height=resolution, alpha=True, float_buffer=False)
    image.colorspace_settings.name = "sRGB" if kind == "color" else "Non-Color"
    image.generated_color = (0.5, 0.5, 1, 1) if kind == "normal" else (0, 0, 0, 1)
    image.file_format = "PNG"
    return image


def bake_material_inputs(obj, materials=None, *, resolution=1024):
    """Bake unsupported linked channels and replace only those input graphs.

    The object must be a local evaluated mesh in the active scene, retaining its
    source world transform. Materials are copied per object before mutation.
    The caller must use the updated obj.data.materials after this call.
    """
    _require(obj.type == "MESH", "Material baking requires an evaluated mesh object")
    _require(type(resolution) is int and 64 <= resolution <= 2048,
             "Material bake resolution must be between 64 and 2048 pixels")
    selected = {material.as_pointer() for material in materials if material} if materials is not None else None
    originals = list(obj.data.materials)
    plans = {material.as_pointer(): _plan(material) for material in originals
             if material and (selected is None or material.as_pointer() in selected)}
    count = sum(len(plan) for plan in plans.values())
    report = {"object": obj.name, "resolution": resolution, "uvMap": None, "generatedUV": False,
              "materials": [], "imageCount": count}
    if not count:
        return report
    _require(_budget["images"] + count <= MAX_BAKE_IMAGES and _budget["pixels"] + count * resolution * resolution <= MAX_BAKE_PIXELS,
             "Material baking exceeds the 48-image / 32-megapixel import budget. Reduce material variations or bake textures in Blender before importing.")
    _budget["images"] += count
    _budget["pixels"] += count * resolution * resolution
    copies = {}
    for index, material in enumerate(originals):
        if material is None:
            continue
        key = material.as_pointer()
        if key not in copies:
            copies[key] = material.copy()
            copies[key].name = f"{material.name} / {obj.name}"
        obj.data.materials[index] = copies[key]
    used_materials = list(copies.values())
    scene = bpy.context.scene
    previous = {"engine": scene.render.engine, "device": scene.cycles.device, "samples": scene.cycles.samples,
                "denoise": scene.cycles.use_denoising, "active": bpy.context.view_layer.objects.active,
                "selection": list(bpy.context.selected_objects)}
    scratch = None
    try:
        for item in bpy.context.selected_objects:
            item.select_set(False)
        obj.hide_set(False)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        mesh = obj.data
        source_uv = next((layer for layer in mesh.uv_layers if layer.active_render), mesh.uv_layers.active)
        if _usable_uv(mesh, source_uv):
            uv = source_uv
            mesh.uv_layers.active_index = list(mesh.uv_layers).index(uv)
        else:
            _pin_source_uv(used_materials, source_uv.name if source_uv else None)
            _require(len(mesh.uv_layers) < 8, "The product has no reusable bake UV and already uses eight UV layers; remove an unused UV layer in Blender before import")
            uv = mesh.uv_layers.new(name="gesso baked UV")
            uv_name = uv.name
            mesh.uv_layers.active_index = list(mesh.uv_layers).index(uv)
            bpy.ops.object.mode_set(mode="EDIT")
            try:
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02, scale_to_bounds=True)
            finally:
                bpy.ops.object.mode_set(mode="OBJECT")
            # Edit-mode UV projection rebuilds CustomData. The old RNA layer
            # wrapper may now refer to freed memory; reacquire it by name.
            mesh = obj.data
            uv = mesh.uv_layers[uv_name]
            mesh.uv_layers.active_index = list(mesh.uv_layers).index(uv)
            report["generatedUV"] = True
        uv.active_render = True
        report["uvMap"] = uv.name
        scratch = _new_image("gesso bake scratch", 8, "scalar")
        for source in originals:
            if source is None:
                continue
            key = source.as_pointer()
            plan = plans.pop(key, [])
            if not plan:
                continue
            material = copies[key]
            shader, tree = _principled(material), material.node_tree
            entry = {"name": material.name, "sourceMaterial": source.name, "channels": []}
            for name, kind in plan:
                image = _new_image(f"{obj.name} / {source.name} / {name}", resolution, kind)
                targets, surfaces, emission = [], [], None
                try:
                    for other in used_materials:
                        if not other.use_nodes:
                            other.use_nodes = True
                        target = other.node_tree.nodes.new("ShaderNodeTexImage")
                        target.image = image if other == material else scratch
                        other.node_tree.nodes.active = target
                        targets.append((other, target))
                    outputs = [node for node in tree.nodes if node.type == "OUTPUT_MATERIAL" and node.is_active_output]
                    for output in outputs:
                        socket = output.inputs["Surface"]
                        surfaces.append((socket, [link.from_socket for link in socket.links]))
                    if kind != "normal":
                        emission = tree.nodes.new("ShaderNodeEmission")
                        emission.inputs["Strength"].default_value = 1
                        tree.links.new(shader.inputs[name].links[0].from_socket, emission.inputs["Color"])
                        for socket, _ in surfaces:
                            tree.links.new(emission.outputs["Emission"], socket)
                    elif name == "Coat Normal":
                        # NORMAL bake observes the surface normal input. Move
                        # the coat input there temporarily and restore it.
                        normal = shader.inputs["Normal"]
                        surfaces.append((normal, [link.from_socket for link in normal.links]))
                        tree.links.new(shader.inputs[name].links[0].from_socket, normal)
                    result = bpy.ops.object.bake(type="NORMAL" if kind == "normal" else "EMIT",
                                                normal_space="TANGENT", margin=8, use_clear=True,
                                                use_selected_to_active=False, target="IMAGE_TEXTURES",
                                                save_mode="INTERNAL", uv_layer=uv.name)
                    _require("FINISHED" in result, f'Could not bake {name} for “{source.name}”; bake this channel in Blender before import')
                finally:
                    for socket, links in surfaces:
                        for link in list(socket.links):
                            tree.links.remove(link)
                        for from_socket in links:
                            tree.links.new(from_socket, socket)
                    if emission:
                        tree.nodes.remove(emission)
                    for other, target in targets:
                        other.node_tree.nodes.remove(target)
                image.pack()
                texture = tree.nodes.new("ShaderNodeTexImage")
                texture.image = image
                texture.label = f"Baked {name}"
                uv_node = tree.nodes.new("ShaderNodeUVMap")
                uv_node.uv_map = uv.name
                tree.links.new(uv_node.outputs["UV"], texture.inputs["Vector"])
                if kind == "normal":
                    normal = tree.nodes.new("ShaderNodeNormalMap")
                    normal.space = "TANGENT"
                    normal.uv_map = uv.name
                    tree.links.new(texture.outputs["Color"], normal.inputs["Color"])
                    tree.links.new(normal.outputs["Normal"], shader.inputs[name])
                else:
                    tree.links.new(texture.outputs["Color"], shader.inputs[name])
                entry["channels"].append(name)
            report["materials"].append(entry)
    finally:
        if scratch:
            bpy.data.images.remove(scratch)
        scene.render.engine = previous["engine"]
        scene.cycles.device = previous["device"]
        scene.cycles.samples = previous["samples"]
        scene.cycles.use_denoising = previous["denoise"]
        obj.select_set(False)
        for item in previous["selection"]:
            if item.name in bpy.context.view_layer.objects:
                item.select_set(True)
        if previous["active"] and previous["active"].name in bpy.context.view_layer.objects:
            bpy.context.view_layer.objects.active = previous["active"]
    return report
