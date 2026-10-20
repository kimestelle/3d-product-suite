"""Choose product geometry without treating a Blender lighting setup as a part.

Explicit ``gesso_role`` properties win. Automatic exclusions require a named,
planar scene surface and geometric separation from the product; ambiguous
objects stay for the importer to handle. This only inspects the saved scene.
"""
from __future__ import annotations

import math
import re

import bpy
from mathutils import Vector


GEOMETRY = {"MESH", "CURVE", "SURFACE", "FONT", "META"}
HELPERS = {"CAMERA", "LIGHT", "SPEAKER", "LIGHT_PROBE", "LIGHTPROBE", "LATTICE"}
MAX_INSPECTION_VERTICES = 2_000_000
GROUND_WORDS = {"ground", "floor", "backdrop", "background", "cyclorama", "cyc"}
LIGHT_PAIRS = {
    ("fill", "light"), ("key", "light"), ("rim", "light"),
    ("light", "card"), ("light", "panel"), ("emission", "plane"),
    ("emitter", "plane"), ("soft", "box"),
}


def _role(item):
    value = item.get("gesso_role")
    return value.strip().lower() if isinstance(value, str) and value.strip().lower() in {"product", "environment"} else None


def _ancestors(obj):
    seen = set()
    while obj and obj.as_pointer() not in seen:
        seen.add(obj.as_pointer())
        yield obj
        obj = obj.parent


def _collection_parents():
    parents = {}
    # Scene master collections are not members of bpy.data.collections.
    for parent in list(bpy.data.collections) + [scene.collection for scene in bpy.data.scenes]:
        for child in parent.children:
            parents.setdefault(child.as_pointer(), []).append(parent)
    return parents


def _collection_roles(collection, parents):
    pending, seen, found = [collection], set(), set()
    while pending:
        current = pending.pop()
        if current.as_pointer() in seen:
            continue
        seen.add(current.as_pointer())
        role = _role(current)
        if role:
            found.add(role)
        else:
            pending.extend(parents.get(current.as_pointer(), ()))
    return found


def _effective_role(obj, parents):
    for ancestor in _ancestors(obj):
        role = _role(ancestor)
        if role:
            return role
    roles = set()
    for collection in obj.users_collection:
        roles.update(_collection_roles(collection, parents))
    # Multi-collection membership must never silently remove a product.
    return "product" if "product" in roles else "environment" if "environment" in roles else None


def _words(name):
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name)
    return re.findall(r"[a-z]+", name.lower())


def _semantic_kind(obj, parents):
    names, pending, seen = [obj.name], list(obj.users_collection), set()
    while pending:
        collection = pending.pop()
        if collection.as_pointer() in seen:
            continue
        seen.add(collection.as_pointer())
        names.append(collection.name)
        pending.extend(parents.get(collection.as_pointer(), ()))
    ground = light = False
    for name in names:
        words = _words(name)
        ground |= bool(set(words) & GROUND_WORDS)
        light |= ("softbox" in words or "lighting" in words
                  or any(tuple(words[index:index + 2]) in LIGHT_PAIRS for index in range(len(words) - 1)))
    return ground, light


def _geometry(obj, depsgraph, budget):
    """Bounds and a measured surface plane, including evaluated modifiers."""
    evaluated = obj.evaluated_get(depsgraph)
    mesh = None
    try:
        mesh = evaluated.to_mesh()
        if mesh is None or not mesh.polygons:
            return None
        budget["vertices"] += len(mesh.vertices)
        if budget["vertices"] > MAX_INSPECTION_VERTICES:
            budget["complete"] = False
            return None
        # Loose vertices do not contribute to either the product or its stage.
        used = {index for polygon in mesh.polygons for index in polygon.vertices}
        points = [evaluated.matrix_world @ mesh.vertices[index].co for index in used]
        if not points or not all(math.isfinite(component) for point in points for component in point):
            budget["complete"] = False
            return None
        low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        origin = points[0]
        far = max(points, key=lambda point: (point - origin).length_squared)
        edge = far - origin
        size = edge.length
        if size <= 1e-10:
            return None
        across = max(points, key=lambda point: edge.cross(point - origin).length_squared)
        normal = edge.cross(across - origin)
        if normal.length <= size * size * 1e-8:
            return None
        normal.normalize()
        planar = max(abs((point - origin).dot(normal)) for point in points) <= max(size * 1e-5, 1e-8)
        axis_u = edge.normalized()
        axis_v = normal.cross(axis_u)
        projections = [(point.dot(axis_u), point.dot(axis_v)) for point in points]
        spans = tuple(max(point[axis] for point in projections) - min(point[axis] for point in projections) for axis in range(2))
        material_indices = {polygon.material_index for polygon in mesh.polygons}
        materials = [evaluated.material_slots[index].material for index in material_indices
                     if index < len(evaluated.material_slots)]
        return {"low": low, "high": high, "planar": planar, "origin": origin,
                "normal": normal, "u": axis_u, "v": axis_v, "spans": spans,
                "materials": materials}
    except (RuntimeError, ValueError, TypeError):
        # Classification failure must not hide an object or replace the main
        # importer's more specific geometry/material diagnostic.
        budget["complete"] = False
        return None
    finally:
        if mesh is not None:
            evaluated.to_mesh_clear()


