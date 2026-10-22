"""Import prepared GLBs and normalized snapshots of Blender, CAD and mesh products.

GLB input must already use glTF's Y-up metres and be centered at its visible bounds.
Conversions feed the same handoff; no format infers mechanisms or native CAD constraints.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import struct

from .worlds import (_canonical, _data_uri, _immutable_write, _read_asset, _require,
                     _validate_glb, bundle_assets, safe_asset_path,
                     validate_provenance)

ROOT = Path(__file__).resolve().parents[1]
_IDENTITY = ((1., 0., 0., 0.), (0., 1., 0., 0.), (0., 0., 1., 0.), (0., 0., 0., 1.))


def _numbers(value, size, name):
    _require(isinstance(value, list) and len(value) == size
             and all(type(x) in (int, float) and math.isfinite(x) for x in value),
             f"Product {name} must contain {size} finite numbers")
    return value


def _multiply(left, right):
    return tuple(tuple(sum(left[row][k] * right[k][column] for k in range(4))
                       for column in range(4)) for row in range(4))


def _node_matrix(node):
    if "matrix" in node:
        _require(not any(key in node for key in ("translation", "rotation", "scale")),
                 "Product GLB nodes must use either matrix or TRS")
        values = _numbers(node["matrix"], 16, "node matrix")
        result = tuple(tuple(values[column * 4 + row] for column in range(4)) for row in range(4))
        _require(all(abs(result[3][column] - _IDENTITY[3][column]) < 1e-8 for column in range(4)),
                 "Product GLB matrices must be affine")
        return result
    t = _numbers(node.get("translation", [0, 0, 0]), 3, "node translation")
    s = _numbers(node.get("scale", [1, 1, 1]), 3, "node scale")
    x, y, z, w = _numbers(node.get("rotation", [0, 0, 0, 1]), 4, "node rotation")
    _require(abs(x*x + y*y + z*z + w*w - 1) < 1e-6, "Product GLB node quaternion must be normalized")
    _require(all(abs(value) > 1e-12 for value in s), "Product GLB node scale must not collapse geometry")
    rotation = ((1-2*y*y-2*z*z, 2*x*y-2*z*w, 2*x*z+2*y*w),
                (2*x*y+2*z*w, 1-2*x*x-2*z*z, 2*y*z-2*x*w),
                (2*x*z-2*y*w, 2*y*z+2*x*w, 1-2*x*x-2*y*y))
    return tuple(tuple(rotation[row][column] * s[column] for column in range(3)) + (t[row],)
                 for row in range(3)) + (_IDENTITY[3],)


def _accessor_rows(document, buffers, index, *, positions=False):
    accessors = document.get("accessors", [])
    _require(type(index) is int and 0 <= index < len(accessors), "Product GLB references an unknown accessor")
    accessor = accessors[index]
    _require("sparse" not in accessor and "bufferView" in accessor,
             "Product GLB accessors must use embedded dense buffers; bake sparse or compressed geometry")
    _require(not accessor.get("normalized", False), "Product GLB geometry accessors must not be normalized")
    if positions:
        _require(accessor["componentType"] == 5126 and accessor["type"] == "VEC3",
                 "Product GLB POSITION must be float32 VEC3")
        format_, size = "<3f", 12
    else:
        _require(accessor["type"] == "SCALAR" and accessor["componentType"] in (5121, 5123, 5125),
                 "Product GLB triangle indices must be unsigned integers")
        format_ = {5121: "<B", 5123: "<H", 5125: "<I"}[accessor["componentType"]]
        size = struct.calcsize(format_)
    view = document["bufferViews"][accessor["bufferView"]]
    stride = view.get("byteStride", size)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    buffer = buffers[view["buffer"]]
    for number in range(accessor["count"]):
        row = struct.unpack_from(format_, buffer, offset + number * stride)
        _require(all(math.isfinite(value) for value in row), "Product GLB positions must be finite")
        yield row


def inspect_product_glb(payload):
    """Validate bounded static GLB content and measure its active-scene vertices.

    Bounds are measured from actual positions and node transforms, not untrusted
    accessor min/max metadata. Materials and embedded textures remain untouched.
    """
    _require(isinstance(payload, bytes) and len(payload) <= 128 * 1024 * 1024,
             "Product GLB exceeds the 128 MiB limit")
    metadata = _validate_glb(payload)
    try:
        json_length = struct.unpack_from("<I", payload, 12)[0]
        document = json.loads(payload[20:20 + json_length])
        binary_offset = 20 + json_length
        binary = payload[binary_offset + 8:] if binary_offset < len(payload) else b""
        buffers = [_data_uri(buffer["uri"]) if "uri" in buffer else binary
                   for buffer in document.get("buffers", [])]
        _require(not document.get("animations") and not document.get("skins"),
                 "Product GLB must be static; bake animations and skins before import")
        _require(not document.get("cameras") and "KHR_lights_punctual" not in document.get("extensions", {}),
                 "Product GLB must contain product geometry without cameras or lights")
        nodes = document.get("nodes", [])
        scenes = document.get("scenes", [])
        selected = document.get("scene", 0)
        _require(isinstance(nodes, list) and 0 < len(nodes) <= 100000,
                 "Product GLB must contain a bounded static node hierarchy")
        _require(isinstance(scenes, list) and len(scenes) == 1 and type(selected) is int and selected == 0,
                 "Product GLB must declare one unambiguous active scene")
        roots = scenes[selected].get("nodes")
        _require(isinstance(roots, list) and roots, "Product GLB active scene must contain nodes")
        for view in document.get("bufferViews", []):
            _require("EXT_meshopt_compression" not in view.get("extensions", {}),
                     "Product GLB compressed geometry must be decoded before import")
        for node in nodes:
            _require(isinstance(node, dict) and "skin" not in node and "weights" not in node,
                     "Product GLB must not contain skinning or morph weights")
            _require("camera" not in node and "KHR_lights_punctual" not in node.get("extensions", {}),
                     "Product GLB must not contain cameras or lights")
        minimum, maximum = [math.inf] * 3, [-math.inf] * 3
        vertex_count, seen = 0, set()

        def visit(index, parent, depth=0):
            nonlocal vertex_count
            _require(type(index) is int and 0 <= index < len(nodes), "Product GLB references an unknown node")
            _require(depth <= 80 and index not in seen, "Product GLB hierarchy has a cycle, duplicate parent, or excessive depth")
            seen.add(index)
            node = nodes[index]
            matrix = _multiply(parent, _node_matrix(node))
            if "mesh" in node:
                mesh_index = node["mesh"]
                meshes = document["meshes"]
                _require(type(mesh_index) is int and 0 <= mesh_index < len(meshes), "Product GLB references an unknown mesh")
                mesh = meshes[mesh_index]
                _require("weights" not in mesh, "Product GLB morph weights must be baked before import")
                for primitive in mesh["primitives"]:
                    _require(not primitive.get("targets"), "Product GLB morph targets must be baked before import")
                    _require("KHR_draco_mesh_compression" not in primitive.get("extensions", {}),
                             "Product GLB compressed geometry must be decoded before import")
                    _require(primitive.get("mode", 4) == 4, "Product GLB geometry must use triangles")
                    position_index = primitive["attributes"]["POSITION"]
                    count = document["accessors"][position_index]["count"]
                    if "indices" in primitive:
                        indices = primitive["indices"]
                        index_count = document["accessors"][indices]["count"] if type(indices) is int and 0 <= indices < len(document["accessors"]) else -1
                        _require(index_count > 0 and index_count % 3 == 0, "Product GLB triangle index count is invalid")
                        _require(all(row[0] < count for row in _accessor_rows(document, buffers, indices)),
                                 "Product GLB triangle index references an unknown vertex")
                    else:
                        _require(count > 0 and count % 3 == 0, "Product GLB triangle vertex count is invalid")
                    vertex_count += count
                    _require(vertex_count <= 10000000, "Product GLB active geometry exceeds the vertex limit")
                    for point in _accessor_rows(document, buffers, position_index, positions=True):
                        transformed = [sum(matrix[row][column] * point[column] for column in range(3)) + matrix[row][3]
                                       for row in range(3)]
                        _require(all(math.isfinite(value) for value in transformed), "Product GLB transforms produce nonfinite geometry")
                        for axis, value in enumerate(transformed):
                            minimum[axis] = min(minimum[axis], value)
                            maximum[axis] = max(maximum[axis], value)
            children = node.get("children", [])
            _require(isinstance(children, list), "Product GLB node children must be a list")
            for child in children:
                visit(child, matrix, depth + 1)

        for root in roots:
            visit(root, _IDENTITY)
        _require(all(index in seen for index, node in enumerate(nodes) if "mesh" in node),
                 "Product GLB must not hide mesh nodes outside its active scene")
        used_meshes = {nodes[index]["mesh"] for index in seen if "mesh" in nodes[index]}
        _require(used_meshes == set(range(len(document["meshes"]))),
                 "Product GLB must not contain unused hidden meshes")
        _require(vertex_count > 0, "Product GLB active scene contains no geometry")
        dimensions = [high - low for low, high in zip(minimum, maximum)]
        _require(all(1e-8 < value <= 1000 for value in dimensions),
                 "Product GLB must have nonzero three-dimensional bounds in metres (maximum 1000 m)")
        tolerance = max(1e-6, max(dimensions) * 1e-5)
        _require(all(abs(low + high) / 2 <= tolerance for low, high in zip(minimum, maximum)),
                 "Product GLB geometry must be centered at its bounds before import")
        return {**metadata, "vertexCount": vertex_count, "boundsM": [minimum, maximum], "dimensionsM": dimensions}
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError, struct.error) as error:
        raise ValueError(f"Malformed normalized product GLB: {type(error).__name__}") from error



def product_source_nodes(payload):
    """Immutable physical hierarchy + measured local bounds from verified GLB bytes."""
    json_length = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + json_length])
    binary_offset = 20 + json_length
    binary = payload[binary_offset + 8:] if binary_offset < len(payload) else b""
    buffers = [_data_uri(buffer["uri"]) if "uri" in buffer else binary for buffer in document.get("buffers", [])]
    nodes, records = document["nodes"], []
    def visit(index, parent=None):
        node = nodes[index]
        minimum, maximum = [math.inf] * 3, [-math.inf] * 3
        def include(p):
            for axis, value in enumerate(p):
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
        if "mesh" in node:
            for primitive in document["meshes"][node["mesh"]]["primitives"]:
                for point in _accessor_rows(document, buffers, primitive["attributes"]["POSITION"], positions=True):
                    include(point)
        for child_index in node.get("children", []):
            child = visit(child_index, index)
            if child["drawable"]:
                matrix = _node_matrix(nodes[child_index])
                for x in (child["boundsM"][0][0], child["boundsM"][1][0]):
                    for y in (child["boundsM"][0][1], child["boundsM"][1][1]):
                        for z in (child["boundsM"][0][2], child["boundsM"][1][2]):
                            p = (x, y, z)
                            include([sum(matrix[r][c] * p[c] for c in range(3)) + matrix[r][3] for r in range(3)])
        drawable = math.isfinite(minimum[0])
        matrix = _node_matrix(node)
        record = {"nodeIndex": index, "parentIndex": parent,
                  "name": str(node.get("name") or f"Object {index + 1}")[:1000],
                  "localMatrix": [matrix[r][c] for c in range(4) for r in range(4)],
                  "boundsM": [minimum, maximum] if drawable else [[0., 0., 0.], [0., 0., 0.]],
                  "drawable": drawable, "hasMesh": "mesh" in node}
        records.append(record)
        return record
    for index in document["scenes"][document.get("scene", 0)]["nodes"]:
        visit(index)
    return sorted(records, key=lambda record: record["nodeIndex"])


def validate_product_source_nodes(component, payload):
    if "sourceNodes" in component:
        _require(component["sourceNodes"] == product_source_nodes(payload),
                 "Source part catalog does not match the immutable product asset")


def hydrate_product_nodes(scene, asset_root):
    """Enrich legacy scenes in memory; callers decide whether to save a revision."""
    for component in scene["product"]["components"]:
        if component["shape"] != "mesh" or "sourceNodes" in component:
            continue
        asset = component["asset"]
        payload = _read_asset(safe_asset_path(asset_root, asset["path"]))
        _require(hashlib.sha256(payload).hexdigest() == asset["sha256"], "Product asset hash changed while reading parts")
        inspect_product_glb(payload)
        component["sourceNodes"] = product_source_nodes(payload)
    return scene


def validate_product_material_nodes(component, payload):
    """Check section targets against the already verified, static GLB bytes."""
    bindings = component.get("materialBindings", [])
    if not bindings:
        return
    json_length = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + json_length])
    nodes = document["nodes"]
    drawable = set()
    def visit(index):
        node = nodes[index]
        has_mesh = "mesh" in node
        for child in node.get("children", []):
            has_mesh = visit(child) or has_mesh
        if has_mesh:
            drawable.add(index)
        return has_mesh
    for root in document["scenes"][document.get("scene", 0)]["nodes"]:
        visit(root)
    for binding in bindings:
        _require(binding["nodeIndex"] in drawable,
                 "Material section must reference an existing source node with mesh geometry")


def validate_product_dimensions(metadata, dimensions_m, bounds_m=None):
    dimensions = _numbers(dimensions_m, 3, "dimensionsM")
    actual = metadata["dimensionsM"]
    tolerance = max(1e-6, max(actual) * 1e-5)
    _require(all(value > 0 and abs(value - expected) <= tolerance for value, expected in zip(dimensions, actual)),
             "Product dimensions do not match the normalized GLB geometry")
    if bounds_m is not None:
        _require(isinstance(bounds_m, list) and len(bounds_m) == 2, "Product boundsM must contain minimum and maximum vectors")
        for supplied, measured in zip(bounds_m, metadata["boundsM"]):
            _numbers(supplied, 3, "boundsM")
            _require(all(abs(value - expected) <= tolerance for value, expected in zip(supplied, measured)),
                     "Product bounds do not match the normalized GLB geometry")


def _prepared_scene(source_path, *, name, provenance, template=None, dimensions_m=None, bounds_m=None,
                    material=None, metadata=None):
    from .scene import load_scene, validate_scene
    _require(isinstance(name, str) and 0 < len(name.strip()) <= 120, "Product name must contain 1 to 120 characters")
    validate_provenance(provenance)
    _require(Path(source_path).suffix.lower() == ".glb", "Prepared products must use a .glb file")
    payload = _read_asset(source_path)
    measured = inspect_product_glb(payload)
    if measured["vertexCount"] > 1000000:
        metadata = {**(metadata or {}), "importDiagnostics": {
            "vertexCount": measured["vertexCount"],
            "warnings": [f"Dense product: {measured['vertexCount']:,} vertices. Geometry is preserved; use a simplified source for faster editing."],
        }}
    if dimensions_m is not None:
        _numbers(dimensions_m, 3, "dimensionsM")
    dimensions = list(measured["dimensionsM"] if dimensions_m is None else dimensions_m)
    validate_product_dimensions(measured, dimensions, bounds_m)
    digest = hashlib.sha256(payload).hexdigest()
    if template is None:
        template = ROOT / "examples" / "bottle.scene.json"
    if isinstance(template, (str, Path)):
        source_root = Path(template).resolve().parent
        scene = copy.deepcopy(load_scene(template))
    else:
        scene = copy.deepcopy(validate_scene(template))
        source_root = None
    material = copy.deepcopy(material if material is not None else {"baseColor": [0.8, 0.8, 0.8, 1], "roughness": 0.45, "metallic": 0})
    product = {"displayName": name.strip(), "dimensionsM": dimensions,
               "provenance": copy.deepcopy(provenance),
               "components": [{"id": "product", "shape": "mesh", "sizeM": dimensions,
                               "asset": {"format": "glb", "path": f"assets/{digest}.glb", "sha256": digest, "sourceUp": "Y"},
                               "assembly": {"translationM": [0, dimensions[1] / 2, 0], "rotationXyzw": [0, 0, 0, 1]},
                               "material": material, "materialOverride": False, "bevelM": 0,
                               "sourceNodes": product_source_nodes(payload)}]}
    if metadata is not None:
        _require(isinstance(metadata, dict), "Product metadata must be an object")
        _canonical(metadata)
        product["metadata"] = copy.deepcopy(metadata)
    product["revisionId"] = "product-" + hashlib.sha256(_canonical(product)).hexdigest()[:24]
    scene["product"] = product
    scene["sceneId"] = product["revisionId"] + "-campaign"
    scene["actions"], scene["evidence"] = [], []
    scene["placement"]["translationM"] = [0, 0, 0]
    plinth = scene["environment"]["plinth"]
    plinth["sizeM"] = [max(dimensions[0] * 1.5, dimensions[2]), max(dimensions) * 0.25, max(dimensions[2] * 1.5, dimensions[0])]
    plinth["translationM"] = [0, -plinth["sizeM"][1] / 2, 0]
    # Imported products start on the world's own floor: the contact plinth stays
    # the deterministic support surface but is hidden until the user shows it.
    plinth["visible"] = False
    # Fit the same actual product bounds in every shot, including portrait gates.
    radius = math.sqrt(sum(value * value for value in dimensions)) / 2
    half_vertical = math.atan(36 / (2 * 50))
    half_horizontal = math.atan(math.tan(half_vertical) * scene["render"]["width"] / scene["render"]["height"])
    distance = radius / math.sin(min(half_vertical, half_horizontal)) * 1.18
    target = [0, dimensions[1] / 2, 0]
    angles = ((0.22, 0.12, 1), (-0.16, 0.08, 1), (0.07, 0.06, 1))
    names = ("Product reveal", "Product detail", "Product hero")
    for index, shot in enumerate(scene["shots"]):
        shot["name"] = names[index % 3]
        direction = angles[index % 3]
        length = math.sqrt(sum(value * value for value in direction))
        before = {"positionM": [target[axis] + direction[axis] * distance / length for axis in range(3)],
                  "targetM": list(target), "focalLengthMm": 50}
        after = copy.deepcopy(before)
        after["positionM"][0] *= 0.8
        shot["camera"] = {"from": before, "to": after}
    from .campaign_defaults import resize_campaign_defaults
    scene = resize_campaign_defaults(scene, reference_size_m=max(dimensions))
    validate_scene(scene)
    return scene, payload, source_root


def _write_assets(scene, payload, destination, template_root):
    # Preserve the selected environment when a file template is supplied. A dict
    # template's assets must already be in destination, as in the editor store.
    bundle_assets({"environment": scene["environment"]}, template_root or destination, destination)
    asset = scene["product"]["components"][0]["asset"]
    _immutable_write(safe_asset_path(destination, asset["path"]), payload)


PRODUCT_SUFFIXES = (".glb", ".blend", ".step", ".stp", ".iges", ".igs", ".stl", ".obj")


@contextmanager
def _converted_product(source_path, *, name, provenance, metadata, blender, source_up, source_units):
    """Normalize once, then let all callers use the same immutable GLB handoff."""
    import tempfile
    suffix = Path(source_path).suffix.lower()
    _require(suffix in PRODUCT_SUFFIXES, "Choose GLB, Blender, STEP, IGES, STL or OBJ; export native CAD to STEP first")
    _require(isinstance(name, str) and 0 < len(name.strip()) <= 120, "Product name must contain 1 to 120 characters")
    validate_provenance(provenance)
    _require(metadata is None or isinstance(metadata, dict), "Product metadata must be an object")
    if suffix == ".glb":
        yield source_path, metadata
        return
    with tempfile.TemporaryDirectory(prefix="gesso-product-") as temporary:
        converted = Path(temporary) / "product.glb"
        if suffix == ".blend":
            from .blend_import import convert_blend_product
            report = convert_blend_product(source_path, converted, blender=blender,
                                           **({"source_units": source_units} if source_units else {}))
            key = "blendImport"
        elif suffix in (".step", ".stp", ".iges", ".igs"):
            from .cad_import import convert_cad_product
            report = convert_cad_product(source_path, converted, source_up=source_up)
            key = "cadImport"
        else:
            from .cad_import import convert_mesh_product
            report = convert_mesh_product(source_path, converted, source_units=source_units,
                                          source_up=source_up, blender=blender)
            key = "meshImport"
        yield converted, {**(metadata or {}), key: report}


def create_product_scene(source_path, output_dir, *, name, provenance, template=None, dimensions_m=None,
                         bounds_m=None, material=None, metadata=None, blender="blender",
                         source_up="z", source_units=None):
    """Write scene.json and pinned product/environment assets in output_dir."""
    with _converted_product(source_path, name=name, provenance=provenance, metadata=metadata,
                            blender=blender, source_up=source_up, source_units=source_units) as (prepared, details):
        return _create_prepared_scene(prepared, output_dir, name=name, provenance=provenance, template=template,
                                      dimensions_m=dimensions_m, bounds_m=bounds_m, material=material, metadata=details)


def _create_prepared_scene(source_path, output_dir, *, name, provenance, template, dimensions_m,
                           bounds_m, material, metadata):
    scene, payload, template_root = _prepared_scene(source_path, name=name, provenance=provenance, template=template,
                                                  dimensions_m=dimensions_m, bounds_m=bounds_m, material=material, metadata=metadata)
    destination = Path(output_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    path = safe_asset_path(destination, "scene.json")
    encoded = _canonical(scene) + b"\n"
    if path.exists():
        _require(path.read_bytes() == encoded, "Existing product scene differs; use a new output directory")
    _write_assets(scene, payload, destination, template_root)
    _immutable_write(path, encoded)
    return scene


def import_product(source_path, library_root, *, name, provenance, template=None, dimensions_m=None,
                   bounds_m=None, material=None, metadata=None, blender="blender", source_up="z", source_units=None):
    """Import a reusable local product entry; never uploads source media."""
    with _converted_product(source_path, name=name, provenance=provenance, metadata=metadata,
                            blender=blender, source_up=source_up, source_units=source_units) as (prepared, details):
        return _import_prepared_product(prepared, library_root, name=name, provenance=provenance, template=template,
                                        dimensions_m=dimensions_m, bounds_m=bounds_m, material=material, metadata=details)


def _import_prepared_product(source_path, library_root, *, name, provenance, template, dimensions_m,
                             bounds_m, material, metadata):
    scene, payload, template_root = _prepared_scene(source_path, name=name, provenance=provenance, template=template,
                                                  dimensions_m=dimensions_m, bounds_m=bounds_m, material=material, metadata=metadata)
    from .scene import scene_digest
    product_id = "product-" + scene_digest(scene)[:24]
    entry = {"id": product_id, "name": name.strip(), "scene": scene}
    destination = Path(library_root).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    _write_assets(scene, payload, destination, template_root)
    _immutable_write(safe_asset_path(destination, f"products/{product_id}.json"), _canonical(entry) + b"\n")
    return entry
