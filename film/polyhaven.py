"""Poly Haven catalog and bounded, immutable local asset imports.

Only selected assets are downloaded. Source maps and GLTF material bindings stay
intact; a single parent translation centers imported prop geometry in metres.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .jobs import _atomic_json
from .material_assets import MAX_IMAGE_BYTES, validate_material_textures, validate_png
from .products import _IDENTITY, _accessor_rows, _multiply, _node_matrix, inspect_product_glb
from .store import now
from .worlds import _canonical, _data_uri, _immutable_write, _validate_glb, safe_asset_path

API_ROOT = "https://api.polyhaven.com"
KINDS = {"textures": 1, "models": 2, "hdris": 0}
CDN_HOSTS = {"dl.polyhaven.org", "dl.polyhaven.com", "cdn.polyhaven.org", "cdn.polyhaven.com"}
MAX_MODEL_BYTES = 128 * 1024 * 1024
MAX_HDR_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024 * 1024
CACHE_TTL = 6 * 60 * 60


class PolyHavenError(ValueError):
    """A provider or asset validation error safe to show in the editor."""


def _require(condition, message):
    if not condition:
        raise PolyHavenError(message)


def _asset_id(value):
    _require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", value),
             "Poly Haven asset ID is invalid")
    return value


def _kind(value):
    _require(isinstance(value, str) and value in KINDS, "Poly Haven kind must be textures, models, or hdris")
    return value


def _safe_url(url, *, api=False):
    _require(isinstance(url, str) and len(url) <= 4096, "Poly Haven URL is invalid")
    parsed = urllib.parse.urlsplit(url)
    try:
        port_ok = parsed.port in (None, 443)
    except ValueError:
        port_ok = False
    hosts = {"api.polyhaven.com"} if api else CDN_HOSTS
    _require(parsed.scheme == "https" and parsed.hostname in hosts and port_ok and
             not parsed.username and not parsed.password and not parsed.fragment,
             "Poly Haven downloads must stay on its HTTPS hosts")
    return url


class _Redirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, *, api=False):
        self.api = api

    def redirect_request(self, request, fp, code, message, headers, newurl):
        _safe_url(newurl, api=self.api)
        return super().redirect_request(request, fp, code, message, headers, newurl)


class PolyHavenClient:
    def __init__(self, *, opener=None, download_opener=None):
        self.opener = opener or urllib.request.build_opener(_Redirect(api=True))
        self.download_opener = download_opener or urllib.request.build_opener(_Redirect())

    def _read(self, url, limit, *, api=False, deadline=None):
        _safe_url(url, api=api)
        deadline = deadline or time.monotonic() + 45
        remaining = deadline - time.monotonic()
        _require(remaining > 0, "Poly Haven download timed out; retry the selected asset")
        request = urllib.request.Request(url, headers={"User-Agent": "GessoStudio/0.1", "Accept": "application/json" if api else "*/*"})
        opener = self.opener if api else self.download_opener
        try:
            with opener.open(request, timeout=min(30, remaining)) as response:
                _safe_url(response.geturl(), api=api)
                size = response.headers.get("Content-Length")
                _require(size is None or size.isdecimal() and int(size) <= limit,
                         "Poly Haven response exceeds the import size limit")
                chunks, total = [], 0
                while True:
                    _require(time.monotonic() < deadline, "Poly Haven download timed out; retry the selected asset")
                    chunk = response.read(min(65536, limit + 1 - total))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                    _require(total <= limit, "Poly Haven response exceeds the import size limit")
                return b"".join(chunks)
        except urllib.error.HTTPError as error:
            raise PolyHavenError(f"Poly Haven returned HTTP {error.code}; retry shortly.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise PolyHavenError("Could not reach Poly Haven. Existing local assets are still available.") from None

    def metadata(self, path):
        _require(path in {"/assets?t=" + kind for kind in KINDS} or re.fullmatch(r"/files/[A-Za-z0-9][A-Za-z0-9_-]{0,119}", path),
                 "Unsupported Poly Haven metadata endpoint")
        raw = self._read(API_ROOT + path, MAX_JSON_BYTES, api=True)
        try:
            document = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            raise PolyHavenError("Poly Haven returned invalid catalog metadata") from None
        _require(isinstance(document, dict), "Poly Haven catalog metadata must be an object")
        return document

    def download(self, record, *, max_bytes, deadline):
        _require(isinstance(record, dict), "Poly Haven file record is invalid")
        size, digest = record.get("size"), record.get("md5")
        _require(type(size) is int and 0 < size <= max_bytes, "Poly Haven asset exceeds the import size limit")
        _require(isinstance(digest, str) and re.fullmatch(r"[a-fA-F0-9]{32}", digest), "Poly Haven file has no valid checksum")
        payload = self._read(record.get("url"), size, deadline=deadline)
        _require(len(payload) == size, "Poly Haven download is incomplete")
        _require(hashlib.md5(payload, usedforsecurity=False).hexdigest() == digest.lower(), "Poly Haven download checksum does not match")
        return payload


def validate_hdri(payload):
    """Check a bounded Radiance RGBE image, including every scanline run."""
    _require(isinstance(payload, bytes) and 0 < len(payload) <= MAX_HDR_BYTES, "HDRI exceeds the 32 MiB limit")
    _require(payload.startswith((b"#?RADIANCE\n", b"#?RGBE\n")), "HDRI must be a Radiance RGBE image")
    end = payload.find(b"\n\n", 0, 16384)
    _require(end >= 0, "HDRI header is missing or too large")
    lines = payload[:end].splitlines()
    _require(lines.count(b"FORMAT=32-bit_rle_rgbe") == 1, "HDRI uses an unsupported pixel format")
    start = end + 2
    resolution_end = payload.find(b"\n", start, start + 128)
    _require(resolution_end >= 0, "HDRI has no resolution line")
    match = re.fullmatch(rb"-Y ([0-9]+) \+X ([0-9]+)", payload[start:resolution_end].strip())
    _require(match is not None, "HDRI must use standard -Y +X image orientation")
    height, width = map(int, match.groups())
    _require(0 < width <= 4096 and 0 < height <= 2048 and width * height <= 4096 * 2048,
             "HDRI dimensions exceed 4096 × 2048")
    offset = resolution_end + 1
    if width < 8 or width > 32767 or payload[offset:offset+2] != b"\x02\x02":
        _require(len(payload) - offset == width * height * 4, "HDRI uncompressed pixels are truncated")
        # Legacy run markers are unsupported rather than trusted as raw pixels.
        _require(not any(payload[index:index+3] == b"\x01\x01\x01" for index in range(offset, len(payload), 4)),
                 "HDRI uses unsupported legacy RGBE runs")
        return {"width": width, "height": height}
    for _ in range(height):
        _require(offset + 4 <= len(payload) and payload[offset:offset+2] == b"\x02\x02" and
                 int.from_bytes(payload[offset+2:offset+4], "big") == width, "HDRI scanline header is invalid")
        offset += 4
        for _ in range(4):
            count = 0
            while count < width:
                _require(offset < len(payload), "HDRI scanline is truncated")
                code = payload[offset]
                offset += 1
                length = code - 128 if code > 128 else code
                _require(length > 0 and count + length <= width, "HDRI scanline run escapes its row")
                consumed = 1 if code > 128 else length
                _require(offset + consumed <= len(payload), "HDRI scanline pixels are truncated")
                offset += consumed
                count += length
    _require(offset == len(payload), "HDRI has trailing or inconsistent pixel data")
    return {"width": width, "height": height}


def _validate_jpeg(data):
    _require(data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9"), "Poly Haven JPEG is incomplete")
    offset = 2
    while offset < len(data):
        _require(data[offset] == 255, "Poly Haven JPEG marker is invalid")
        while offset < len(data) and data[offset] == 255:
            offset += 1
        _require(offset < len(data), "Poly Haven JPEG is truncated")
        marker = data[offset]
        offset += 1
        if marker in (0xd8, 0x01) or 0xd0 <= marker <= 0xd7:
            continue
        _require(marker not in (0xd9, 0xda) and offset+2 <= len(data), "Poly Haven JPEG has no valid dimensions")
        length = int.from_bytes(data[offset:offset+2], "big")
        _require(length >= 2 and offset+length <= len(data), "Poly Haven JPEG segment is truncated")
        if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
            _require(length >= 8, "Poly Haven JPEG dimensions are truncated")
            height = int.from_bytes(data[offset+3:offset+5], "big")
            width = int.from_bytes(data[offset+5:offset+7], "big")
            _require(0 < width <= 4096 and 0 < height <= 4096, "Poly Haven JPEG exceeds 4096 pixels per side")
            return
        offset += length
    raise PolyHavenError("Poly Haven JPEG has no valid dimensions")


def _relative_uri(uri):
    _require(isinstance(uri, str) and len(uri) <= 512 and "\\" not in uri and "\x00" not in uri,
             "GLTF dependency path is invalid")
    parsed = urllib.parse.urlsplit(uri)
    decoded = urllib.parse.unquote(parsed.path)
    _require(not parsed.scheme and not parsed.netloc and not parsed.query and not parsed.fragment and
             not decoded.startswith("/") and "\\" not in decoded and "\x00" not in decoded and
             all(part not in ("", ".", "..") for part in decoded.split("/")),
             "GLTF dependencies must be declared relative files")
    return str(PurePosixPath(decoded))


def _glb(document, binary):
    data = _canonical(document)
    data += b" " * (-len(data) % 4)
    padded = bytes(binary) + b"\0" * (-len(binary) % 4)
    return (struct.pack("<4sII", b"glTF", 2, 12+8+len(data)+8+len(padded)) +
            struct.pack("<I4s", len(data), b"JSON") + data + struct.pack("<I4s", len(padded), b"BIN\0") + padded)


def _measure_bounds(document, binary):
    nodes, scenes = document.get("nodes", []), document.get("scenes", [])
    _require(isinstance(nodes, list) and 0 < len(nodes) <= 100000 and len(scenes) == 1 and document.get("scene", 0) == 0,
             "Poly Haven model must declare one bounded active scene")
    minimum, maximum, seen, vertex_count = [math.inf]*3, [-math.inf]*3, set(), 0

    def visit(index, parent, depth=0):
        nonlocal vertex_count
        _require(type(index) is int and 0 <= index < len(nodes) and index not in seen and depth <= 80,
                 "Poly Haven model has an invalid node hierarchy")
        seen.add(index)
        node = nodes[index]
        matrix = _multiply(parent, _node_matrix(node))
        if "mesh" in node:
            mesh_index = node["mesh"]
            _require(type(mesh_index) is int and 0 <= mesh_index < len(document["meshes"]), "Poly Haven model references an unknown mesh")
            for primitive in document["meshes"][mesh_index]["primitives"]:
                accessor = primitive["attributes"]["POSITION"]
                vertex_count += document["accessors"][accessor]["count"]
                _require(vertex_count <= 10000000, "Poly Haven model exceeds the vertex limit")
                for point in _accessor_rows(document, [binary], accessor, positions=True):
                    for axis in range(3):
                        value = sum(matrix[axis][column] * point[column] for column in range(3)) + matrix[axis][3]
                        _require(math.isfinite(value), "Poly Haven model has nonfinite positions")
                        minimum[axis] = min(minimum[axis], value)
                        maximum[axis] = max(maximum[axis], value)
        for child in node.get("children", []):
            visit(child, matrix, depth + 1)

    roots = scenes[0].get("nodes", [])
    _require(isinstance(roots, list) and roots, "Poly Haven model has no visible geometry")
    for index in roots:
        visit(index, _IDENTITY)
    _require(all(1e-8 < high-low <= 1000 for low, high in zip(minimum, maximum)),
             "Poly Haven model must have three-dimensional bounds within 1000 metres")
    return minimum, maximum


def pack_gltf(payload, dependencies):
    """Embed only declared GLTF dependencies and center the unchanged hierarchy."""
    _require(isinstance(payload, bytes) and len(payload) <= MAX_JSON_BYTES, "Poly Haven GLTF is too large")
    try:
        document = json.loads(payload)
        _require(isinstance(document, dict) and document.get("asset", {}).get("version") == "2.0", "Poly Haven model must use GLTF 2.0")
        document = copy.deepcopy(document)
        binary, buffer_offsets, buffer_lengths = bytearray(), [], []

        def append_bytes(data):
            _require(isinstance(data, bytes) and len(binary) + len(data) + 3 <= MAX_MODEL_BYTES, "Poly Haven model exceeds 128 MiB")
            binary.extend(b"\0" * (-len(binary) % 4))
            offset = len(binary)
            binary.extend(data)
            return offset

        def dependency(uri):
            if isinstance(uri, str) and uri.startswith("data:"):
                return _data_uri(uri)
            key = _relative_uri(uri)
            _require(key in dependencies, "Poly Haven GLTF references an undeclared dependency")
            return dependencies[key]

        for buffer in document.get("buffers", []):
            data = dependency(buffer.get("uri"))
            length = buffer.get("byteLength")
            _require(type(length) is int and length >= 0 and 0 <= len(data)-length <= 3, "Poly Haven GLTF buffer length is inconsistent")
            buffer_offsets.append(append_bytes(data[:length]))
            buffer_lengths.append(length)
        views = document.setdefault("bufferViews", [])
        _require(isinstance(views, list), "Poly Haven GLTF buffer views are invalid")
        for view in views:
            original = view.get("buffer")
            _require(type(original) is int and 0 <= original < len(buffer_offsets), "Poly Haven GLTF references an unknown buffer")
            start, length = view.get("byteOffset", 0), view.get("byteLength")
            _require(type(start) is int and type(length) is int and start >= 0 and length >= 0 and start+length <= buffer_lengths[original],
                     "Poly Haven GLTF view escapes its source buffer")
            view["byteOffset"] = start + buffer_offsets[original]
            view["buffer"] = 0
        for image in document.get("images", []):
            if "uri" not in image:
                continue
            data = dependency(image["uri"])
            _require(0 < len(data) <= MAX_IMAGE_BYTES, "Poly Haven model texture exceeds 16 MiB")
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                validate_png(data)
                mime = "image/png"
            elif data.startswith(b"\xff\xd8\xff"):
                _validate_jpeg(data)
                mime = "image/jpeg"
            else:
                raise PolyHavenError("Poly Haven model textures must use PNG or JPEG")
            start = append_bytes(data)
            image.pop("uri")
            image["mimeType"] = mime
            image["bufferView"] = len(views)
            views.append({"buffer": 0, "byteOffset": start, "byteLength": len(data)})
        document["buffers"] = [{"byteLength": len(binary)}]
        _validate_glb(_glb(document, binary))
        minimum, maximum = _measure_bounds(document, bytes(binary))
        translation = [-(low+high)/2 for low, high in zip(minimum, maximum)]
        roots = document["scenes"][0]["nodes"]
        document["scenes"][0]["nodes"] = [len(document["nodes"])]
        document["nodes"].append({"name": "Poly Haven bounds origin", "translation": translation, "children": roots})
        result = _glb(document, binary)
        metadata = inspect_product_glb(result)
        return result, metadata
    except (KeyError, TypeError, AttributeError, IndexError, UnicodeError, json.JSONDecodeError, OverflowError, RecursionError, struct.error) as error:
        raise PolyHavenError(f"Poly Haven GLTF is malformed ({type(error).__name__})") from None


class PolyHavenLibrary:
    def __init__(self, root, *, material_library=None, client=None, cache_ttl=CACHE_TTL):
        self.root = Path(root)
        self.directory = self.root / "polyhaven"
        self.cache = self.directory / "cache"
        self.entries = self.directory / "entries"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.entries.mkdir(exist_ok=True)
        self.client = client or PolyHavenClient()
        self.material_library = material_library
        self.cache_ttl = cache_ttl
        self.lock = threading.RLock()

    def _metadata(self, key, path):
        with self.lock:
            cache_path = self.cache / (key + ".json")
            saved = None
            if cache_path.is_file():
                try:
                    saved = json.loads(cache_path.read_text())
                    _require(isinstance(saved.get("data"), dict) and type(saved.get("fetchedAt")) in (int, float), "Invalid catalog cache")
                    if time.time() - saved["fetchedAt"] < self.cache_ttl:
                        return saved["data"], False
                except (OSError, ValueError, TypeError, AttributeError):
                    saved = None
            try:
                data = self.client.metadata(path)
            except PolyHavenError:
                if saved:
                    return saved["data"], True
                raise
            _atomic_json(cache_path, {"fetchedAt": time.time(), "data": data})
            return data, False

    def list_assets(self, kind, query="", offset=0, limit=24):
        kind = _kind(kind)
        _require(isinstance(query, str) and len(query) <= 200, "Poly Haven search must contain at most 200 characters")
        _require(type(offset) is int and 0 <= offset <= 100000 and type(limit) is int and 1 <= limit <= 48,
                 "Poly Haven pagination is invalid")
        data, stale = self._metadata("catalog-"+kind, "/assets?t="+kind)
        words = query.casefold().split()
        assets = []
        for asset_id, metadata in data.items():
            if not isinstance(metadata, dict) or metadata.get("type") != KINDS[kind] or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", asset_id):
                continue
            name = str(metadata.get("name", asset_id))[:120]
            tags = [str(tag)[:80] for tag in metadata.get("tags", [])[:60]]
            categories = [str(category)[:80] for category in metadata.get("categories", [])[:30]]
            searchable = " ".join([asset_id, name, *tags, *categories]).casefold()
            if any(word not in searchable for word in words):
                continue
            thumbnail = metadata.get("thumbnail_url")
            try:
                _safe_url(thumbnail)
            except PolyHavenError:
                thumbnail = f"https://cdn.polyhaven.com/asset_img/thumbs/{asset_id}.png?width=256&height=256&format=webp"
            assets.append({"id": asset_id, "name": name, "kind": kind, "tags": tags, "categories": categories,
                           "thumbnailUrl": thumbnail, "sourceUrl": "https://polyhaven.com/a/"+asset_id,
                           "downloaded": (self.entries/(kind+"-"+asset_id+".json")).is_file()})
        assets.sort(key=lambda entry: (entry["name"].casefold(), entry["id"]))
        return {"assets": assets[offset:offset+limit], "total": len(assets), "offset": offset,
                "hasMore": offset+limit < len(assets), "stale": stale}

    def _record(self, files, names, format_):
        for name in names:
            formats = files.get(name)
            if not isinstance(formats, dict):
                continue
            resolution = formats.get("1k")
            value = resolution.get(format_) if isinstance(resolution, dict) else None
            if isinstance(value, dict):
                return value
        return None

    def _save_asset(self, payload, format_):
        digest = hashlib.sha256(payload).hexdigest()
        asset = {"path": f"assets/{digest}.{format_}", "sha256": digest, "format": format_}
        _immutable_write(safe_asset_path(self.root, asset["path"]), payload)
        return asset

    def _entry_available(self, entry):
        assets = list(entry.get("material", {}).get("textures", {}).values()) if "material" in entry else [entry.get("asset")]
        for asset in assets:
            if not isinstance(asset, dict):
                return False
            path = safe_asset_path(self.root, asset["path"])
            if not path.is_file():
                return False
            _require(hashlib.sha256(path.read_bytes()).hexdigest() == asset.get("sha256"),
                     "A local Poly Haven asset changed after import. Restore or remove the changed file before importing it again.")
        return bool(assets)

    def import_asset(self, kind, asset_id):
        kind, asset_id = _kind(kind), _asset_id(asset_id)
        with self.lock:
            entry_path = self.entries/(kind+"-"+asset_id+".json")
            if entry_path.is_file():
                entry = json.loads(entry_path.read_text())
                if self._entry_available(entry):
                    return {"kind": kind, "entry": entry}
            catalog, _ = self._metadata("catalog-"+kind, "/assets?t="+kind)
            metadata = catalog.get(asset_id)
            _require(isinstance(metadata, dict) and metadata.get("type") == KINDS[kind], "Poly Haven asset was not found in this library")
            files, _ = self._metadata("files-"+asset_id, "/files/"+asset_id)
            entry = {"id": hashlib.sha256(("polyhaven:"+kind+":"+asset_id).encode()).hexdigest()[:32],
                     "name": str(metadata.get("name", asset_id))[:120], "provider": "polyhaven", "sourceId": asset_id,
                     "sourceUrl": "https://polyhaven.com/a/"+asset_id, "createdAt": now(), "resolution": "1k"}
            deadline = time.monotonic() + 120
            if kind == "textures":
                channels = {"basecolor": ("Diffuse", "diffuse", "diff", "Albedo", "albedo"), "normal": ("nor_gl",),
                            "roughness": ("Rough", "Roughness", "rough"), "metalness": ("Metal", "Metallic", "metal"),
                            "height": ("Displacement", "displacement", "disp")}
                textures, payloads = {}, {}
                for channel, names in channels.items():
                    record = self._record(files, names, "png")
                    if record is None:
                        continue
                    payload = self.client.download(record, max_bytes=MAX_IMAGE_BYTES, deadline=deadline)
                    validate_png(payload)
                    payloads[channel] = payload
                _require("basecolor" in payloads, "This Poly Haven material has no supported 1k PNG base color")
                for channel, payload in payloads.items():
                    textures[channel] = self._save_asset(payload, "png")
                material = {"name": entry["name"], "baseColor": [1, 1, 1, 1], "roughness": 1 if "roughness" in textures else .5,
                            "metallic": 1 if "metalness" in textures else 0, "transmission": 0, "ior": 1.5,
                            "textures": textures, "textureRepeat": [1, 1], "normalScale": 1, "heightScaleM": 0}
                validate_material_textures(material)
                entry["material"] = material
                if self.material_library:
                    self.material_library.add_entry(entry)
                else:
                    directory = self.root/"materials"/"entries"
                    directory.mkdir(parents=True, exist_ok=True)
                    _atomic_json(directory/(entry["id"]+".json"), entry)
            elif kind == "hdris":
                record = self._record(files, ("hdri",), "hdr")
                _require(record is not None, "This Poly Haven light has no supported 1k HDR image")
                payload = self.client.download(record, max_bytes=MAX_HDR_BYTES, deadline=deadline)
                dimensions = validate_hdri(payload)
                entry.update(asset=self._save_asset(payload, "hdr"), dimensionsPx=[dimensions["width"], dimensions["height"]])
            else:
                record = self._record(files, ("gltf",), "gltf")
                _require(record is not None, "This Poly Haven prop has no supported 1k GLTF")
                payload = self.client.download(record, max_bytes=MAX_JSON_BYTES, deadline=deadline)
                try:
                    document = json.loads(payload)
                except (UnicodeError, json.JSONDecodeError):
                    raise PolyHavenError("Poly Haven returned invalid GLTF JSON") from None
                _require(isinstance(document, dict), "Poly Haven GLTF must be an object")
                included = record.get("include", {})
                _require(isinstance(included, dict) and len(included) <= 64, "Poly Haven prop has too many dependencies")
                declared = {_relative_uri(path): value for path, value in included.items()}
                requested = { _relative_uri(item["uri"]) for item in [*document.get("buffers", []), *document.get("images", [])]
                              if "uri" in item and not str(item["uri"]).startswith("data:") }
                _require(requested.issubset(declared), "Poly Haven GLTF references an undeclared dependency")
                total, dependencies = len(payload), {}
                for path in sorted(requested):
                    data = self.client.download(declared[path], max_bytes=min(MAX_MODEL_BYTES-total, MAX_MODEL_BYTES), deadline=deadline)
                    total += len(data)
                    _require(total <= MAX_MODEL_BYTES, "Poly Haven model exceeds 128 MiB")
                    dependencies[path] = data
                packed, measured = pack_gltf(payload, dependencies)
                asset = self._save_asset(packed, "glb")
                asset.update(sourceUp="Y", sourceDimensionsM=measured["dimensionsM"])
                entry.update(asset=asset, sizeM=measured["dimensionsM"])
            _atomic_json(entry_path, entry)
            return {"kind": kind, "entry": entry}