def _constant(socket):
    seen = set()
    while socket.is_linked:
        source = socket.links[0].from_socket
        if source.node.type in {"RGB", "VALUE"}:
            return source.default_value
        if source.node.type != "REROUTE" or source.as_pointer() in seen:
            return None
        seen.add(source.as_pointer())
        socket = source.node.inputs[0]
    return socket.default_value


def _emissive(material):
    if not material or not material.use_nodes:
        return False
    for output in material.node_tree.nodes:
        if output.type != "OUTPUT_MATERIAL" or not output.is_active_output:
            continue
        socket = output.inputs["Surface"]
        seen = set()
        while socket.is_linked:
            shader = socket.links[0].from_node
            if shader.type != "REROUTE":
                break
            if shader.as_pointer() in seen:
                return False
            seen.add(shader.as_pointer())
            socket = shader.inputs[0]
        else:
            return False
        if shader.type == "EMISSION":
            color, strength = _constant(shader.inputs["Color"]), _constant(shader.inputs["Strength"])
        elif shader.type == "BSDF_PRINCIPLED":
            color, strength = _constant(shader.inputs["Emission Color"]), _constant(shader.inputs["Emission Strength"])
        else:
            return False
        if color is not None and strength is not None and strength > 0 and max(color[:3]) > 0:
            return True
    return False


def _corners(low, high):
    return [Vector((x, y, z)) for x in (low.x, high.x) for y in (low.y, high.y) for z in (low.z, high.z)]


def _outside_distance(a, b):
    return math.sqrt(sum(max(a["low"][axis] - b["high"][axis], b["low"][axis] - a["high"][axis], 0) ** 2
                         for axis in range(3)))


def select_product_objects(objects, depsgraph):
    """Return ``(kept_objects, [{object, reason}])`` without scene mutations.

    The caller supplies render-visible objects and remains responsible for
    instance validation and rebuilding parent links around excluded objects.
    Unknown unsupported types stay unless explicitly marked environment.
    """
    objects = list(objects)
    parents = _collection_parents()
    roles = {obj.as_pointer(): _effective_role(obj, parents) for obj in objects}
    excluded, geometry, candidates = {}, {}, {}
    for obj in objects:
        key = obj.as_pointer()
        if roles[key] == "environment":
            excluded[key] = "Marked as environment by gesso_role"
        elif obj.type in HELPERS:
            excluded[key] = "Scene camera, light, or helper"
        elif obj.type in GEOMETRY:
            if roles[key] != "product":
                candidates[key] = _semantic_kind(obj, parents)
    budget = {"vertices": 0, "complete": True}
    if any(ground or light for ground, light in candidates.values()):
        for obj in objects:
            key = obj.as_pointer()
            if key not in excluded and obj.type in GEOMETRY:
                geometry[key] = _geometry(obj, depsgraph, budget)
                if not budget["complete"]:
                    break
    # A solid reference prevents flat products, labels, and ambiguous planes
    # from being mistaken for a stage. No solid reference means no heuristics.
    references = [obj for obj in objects
                  if geometry.get(obj.as_pointer()) and
                  (roles[obj.as_pointer()] == "product" or not geometry[obj.as_pointer()]["planar"])]
    if references and budget["complete"]:
        reference_geometry = [geometry[obj.as_pointer()] for obj in references]
        bounds = {
            "low": Vector(tuple(min(record["low"][axis] for record in reference_geometry) for axis in range(3))),
            "high": Vector(tuple(max(record["high"][axis] for record in reference_geometry) for axis in range(3))),
        }
        corners = _corners(bounds["low"], bounds["high"])
        diagonal = (bounds["high"] - bounds["low"]).length
        hierarchy = {ancestor.as_pointer() for obj in references for ancestor in _ancestors(obj)}
        for obj in objects:
            key = obj.as_pointer()
            record = geometry.get(key)
            if key not in candidates or not record or not record["planar"]:
                continue
            if any(ancestor.as_pointer() in hierarchy for ancestor in _ancestors(obj)):
                continue
            ground, light = candidates[key]
            if ground:
                reference_spans = [max(point.dot(axis) for point in corners) - min(point.dot(axis) for point in corners)
                                   for axis in (record["u"], record["v"])]
                ratios = [span / max(reference, diagonal * 1e-4, 1e-8)
                          for span, reference in zip(record["spans"], reference_spans)]
                distances = [(point - record["origin"]).dot(record["normal"]) for point in corners]
                outside = min(distances) >= -diagonal * 0.005 or max(distances) <= diagonal * 0.005
                if outside and min(ratios) >= 2 and ratios[0] * ratios[1] >= 6:
                    excluded[key] = "Large planar ground or backdrop outside the product"
                    continue
            if (light and record["materials"] and all(_emissive(material) for material in record["materials"])
                    and _outside_distance(record, bounds) >= diagonal * 0.15):
                excluded[key] = "Planar emissive lighting card separate from the product"
    return ([obj for obj in objects if obj.as_pointer() not in excluded],
            [{"object": obj.name, "reason": excluded[obj.as_pointer()]}
             for obj in objects if obj.as_pointer() in excluded])
