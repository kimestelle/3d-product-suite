"""Convert bounded local polygon meshes to the existing normalized GLB handoff.

Only OBJ, STL and polygon PLY are accepted. Files are copied into an isolated
working directory; references to OBJ material libraries or other files are
rejected rather than silently losing artwork or reading arbitrary local files.
This is a local Blender conversion, not CAD tessellation or Gaussian meshing.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile

from .products import inspect_product_glb
from .worlds import _require

MESH_FORMATS = (".obj", ".stl", ".ply")
UNIT_SCALES = {"m": 1.0, "cm": 0.01, "mm": 0.001, "in": 0.0254, "ft": 0.3048}
BLENDER_VERSION = "4.3.2"
MAX_SOURCE_BYTES = 128 * 1024 * 1024
MAX_VERTICES = 10_000_000
CONVERSION_TIMEOUT = 120
_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "blender_import_product.py"
_DEPENDENCIES = ("OBJ material libraries and external file references are not supported. "
                 "Export a self-contained GLB with embedded textures to preserve materials.")
_PLY_TYPES = {
    "char": ("b", int), "int8": ("b", int), "uchar": ("B", int), "uint8": ("B", int),
    "short": ("h", int), "int16": ("h", int), "ushort": ("H", int), "uint16": ("H", int),
    "int": ("i", int), "int32": ("i", int), "uint": ("I", int), "uint32": ("I", int),
    "float": ("f", float), "float32": ("f", float), "double": ("d", float), "float64": ("d", float),
}


def _finite(values, label):
    _require(all(math.isfinite(value) for value in values), f"Mesh {label} must contain finite numbers")


def _obj_preflight(payload):
    vertices, triangles, normals, texcoords = 0, 0, 0, 0
    try:
        for number, line in enumerate(io.BytesIO(payload), 1):
            _require(len(line) <= 1024 * 1024, "OBJ line exceeds the 1 MiB limit")
            fields = line.decode("utf-8-sig" if number == 1 else "utf-8").partition("#")[0].split()
            if not fields:
                continue
            kind, values = fields[0], fields[1:]
            _require(kind not in {"mtllib", "usemtl", "maplib", "usemap", "call", "csh", "shadow_obj", "trace_obj"},
                     _DEPENDENCIES)
            if kind in ("v", "vn", "vt"):
                lengths = {"v": (3, 4, 6, 7), "vn": (3,), "vt": (1, 2, 3)}[kind]
                _require(len(values) in lengths, f"Malformed OBJ {kind} at line {number}")
                _finite([float(value) for value in values], f"OBJ {kind}")
                if kind == "v":
                    vertices += 1
                    _require(vertices <= MAX_VERTICES, "Mesh exceeds the 10 million vertex limit")
                elif kind == "vn":
                    normals += 1
                else:
                    texcoords += 1
            elif kind == "f":
                _require(3 <= len(values) <= 65536, f"OBJ faces must have 3 to 65536 vertices (line {number})")
                for value in values:
                    indices = value.split("/")
                    _require(1 <= len(indices) <= 3 and indices[0], f"Malformed OBJ face at line {number}")
                    index = int(indices[0])
                    _require(index != 0 and -vertices <= index <= vertices,
                             f"OBJ face references an unknown vertex at line {number}")
                    for item, count in zip(indices[1:], (texcoords, normals)):
                        _require(not item or (int(item) != 0 and -count <= int(item) <= count),
                                 f"OBJ face references an unknown texture/normal at line {number}")
                triangles += len(values) - 2
                _require(triangles * 3 <= MAX_VERTICES, "Triangulated mesh exceeds the 10 million vertex limit")
            else:
                _require(kind in ("o", "g", "s"),
                         f"Unsupported OBJ statement {kind!r}; export a polygon mesh with faces or an embedded GLB")
    except (UnicodeError, OverflowError, ValueError) as error:
        if isinstance(error, ValueError) and not isinstance(error, UnicodeError) and not str(error).startswith(("could not convert", "invalid literal")):
            raise
        raise ValueError("Malformed OBJ mesh; export a valid polygon mesh") from error
    _require(vertices > 0 and triangles > 0, "Mesh must contain polygon faces; point clouds and curves are not product meshes")


def _stl_preflight(payload):
    if len(payload) >= 84:
        count = struct.unpack_from("<I", payload, 80)[0]
        if len(payload) == 84 + 50 * count:
            _require(0 < count and count * 3 <= MAX_VERTICES, "STL must contain bounded, nonempty triangle geometry")
            for row in struct.iter_unpack("<12fH", payload[84:]):
                _finite(row[:12], "STL coordinates and normals")
            return
    try:
        lines = iter(line.strip().split() for line in payload.decode("ascii").splitlines() if line.strip())
        first = next(lines)
        _require(first[0] == "solid", "Malformed STL header")
        count = 0
        for fields in lines:
            if fields[0] == "endsolid":
                _require(next(lines, None) is None, "Unexpected data after STL endsolid")
                _require(count > 0, "STL must contain nonempty triangle geometry")
                return
            _require(fields[:2] == ["facet", "normal"] and len(fields) == 5, "Malformed STL facet")
            _finite([float(value) for value in fields[2:]], "STL normal")
            _require(next(lines) == ["outer", "loop"], "Malformed STL outer loop")
            for _ in range(3):
                vertex = next(lines)
                _require(len(vertex) == 4 and vertex[0] == "vertex", "Malformed STL vertex")
                _finite([float(value) for value in vertex[1:]], "STL vertex")
            _require(next(lines) == ["endloop"] and next(lines) == ["endfacet"], "Malformed STL facet terminator")
            count += 1
            _require(count * 3 <= MAX_VERTICES, "Mesh exceeds the 10 million vertex limit")
    except (UnicodeError, StopIteration, IndexError, OverflowError) as error:
        raise ValueError("Malformed STL mesh") from error
    raise ValueError("Malformed STL mesh: missing endsolid")


def _ply_preflight(payload):
    """Read bounded scalar/list PLY records before Blender can repair bad input."""
    stream = io.BytesIO(payload)
    _require(stream.readline() in (b"ply\n", b"ply\r\n"), "Malformed PLY header")
    elements, format_, current, header_size = [], None, None, 4
    while True:
        line = stream.readline(65537)
        header_size += len(line)
        _require(line and header_size <= 65536, "PLY header exceeds the 64 KiB limit or is incomplete")
        try:
            words = line.decode("ascii").split()
        except UnicodeError as error:
            raise ValueError("Malformed PLY header") from error
        if not words or words[0] in ("comment", "obj_info"):
            continue
        if words == ["end_header"]:
            break
        if words[0] == "format":
            _require(len(words) == 3 and words[2] == "1.0" and format_ is None
                     and words[1] in ("ascii", "binary_little_endian", "binary_big_endian"), "Unsupported PLY format")
            format_ = words[1]
        elif words[0] == "element":
            _require(len(words) == 3 and words[1] in ("vertex", "face")
                     and words[1] not in [item[0] for item in elements], "PLY must contain only vertex and face elements")
            count = int(words[2])
            _require(0 <= count <= MAX_VERTICES, "PLY element exceeds the 10 million vertex/face limit")
            current = (words[1], count, [])
            elements.append(current)
        elif words[0] == "property":
            _require(current is not None and len(current[2]) < 128, "Malformed or excessive PLY properties")
            if len(words) == 3:
                _require(words[1] in _PLY_TYPES, "Unsupported PLY scalar type")
                specification = (words[2], None, words[1])
            else:
                _require(len(words) == 5 and words[1] == "list" and words[2] in _PLY_TYPES
                         and _PLY_TYPES[words[2]][1] is int and words[3] in _PLY_TYPES,
                         "Unsupported PLY list type")
                specification = (words[4], words[2], words[3])
            _require(specification[0] not in [item[0] for item in current[2]], "Duplicate PLY property")
            current[2].append(specification)
        else:
            raise ValueError("Malformed PLY header statement")
    _require(format_ is not None and [item[0] for item in elements] == ["vertex", "face"],
             "PLY must contain polygon faces; point clouds and Gaussian splats need world reconstruction")
    vertices, faces = elements
    _require(vertices[1] > 0 and faces[1] > 0, "PLY must contain nonempty polygon faces, not a point cloud")
    _require(all(any(name == axis and count_type is None for name, count_type, _ in vertices[2])
                 for axis in ("x", "y", "z")), "PLY vertices must declare x, y, z coordinates")
    index_properties = [item for item in faces[2] if item[0] in ("vertex_indices", "vertex_index")]
    _require(len(index_properties) == 1 and index_properties[0][1] is not None
             and _PLY_TYPES[index_properties[0][2]][1] is int, "PLY faces must declare integer vertex_indices")
    triangles = 0
    endian = "<" if format_ == "binary_little_endian" else ">"

    def binary_value(type_):
        decoder = struct.Struct(endian + _PLY_TYPES[type_][0])
        raw = stream.read(decoder.size)
        _require(len(raw) == decoder.size, "Truncated PLY data")
        value = decoder.unpack(raw)[0]
        _finite((value,), "PLY values")
        return value

    for kind, count, properties in elements:
        for _ in range(count):
            if format_ == "ascii":
                raw = stream.readline(1024 * 1024 + 1)
                _require(len(raw) <= 1024 * 1024 and raw, "Truncated or excessive PLY row")
                try:
                    tokens = iter(raw.decode("ascii").split())
                except UnicodeError as error:
                    raise ValueError("Malformed ASCII PLY row") from error

                def read(type_):
                    try:
                        value = _PLY_TYPES[type_][1](next(tokens))
                    except StopIteration as error:
                        raise ValueError("Truncated PLY row") from error
                    _finite((value,), "PLY values")
                    code = _PLY_TYPES[type_][0]
                    if _PLY_TYPES[type_][1] is int:
                        bits = struct.calcsize(code) * 8
                        low, high = (0, 2 ** bits - 1) if code.isupper() else (-2 ** (bits - 1), 2 ** (bits - 1) - 1)
                        _require(low <= value <= high, "PLY integer exceeds its declared type")
                    return value
            else:
                read = binary_value
            for name, count_type, type_ in properties:
                if count_type is None:
                    read(type_)
                    continue
                length = read(count_type)
                _require(0 <= length <= 65536, "PLY list exceeds the 65536 item limit")
                face_indices = kind == "face" and name == index_properties[0][0]
                if face_indices:
                    _require(length >= 3, "PLY faces must contain at least three vertices")
                    triangles += length - 2
                    _require(triangles * 3 <= MAX_VERTICES, "Triangulated mesh exceeds the 10 million vertex limit")
                for _ in range(length):
                    value = read(type_)
                    if face_indices:
                        _require(0 <= value < vertices[1], "PLY face references an unknown vertex")
            if format_ == "ascii":
                _require(next(tokens, None) is None, "Unexpected values in PLY row")
    _require(not stream.read().strip() if format_ == "ascii" else not stream.read(), "Unexpected trailing PLY data")


def _preflight(payload, suffix):
    _require(0 < len(payload) <= MAX_SOURCE_BYTES, "Mesh source must contain 1 byte to 128 MiB")
    try:
        {".obj": _obj_preflight, ".stl": _stl_preflight, ".ply": _ply_preflight}[suffix](payload)
    except (UnicodeError, OverflowError, struct.error) as error:
        raise ValueError(f"Malformed {suffix[1:].upper()} mesh") from error


def _blender_version(blender):
    try:
        result = subprocess.run([str(blender), "--version"], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, check=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Cannot run Blender; install pinned Blender 4.3.2 or import an embedded GLB") from error
    _require(re.search(r"Blender\s+" + re.escape(BLENDER_VERSION) + r"(?=[\s-]|$)", result.stdout) is not None,
             "Mesh imports require Blender 4.3.2")


def prepare_product_mesh(source_path, output_path, *, source_up="Y", units="m", blender="blender"):
    """Write one normalized, self-contained GLB and return conversion metadata.

    ``source_up`` explicitly declares Y or Z; ``units`` is m, cm, mm, in or ft.
    Actual face-used bounds are centered, preserving relative object placement.
    Existing destinations are refused, and failed conversions leave no output.
    STL loses materials/colors by format; PLY preserves vertex colors where
    present but has no standard PBR material/texture representation. OBJ files
    with sidecars must first be exported as a self-contained embedded GLB.
    """
    _require(source_up in ("Y", "Z"), "source_up must be Y or Z")
    _require(units in UNIT_SCALES, "units must be m, cm, mm, in or ft")
    # A caller-provided relative executable must retain its meaning after the
    # worker changes into its isolated directory. Bare names still use PATH.
    blender = str(Path(blender).expanduser().resolve()) if os.sep in str(blender) else str(blender)
    source, output = Path(source_path).expanduser().resolve(), Path(output_path).expanduser().absolute()
    _require(source.suffix.lower() in MESH_FORMATS, "Mesh imports support .obj, .stl and .ply; use the existing GLB handoff for .glb")
    _require(output.suffix.lower() == ".glb", "Mesh output must use a .glb filename")
    _require(not output.exists() and not output.is_symlink(), "Mesh output already exists; choose a new output path")
    _require(source.is_file(), "Mesh source must be a local file")
    _require(source.stat().st_size <= MAX_SOURCE_BYTES, "Mesh source exceeds the 128 MiB limit")
    with source.open("rb") as handle:
        payload = handle.read(MAX_SOURCE_BYTES + 1)
    _preflight(payload, source.suffix.lower())
    _blender_version(blender)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".mesh-import-", dir=output.parent) as temporary:
        workspace = Path(temporary)
        copied = workspace / ("source" + source.suffix.lower())
        copied.write_bytes(payload)
        converted, report = workspace / "converted.glb", workspace / "normalization.json"
        command = [str(blender), "--background", "--factory-startup", "--disable-autoexec",
                   "--python-exit-code", "1", "--python", str(_SCRIPT), "--",
                   "--input", str(copied), "--output", str(converted), "--report", str(report),
                   "--source-up", source_up, "--units", units]
        try:
            with (workspace / "blender.log").open("wb") as log:
                result = subprocess.run(command, cwd=workspace, stdout=log, stderr=subprocess.STDOUT,
                                        timeout=CONVERSION_TIMEOUT, check=False)
        except subprocess.TimeoutExpired as error:
            raise ValueError("Mesh conversion exceeded the 120 second limit; simplify the mesh or import an embedded GLB") from error
        except OSError as error:
            raise ValueError("Cannot run Blender mesh conversion") from error
        if result.returncode:
            with (workspace / "blender.log").open("rb") as log:
                log.seek(max(0, log.seek(0, 2) - 4000))
                tail = log.read().decode("utf-8", errors="replace")
            raise ValueError("Blender could not convert this polygon mesh: " + tail)
        _require(converted.is_file() and report.is_file(), "Blender did not produce a mesh and normalization report")
        _require(converted.stat().st_size <= MAX_SOURCE_BYTES, "Converted GLB exceeds the 128 MiB limit")
        prepared = converted.read_bytes()
        measured = inspect_product_glb(prepared)
        _require(report.stat().st_size <= 65536, "Mesh normalization report exceeds its limit")
        try:
            normalization = json.loads(report.read_text(encoding="utf-8"))
            _require(isinstance(normalization, dict), "Mesh normalization report must be an object")
            _require(normalization.get("scaleToMeters") == UNIT_SCALES[units], "Mesh conversion used incorrect units")
            center = normalization["centerSourceUnits"]
            _require(isinstance(center, list) and len(center) == 3 and all(type(value) in (int, float) and math.isfinite(value) for value in center),
                     "Mesh normalization center must contain three finite numbers")
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("Malformed mesh normalization report") from error
        limitations = {
            ".obj": ["OBJ polygon geometry and vertex colors are preserved; external MTL/textures are not accepted. Export embedded GLB for material artwork."],
            ".stl": ["STL contains triangle geometry only; materials, textures, assemblies and nonstandard binary STL colors are not imported."],
            ".ply": ["PLY polygon geometry and vertex colors are preserved where present; PLY has no standard PBR materials or texture representation."],
        }[source.suffix.lower()]
        metadata = {**measured, "sourceSha256": hashlib.sha256(payload).hexdigest(),
                    "sourceFormat": source.suffix.lower()[1:], "sourceExtension": source.suffix.lower(),
                    "sourceUp": source_up, "units": units, "outputSourceUp": "Y", "outputUnits": "m",
                    "normalization": normalization, "converter": {"name": "Blender", "version": BLENDER_VERSION},
                    "limitations": limitations, "output": {"format": "glb", "sha256": hashlib.sha256(prepared).hexdigest()}}
        # Exclusive creation prevents concurrent imports from replacing an asset.
        created = False
        try:
            with output.open("xb") as handle:
                created = True
                handle.write(prepared)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException as error:
            if created:
                output.unlink(missing_ok=True)
            if isinstance(error, FileExistsError):
                raise ValueError("Mesh output already exists; choose a new output path") from error
            raise
        return metadata
