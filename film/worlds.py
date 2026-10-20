"""Content-addressed, local-only world assets and immutable library entries."""
from __future__ import annotations

import base64
import copy
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tempfile

MAX_ASSET_BYTES = 128 * 1024 * 1024
MAX_DECODED_SPZ_BYTES = 512 * 1024 * 1024
_SHA = re.compile(r"^[0-9a-f]{64}$")
_REQUIRED_GAUSSIAN = {"x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                      "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"}
_PLY_TYPES = {"char": "b", "int8": "b", "uchar": "B", "uint8": "B", "short": "h", "int16": "h",
              "ushort": "H", "uint16": "H", "int": "i", "int32": "i", "uint": "I", "uint32": "I",
              "float": "f", "float32": "f", "double": "d", "float64": "d"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _finite(value, name):
    _require(type(value) in (int, float) and math.isfinite(value), f"{name} must be finite")


def _vector(value, name, size=3):
    _require(isinstance(value, list) and len(value) == size, f"{name} must have {size} values")
    for number in value:
        _finite(number, name)


def validate_provenance(provenance):
    _require(isinstance(provenance, dict), "World provenance is required")
    for name in ("source", "reuseBasis", "owner"):
        _require(isinstance(provenance.get(name), str) and provenance[name].strip(), f"World provenance.{name} is required")
    destinations = provenance.get("allowedExternalDestinations")
    _require(isinstance(destinations, list) and all(isinstance(item, str) for item in destinations),
             "World provenance must declare allowedExternalDestinations")
    return provenance


def safe_asset_path(root, relative_path):
    """Resolve a local relative path without escaping root, including symlinks."""
    _require(isinstance(relative_path, str) and relative_path, "Asset path must be a relative local path")
    _require("\\" not in relative_path and ":" not in relative_path and "\0" not in relative_path,
             "Asset path must be a relative local path")
    parts = PurePosixPath(relative_path)
    _require(not parts.is_absolute() and all(part not in ("", ".", "..") for part in relative_path.split("/")),
             "Asset path must not be absolute or contain parent traversal")
    root = Path(root).resolve()
    resolved = (root / relative_path).resolve()
    _require(resolved.is_relative_to(root), "Asset path resolves outside its source root")
    return resolved


def validate_asset_record(asset, *, kind=None):
    _require(isinstance(asset, dict), "World asset record is required")
    sha = asset.get("sha256")
    format_ = asset.get("format")
    _require(isinstance(sha, str) and _SHA.fullmatch(sha), "World asset sha256 must be 64 lowercase hexadecimal characters")
    _require(format_ in ("glb", "spz", "ply"), "World asset format must be glb, spz or ply")
    _require(asset.get("path") == f"assets/{sha}.{format_}", "World asset path must be assets/<sha256>.<format>")
    if kind is not None:
        _require((kind == "mesh" and format_ == "glb") or (kind == "splat" and format_ in ("spz", "ply")),
                 "World asset format does not match environment kind")
    _require(asset.get("sourceUp") in ("Y", "Z"), "World asset sourceUp must explicitly be Y or Z")
    _require(format_ != "glb" or asset["sourceUp"] == "Y", "GLB assets must use sourceUp Y by the glTF specification")
    _finite(asset.get("scaleToMeters"), "World scaleToMeters")
    _require(asset["scaleToMeters"] > 0, "World scaleToMeters must be positive")
    _vector(asset.get("translationM"), "World translationM")
    _vector(asset.get("rotationXyzw"), "World rotationXyzw", 4)
    _require(abs(sum(value * value for value in asset["rotationXyzw"]) - 1) < 1e-6,
             "World rotationXyzw must be normalized")
    return asset


def validate_product_asset_record(asset):
    """Product geometry is already normalized to centered Y-up metres."""
    _require(isinstance(asset, dict), "Product asset record is required")
    sha = asset.get("sha256")
    _require(isinstance(sha, str) and _SHA.fullmatch(sha), "Product asset sha256 must be 64 lowercase hexadecimal characters")
    _require(asset.get("format") == "glb", "Product mesh assets must be self-contained GLB files")
    _require(asset.get("path") == f"assets/{sha}.glb", "Product asset path must be assets/<sha256>.glb")
    _require(asset.get("sourceUp") == "Y", "Product GLB assets must use normalized sourceUp Y")
    _require(not any(key in asset for key in ("scaleToMeters", "translationM", "rotationXyzw")),
             "Product asset transforms must be baked into normalized geometry; use the component assembly pose")
    return asset


def _read_asset(path):
    path = Path(path)
    try:
        info = path.stat()
        _require(stat.S_ISREG(info.st_mode), "World asset must be a regular file")
        _require(0 < info.st_size <= MAX_ASSET_BYTES, f"World asset must be nonempty and at most {MAX_ASSET_BYTES // 1024 // 1024} MiB")
        with path.open("rb") as handle:
            payload = handle.read(MAX_ASSET_BYTES + 1)
        _require(0 < len(payload) <= MAX_ASSET_BYTES, "World asset exceeds the size limit")
        return payload
    except OSError as error:
        raise ValueError(f"Cannot read world asset: {error.strerror or type(error).__name__}") from error


def _data_uri(uri):
    _require(isinstance(uri, str) and uri.startswith("data:"), "GLB must be self-contained; external URIs are forbidden")
    header, separator, body = uri.partition(",")
    _require(separator and header.endswith(";base64"), "GLB data URIs must use base64")
    mime = header[5:-7]
    _require(mime in ("application/octet-stream", "application/gltf-buffer", "image/png", "image/jpeg", "image/webp"),
             "GLB data URI media type is unsupported or executable")
    try:
        return base64.b64decode(body, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("GLB contains an invalid base64 data URI") from error


def _check_glb_tree(value, depth=0):
    _require(depth <= 80, "GLB JSON nesting is too deep")
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower()
            _require(lowered not in ("script", "scripts", "javascript"), "Scripts are forbidden in world GLBs")
            if lowered in ("uri", "url", "href"):
                _data_uri(child)
            _check_glb_tree(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _check_glb_tree(child, depth + 1)
    elif type(value) is float:
        _require(math.isfinite(value), "GLB JSON must contain finite values")


def _validate_glb(payload, source_name=""):
    _require(not re.search(r"(?:^|[ _.-])(collider|collision)(?:[ _.-]|$)", Path(source_name).stem.lower()),
             "A collision mesh cannot be imported as a visual world")
    _require(len(payload) >= 20, "GLB header is truncated")
    magic, version, length = struct.unpack_from("<4sII", payload)
    _require(magic == b"glTF" and version == 2 and length == len(payload), "Expected a complete GLB version 2 file")
    chunks, offset = [], 12
    while offset < len(payload):
        _require(offset + 8 <= len(payload), "GLB chunk header is truncated")
        size, type_ = struct.unpack_from("<II", payload, offset)
        offset += 8
        _require(size % 4 == 0 and offset + size <= len(payload), "GLB chunk length is invalid")
        chunks.append((type_, payload[offset:offset + size]))
        offset += size
    _require(chunks and chunks[0][0] == 0x4E4F534A, "GLB must start with its JSON chunk")
    _require(len(chunks) <= 2 and (len(chunks) == 1 or chunks[1][0] == 0x004E4942), "GLB contains unsupported chunks")
    _require(len(chunks[0][1]) <= 16 * 1024 * 1024, "GLB JSON chunk is too large")
    try:
        document = json.loads(chunks[0][1].decode("utf-8"))
        _require(isinstance(document, dict) and document.get("asset", {}).get("version") == "2.0", "GLB JSON must declare glTF 2.0")
        _check_glb_tree(document)
        binary = chunks[1][1] if len(chunks) == 2 else b""
        buffers = document.get("buffers", [])
        _require(isinstance(buffers, list), "GLB buffers must be a list")
        lengths = []
        for index, buffer in enumerate(buffers):
            size = buffer["byteLength"]
            _require(type(size) is int and size >= 0, "GLB buffer byteLength is invalid")
            embedded = _data_uri(buffer["uri"]) if "uri" in buffer else binary
            _require("uri" in buffer or index == 0, "GLB only its first buffer may use the BIN chunk")
            _require(len(embedded) >= size and len(embedded) - size <= 3, "GLB embedded buffer is truncated or inconsistent")
            lengths.append(size)
        views = document.get("bufferViews", [])
        _require(isinstance(views, list), "GLB bufferViews must be a list")
        for view in views:
            index, start, size = view["buffer"], view.get("byteOffset", 0), view["byteLength"]
            _require(type(index) is int and 0 <= index < len(lengths), "GLB bufferView references an unknown buffer")
            _require(type(start) is int and type(size) is int and start >= 0 and size >= 0 and start + size <= lengths[index],
                     "GLB bufferView escapes its embedded buffer")
        accessors = document.get("accessors", [])
        _require(isinstance(accessors, list), "GLB accessors must be a list")
        component_sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
        element_sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
        for accessor in accessors:
            count = accessor.get("count")
            _require(type(count) is int and 0 <= count <= 10_000_000, "GLB accessor count is invalid or excessive")
            _require(accessor.get("componentType") in component_sizes and accessor.get("type") in element_sizes,
                     "GLB accessor scalar/vector type is unsupported")
            element_size = component_sizes[accessor["componentType"]] * element_sizes[accessor["type"]]
            _require(count * element_size <= MAX_ASSET_BYTES, "GLB decoded accessor exceeds the size limit")
            offset = accessor.get("byteOffset", 0)
            _require(type(offset) is int and offset >= 0, "GLB accessor byteOffset is invalid")
            if "bufferView" in accessor:
                _require(type(accessor["bufferView"]) is int and 0 <= accessor["bufferView"] < len(views), "GLB accessor references an unknown bufferView")
                view = views[accessor["bufferView"]]
                stride = view.get("byteStride", element_size)
                _require(type(stride) is int and stride >= element_size, "GLB accessor byteStride is invalid")
                required = offset + ((count - 1) * stride + element_size if count else 0)
                _require(required <= view["byteLength"], "GLB accessor escapes its embedded bufferView")
        meshes = document.get("meshes", [])
        _require(isinstance(meshes, list) and meshes, "World GLB must contain a visual mesh")
        named = [mesh.get("name", "").lower() for mesh in meshes] + [node.get("name", "").lower() for node in document.get("nodes", []) if "mesh" in node]
        _require(not any(re.search(r"(?:^|[ _.-])(collider|collision)(?:[ _.-]|$)", name) for name in named),
                 "A collision mesh cannot be imported as a visual world")
        for container in (document.get("asset", {}), document, *meshes):
            extras = container.get("extras", {})
            if isinstance(extras, dict):
                _require(not any(str(extras.get(key, "")).lower() in ("collision", "collider", "collision-mesh")
                                 for key in ("role", "kind", "assetType", "type")), "A collision mesh cannot be imported as a visual world")
        has_positions = False
        for mesh in meshes:
            _require(isinstance(mesh.get("primitives"), list) and mesh["primitives"], "GLB mesh has no primitives")
            for primitive in mesh["primitives"]:
                index = primitive.get("attributes", {}).get("POSITION")
                _require(type(index) is int and 0 <= index < len(accessors), "GLB primitive has no valid POSITION accessor")
                has_positions = has_positions or accessors[index]["count"] > 0
        _require(has_positions, "World GLB visual mesh is empty")
        for image in document.get("images", []):
            _require(image.get("mimeType", "image/png") in ("image/png", "image/jpeg", "image/webp"), "GLB image media type is unsupported")
            if "bufferView" in image:
                _require(type(image["bufferView"]) is int and 0 <= image["bufferView"] < len(views), "GLB image references an unknown bufferView")
            else:
                _data_uri(image.get("uri"))
    except (KeyError, TypeError, AttributeError, IndexError, UnicodeError, json.JSONDecodeError, RecursionError, struct.error) as error:
        raise ValueError(f"Malformed self-contained GLB: {type(error).__name__}") from error
    return {"meshCount": len(meshes)}


def _validate_spz(payload):
    _require(payload.startswith(b"\x1f\x8b"), "SPZ must be a gzip-compressed NGSP file")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as handle:
            header = handle.read(16)
            _require(len(header) == 16, "SPZ header is truncated")
            magic, version, points, degree, fractional_bits, flags, reserved = struct.unpack("<III4B", header)
            _require(magic == 0x5053474E and version in (1, 2, 3), "SPZ NGSP magic or version is unsupported")
            _require(0 < points <= 10_000_000 and degree <= 3 and fractional_bits <= 24 and reserved == 0 and flags <= 3,
                     "SPZ point count or header fields are invalid")
            decoded = 16
            while block := handle.read(1024 * 1024):
                decoded += len(block)
                _require(decoded <= MAX_DECODED_SPZ_BYTES, "SPZ decompressed data exceeds the size limit")
            minimum = 16 + points * ((16 if version == 1 else 19) + 3 * degree * (degree + 2))
            _require(decoded >= minimum, "SPZ Gaussian data is truncated")
    except (OSError, EOFError, struct.error) as error:
        raise ValueError("SPZ compressed data or checksum is invalid") from error
    return {"pointCount": points, "spzVersion": version}


def _validate_ply(payload):
    boundary = payload.find(b"end_header\n", 0, 65536)
    terminator = len(b"end_header\n")
    if boundary < 0:
        boundary = payload.find(b"end_header\r\n", 0, 65536)
        terminator = len(b"end_header\r\n")
    _require(boundary >= 0, "Gaussian PLY header is missing or too large")
    try:
        lines = payload[:boundary].decode("ascii").splitlines()
        _require(lines and lines[0] == "ply", "Expected a Gaussian PLY file")
        _require(len(lines) >= 2 and lines[1] in ("format ascii 1.0", "format binary_little_endian 1.0"),
                 "Gaussian PLY must be ASCII or binary_little_endian 1.0")
        format_ = lines[1].split()[1]
        count, properties, current = None, [], None
        for line in lines[2:]:
            parts = line.split()
            if not parts or parts[0] in ("comment", "obj_info"):
                continue
            if parts[0] == "element":
                _require(len(parts) == 3, "Gaussian PLY element declaration is invalid")
                current = parts[1]
                amount = int(parts[2])
                _require(amount >= 0, "PLY element count must not be negative")
                if current == "vertex":
                    _require(count is None and 0 < amount <= 10_000_000, "Gaussian PLY vertex count is invalid")
                    count = amount
                else:
                    _require(amount == 0, "Gaussian PLY may not contain mesh/other element data")
            elif parts[0] == "property":
                _require(current == "vertex" and len(parts) == 3 and parts[1] in _PLY_TYPES,
                         "Gaussian PLY vertex properties must be supported scalar types")
                _require(parts[2] not in [name for _, name in properties], "Gaussian PLY property names must be unique")
                properties.append((parts[1], parts[2]))
            else:
                raise ValueError("Unexpected Gaussian PLY header declaration")
        _require(count is not None and _REQUIRED_GAUSSIAN <= {name for _, name in properties},
                 "PLY must contain Gaussian position, color, opacity, scale and rotation properties")
        _require(all(_PLY_TYPES[type_] in ("f", "d") for type_, name in properties if name in _REQUIRED_GAUSSIAN),
                 "Gaussian PLY properties must use floating-point scalar types")
        data = payload[boundary + terminator:]
        if format_ == "binary_little_endian":
            layout = "<" + "".join(_PLY_TYPES[type_] for type_, _ in properties)
            _require(len(data) == struct.calcsize(layout) * count, "Gaussian PLY vertex data is truncated or has unexpected trailing data")
            _require(all(all(math.isfinite(value) for value in row) for row in struct.iter_unpack(layout, data)),
                     "Gaussian PLY values must be finite")
        else:
            stream = io.BytesIO(data)
            for _ in range(count):
                fields = stream.readline().split()
                _require(len(fields) == len(properties), "Gaussian PLY ASCII vertex data is truncated or malformed")
                for field, (type_, _) in zip(fields, properties):
                    value = float(field) if _PLY_TYPES[type_] in ("f", "d") else int(field)
                    _require(math.isfinite(value), "Gaussian PLY values must be finite")
            _require(not stream.read().strip(), "Gaussian PLY contains unexpected trailing data")
    except (UnicodeError, struct.error, OverflowError) as error:
        raise ValueError("Gaussian PLY data is invalid") from error
    return {"pointCount": count}


def _validate_content(payload, format_, source_name=""):
    if format_ == "glb":
        return _validate_glb(payload, source_name)
    if format_ == "spz":
        return _validate_spz(payload)
    if format_ == "ply":
        return _validate_ply(payload)
    raise ValueError("World file must have a .glb, .spz or .ply suffix")


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _immutable_write(path, payload):
    """Create without replacing existing content; atomic concurrent imports agree."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        _require(path.is_file() and path.read_bytes() == payload, "Existing immutable library content does not match its address")
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=".import-", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            _require(path.read_bytes() == payload, "Concurrent immutable asset import has conflicting content")
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def import_world(source_path, library_root, *, name, provenance, source_up="Y", scale_to_meters=1, fixture=False,
                 translation_m=None, rotation_xyzw=None):
    """Import approved local bytes; this never calls a world-generation provider."""
    _require(isinstance(name, str) and 0 < len(name.strip()) <= 160, "World name must be 1 to 160 characters")
    validate_provenance(provenance)
    _require(type(fixture) is bool, "World fixture must be boolean")
    format_ = Path(source_path).suffix.lower().lstrip(".")
    payload = _read_asset(source_path)
    _validate_content(payload, format_, Path(source_path).name)
    digest = hashlib.sha256(payload).hexdigest()
    asset = {"path": f"assets/{digest}.{format_}", "sha256": digest, "format": format_,
             "sourceUp": source_up, "scaleToMeters": scale_to_meters,
             "translationM": copy.deepcopy([0, 0, 0] if translation_m is None else translation_m),
             "rotationXyzw": copy.deepcopy([0, 0, 0, 1] if rotation_xyzw is None else rotation_xyzw)}
    validate_asset_record(asset, kind="mesh" if format_ == "glb" else "splat")
    configuration = {"name": name.strip(), "provenance": copy.deepcopy(provenance), "asset": asset, "fixture": fixture}
    world_id = "world-" + hashlib.sha256(_canonical(configuration)).hexdigest()[:24]
    environment = {"revisionId": world_id, "kind": "mesh" if format_ == "glb" else "splat",
                   "displayName": name.strip(), "reviewStatus": "unreviewed", "asset": asset,
                   "worldColor": [0.18, 0.2, 0.18],
                   "plinth": {"id": "plinth", "sizeM": [0.25, 0.07, 0.2], "translationM": [0, -0.035, 0]},
                   "provenance": copy.deepcopy(provenance)}
    if fixture:
        environment["fixture"] = True
    entry = {"id": world_id, "name": name.strip(), "environment": environment}
    root = Path(library_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    asset_path = safe_asset_path(root, asset["path"])
    entry_path = safe_asset_path(root, f"worlds/{world_id}.json")
    _immutable_write(asset_path, payload)
    _immutable_write(entry_path, _canonical(entry) + b"\n")
    return entry


def list_worlds(library_root):
    root = Path(library_root).resolve()
    if not (root / "worlds").exists():
        return []
    entries = []
    for path in sorted((root / "worlds").glob("world-*.json")):
        _require(path.resolve().is_relative_to(root), "World library entry resolves outside library root")
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            _require(isinstance(entry, dict) and entry.get("id") == path.stem and isinstance(entry.get("name"), str),
                     "World library entry identity is invalid")
            env = entry["environment"]
            _require(env.get("revisionId") == entry["id"] and env.get("kind") in ("mesh", "splat"), "World library environment is invalid")
            validate_asset_record(env.get("asset"), kind=env["kind"])
            validate_provenance(env.get("provenance"))
            verify_scene_assets({"environment": env}, root)
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError(f"World library entry {path.name} is invalid") from error
        entries.append(entry)
    return entries


def verify_scene_assets(scene, source_dir):
    """Validate the bytes referenced by a scene without changing its document."""
    environment = scene["environment"]
    references = []
    if environment["kind"] != "authored":
        references.append((validate_asset_record(environment.get("asset"), kind=environment["kind"]), None))
    if "comparison" in scene:
        comparison = scene["comparison"]
        _require(isinstance(comparison, dict) and type(comparison.get("schemaVersion")) is int
                 and comparison["schemaVersion"] == 1, "Unsupported comparison schemaVersion")
        alternative = comparison.get("alternative")
        _require(environment["kind"] == "mesh" and isinstance(alternative, dict) and alternative.get("kind") == "mesh",
                 "Comparison assets must both be visual mesh environments")
        _require(not any(key in alternative for key in ("plinth", "props", "worldColor")),
                 "Comparison alternative must omit shared plinth, props and worldColor")
        references.append((validate_asset_record(alternative.get("asset"), kind="mesh"), None))
    for component in scene.get("product", {}).get("components", []):
        if component.get("shape") == "mesh":
            references.append((validate_product_asset_record(component.get("asset")), component))
    for prop in environment.get("props", []):
        if prop.get("shape") == "mesh":
            asset = validate_product_asset_record(prop.get("asset"))
            references.append((asset, {"sizeM": asset.get("sourceDimensionsM")}))
    from .material_assets import iter_material_assets, validate_png, validate_hdri_asset
    hdri = scene.get("lighting", {}).get("hdri")
    if hdri:
        references.append((validate_hdri_asset(hdri.get("asset")), "hdri"))
    references.extend((asset, "material-image") for asset in iter_material_assets(scene))
    from .film_images import validate_film_image_asset, verify_film_image
    references.extend((validate_film_image_asset(shot["image"]["asset"]), "film-image")
                      for shot in scene.get("shots", []) if shot.get("kind") == "image")
    records = {}
    for asset, component in references:
        path = safe_asset_path(source_dir, asset["path"])
        payload = _read_asset(path)
        _require(hashlib.sha256(payload).hexdigest() == asset["sha256"], "Asset hash does not match the immutable scene revision")
        if component == "film-image":
            metadata = verify_film_image(payload, asset)
        elif component == "material-image":
            metadata = validate_png(payload)
        elif component == "hdri":
            from .polyhaven import validate_hdri
            metadata = validate_hdri(payload)
        elif component is None:
            metadata = _validate_content(payload, asset["format"])
        else:
            from .products import inspect_product_glb, validate_product_dimensions, validate_product_material_nodes
            metadata = inspect_product_glb(payload)
            validate_product_dimensions(metadata, component["sizeM"])
            validate_product_material_nodes(component, payload)
        records[asset["path"]] = {"path": asset["path"], "sha256": asset["sha256"], "format": asset["format"],
                                   "bytes": len(payload), **metadata}
    return list(records.values())


def bundle_assets(scene, source_dir, destination_dir):
    """Verify and copy the scene's pinned assets, preserving relative paths."""
    records = verify_scene_assets(scene, source_dir)
    destination = Path(destination_dir).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for record in records:
        source = safe_asset_path(source_dir, record["path"])
        target = safe_asset_path(destination, record["path"])
        payload = _read_asset(source)
        _require(hashlib.sha256(payload).hexdigest() == record["sha256"], "World asset changed while bundling")
        _immutable_write(target, payload)
    return records
