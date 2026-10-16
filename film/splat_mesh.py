"""Experimental local Gaussian-density reconstruction into a visual GLB.

This is an opacity-weighted Gaussian field isosurface, not World Labs' official
mesh and not a triangulation of Gaussian centres. Covariance influences the
field; a bounded voxel grid necessarily broadens sub-voxel detail. SH0 colours
become rough vertex-coloured surfaces, without trained view-dependent shading.
Numerical dependencies are optional and imported only when conversion is used.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import time

from .worlds import MAX_ASSET_BYTES, _PLY_TYPES, _validate_content


ALGORITHM = "opacity-weighted-anisotropic-gaussian-density-marching-cubes-v1"
MAX_DECODED_SPLATS = 2_000_000
MAX_GRID_RESOLUTION = 128
MAX_DENSITY_EVALUATIONS = 200_000_000
SH_C0 = 0.28209479177387814
FIELDS = ("x", "y", "z", "qw", "qx", "qy", "qz", "sx", "sy", "sz", "opacity", "r", "g", "b")
LIMITATIONS = [
    "Experimental local density isosurface; this is not an official World Labs visual mesh or a native Gaussian renderer.",
    "Opacity and anisotropic covariance define an approximate surface, not a calibrated signed-distance, occupancy probability, collision model or manufactured geometry.",
    "Finite voxels broaden sub-voxel Gaussian radii and lose thin structures; threshold choice changes topology, holes and surface thickness.",
    "SH0 colour is transferred to rough vertex-coloured material; higher spherical harmonics, view dependence, baked appearance separation, glass and lighting are not reconstructed.",
    "Deterministic thinning may remove details; inverse retention weights approximate the omitted field but do not preserve every Gaussian.",
    "Human review, official-mesh comparison and photographic similarity remain unmeasured until the actual outputs are reviewed.",
]


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _dependencies():
    try:
        import numpy as np
        from scipy.ndimage import map_coordinates
        from scipy.spatial import cKDTree
        from scipy.spatial.transform import Rotation
        from skimage.measure import marching_cubes
    except ImportError as error:
        raise ValueError("Gaussian mesh conversion requires requirements-worlds.txt (NumPy, SciPy and scikit-image); install it before conversion") from error
    return np, map_coordinates, cKDTree, Rotation, marching_cubes


def _read_ply(source, np):
    """Read validated Gaussian PLY fields, converting log scales/logit alpha."""
    payload = source.read_bytes()
    _validate_content(payload, "ply", source.name)
    marker = b"end_header\n" if b"end_header\n" in payload[:65536] else b"end_header\r\n"
    offset = payload.index(marker) + len(marker)
    lines = payload[:offset].decode("ascii").splitlines()
    count = int(next(line.split()[2] for line in lines if line.startswith("element vertex ")))
    _require(count <= MAX_DECODED_SPLATS, f"Gaussian decoding is limited to {MAX_DECODED_SPLATS:,} input splats")
    properties = [line.split()[1:] for line in lines if line.startswith("property ")]
    if lines[1] == "format binary_little_endian 1.0":
        dtype = np.dtype([(name, "<" + _PLY_TYPES[kind]) for kind, name in properties])
        decoded = np.frombuffer(payload, dtype=dtype, offset=offset, count=count)
        values = {name: np.asarray(decoded[name], dtype=np.float64) for _, name in properties}
    else:
        decoded = np.loadtxt(payload[offset:].splitlines(), dtype=np.float64, ndmin=2)
        values = {name: decoded[:, index] for index, (_, name) in enumerate(properties)}
    result = np.empty((count, len(FIELDS)), dtype=np.float64)
    for index, name in enumerate(("x", "y", "z", "rot_0", "rot_1", "rot_2", "rot_3")):
        result[:, index] = values[name]
    # Guard exponentials before they can overflow. Very large finite radii still
    # produce bounded grids and are reported in the reconstruction metrics.
    log_scales = np.column_stack([values[f"scale_{index}"] for index in range(3)])
    _require(bool(np.all((log_scales >= -40) & (log_scales <= 20))), "Gaussian log scales are outside the supported [-40,20] range")
    result[:, 7:10] = np.exp(log_scales)
    result[:, 10] = 1 / (1 + np.exp(-np.clip(values["opacity"], -80, 80)))
    result[:, 11:14] = np.clip(0.5 + SH_C0 * np.column_stack([values[f"f_dc_{index}"] for index in range(3)]), 0, 1)
    return result, {"decoder": "strict-gaussian-ply-stdlib/numpy", "sourceFormat": "ply", "inputSplats": count}


def _decode_spz(source, temporary, np):
    node = shutil.which("node")
    _require(node is not None, "SPZ conversion requires Node.js plus the pinned web dependencies; PLY conversion can run entirely in Python")
    script = Path(__file__).resolve().parents[1] / "scripts" / "decode_splat.mjs"
    destination = temporary / "decoded.f32"
    result = subprocess.run([node, str(script), "--input", str(source), "--output", str(destination)],
                            capture_output=True, text=True, timeout=300)
    if result.returncode:
        message = (result.stderr or result.stdout).strip()[-2000:]
        raise ValueError(f"Spark SPZ decoding failed: {message}")
    try:
        metadata = json.loads(result.stdout.strip().splitlines()[-1])
        count = metadata["count"]
        _require(type(count) is int and 0 < count <= MAX_DECODED_SPLATS, "SPZ decoder returned an unsupported count")
        _require(metadata.get("stride") == len(FIELDS) and metadata.get("fields") == list(FIELDS), "SPZ decoder returned an incompatible Gaussian layout")
        _require(destination.stat().st_size == count * len(FIELDS) * 4, "SPZ decoder returned incomplete Gaussian data")
    except (KeyError, IndexError, OSError, json.JSONDecodeError) as error:
        raise ValueError("SPZ decoder did not produce a valid bounded Gaussian manifest") from error
    # Ephemeral decoder workspace paths are not reproducible lineage metadata.
    metadata.pop("output", None)
    return np.memmap(destination, dtype="<f4", mode="r", shape=(count, len(FIELDS))), metadata


def _prepare_gaussians(rows, source_up, max_splats, np, Rotation):
    _require(rows.ndim == 2 and rows.shape[1] == len(FIELDS) and len(rows), "Decoded Gaussian data is empty or malformed")
    _require(bool(np.all(np.isfinite(rows))), "Decoded Gaussian values must be finite")
    _require(bool(np.all(rows[:, 7:10] > 0)), "Gaussian standard deviations must be positive")
    _require(bool(np.all((rows[:, 10:14] >= 0) & (rows[:, 10:14] <= 1))), "Gaussian opacity and colours must lie in [0,1]")
    quaternion_norms = np.linalg.norm(rows[:, 3:7], axis=1)
    _require(bool(np.all(quaternion_norms > 1e-8)), "Gaussian quaternions must have nonzero length")
    eligible = np.flatnonzero(rows[:, 10] >= 0.05)
    _require(len(eligible) > 0, "No Gaussians remain above the 0.05 opacity filter")
    # A deterministic systematic sample preserves coverage of common spatially
    # ordered exports. Density weights compensate uniformly for the thinning.
    selected = eligible if len(eligible) <= max_splats else eligible[np.linspace(0, len(eligible) - 1, max_splats, dtype=np.int64)]
    values = np.asarray(rows[selected], dtype=np.float64)
    values[:, 3:7] /= np.linalg.norm(values[:, 3:7], axis=1)[:, None]
    rotations = Rotation.from_quat(values[:, [4, 5, 6, 3]]).as_matrix()
    if source_up == "Z":
        # Source Z-up -> canonical Y-up: (x,y,z) -> (x,z,-y). The
        # ellipsoid principal axes rotate with its centre; no scale is baked.
        source_to_canonical = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64)
        values[:, :3] = values[:, :3] @ source_to_canonical.T
        rotations = np.einsum("ij,njk->nik", source_to_canonical, rotations)
    weights = values[:, 10] * (len(eligible) / len(selected))
    return values, rotations, weights, {"inputSplats": len(rows), "opacityFilteredSplats": len(rows) - len(eligible),
                                        "eligibleSplats": len(eligible), "usedSplats": len(selected),
                                        "thinning": "deterministic systematic index sampling", "densityWeightMultiplier": len(eligible) / len(selected)}


def _density_grid(values, rotations, weights, resolution, np):
    means, scales = values[:, :3], values[:, 7:10]
    support = 3.0
    original_radii = support * np.sqrt(np.einsum("nij,nj->ni", rotations ** 2, scales ** 2))
    minimum = np.min(means - original_radii, axis=0)
    maximum = np.max(means + original_radii, axis=0)
    extent = maximum - minimum
    _require(bool(np.all(np.isfinite(extent))) and float(np.max(extent)) > 1e-12, "Gaussian bounds are degenerate or nonfinite")
    voxel = float(np.max(extent)) / (resolution - 5)
    origin = minimum - 2 * voxel
    dimensions = np.minimum(np.ceil((maximum + 2 * voxel - origin) / voxel).astype(int) + 1, resolution)
    dimensions = np.maximum(dimensions, 5)
    effective_scales = np.maximum(scales, voxel * 0.6)
    precision = np.einsum("nik,nk,njk->nij", rotations, 1 / effective_scales ** 2, rotations)
    radii = support * np.sqrt(np.einsum("nij,nj->ni", rotations ** 2, effective_scales ** 2))
    starts = np.maximum(np.floor((means - radii - origin) / voxel).astype(np.int64), 0)
    stops = np.minimum(np.ceil((means + radii - origin) / voxel).astype(np.int64) + 1, dimensions)
    work = int(np.prod(np.maximum(stops - starts, 0), axis=1, dtype=np.int64).sum())
    _require(work <= MAX_DENSITY_EVALUATIONS,
             f"Estimated Gaussian density work ({work:,} voxel contributions) exceeds the bounded {MAX_DENSITY_EVALUATIONS:,} budget; reduce resolution or max_splats")
    density = np.zeros(tuple(dimensions), dtype=np.float32)
    for centre, matrix, weight, start, stop in zip(means, precision, weights, starts, stops):
        if np.any(stop <= start):
            continue
        dx = (origin[0] + np.arange(start[0], stop[0]) * voxel - centre[0])[:, None, None]
        dy = (origin[1] + np.arange(start[1], stop[1]) * voxel - centre[1])[None, :, None]
        dz = (origin[2] + np.arange(start[2], stop[2]) * voxel - centre[2])[None, None, :]
        mahalanobis = (matrix[0, 0] * dx * dx + matrix[1, 1] * dy * dy + matrix[2, 2] * dz * dz
                       + 2 * matrix[0, 1] * dx * dy + 2 * matrix[0, 2] * dx * dz + 2 * matrix[1, 2] * dy * dz)
        contribution = np.where(mahalanobis <= support ** 2, weight * np.exp(-0.5 * mahalanobis), 0)
        density[tuple(slice(a, b) for a, b in zip(start, stop))] += contribution.astype(np.float32)
    return density, origin, voxel, precision, {"dimensions": dimensions.tolist(), "voxelCount": int(np.prod(dimensions)),
        "voxelSizeSourceUnits": voxel, "originSourceUnits": origin.tolist(), "gaussianSupportSigma": support,
        "minimumRadiusVoxels": 0.6, "radiusFlooredAxes": int(np.count_nonzero(scales < voxel * 0.6)),
        "estimatedVoxelContributions": work, "densityRange": [float(density.min()), float(density.max())]}


def _surface(density, origin, voxel, iso_level, np, map_coordinates, marching_cubes):
    _require(float(density.min()) < iso_level < float(density.max()),
             f"iso_level {iso_level} does not cross density range [{float(density.min()):.5g}, {float(density.max()):.5g}]; choose a different threshold")
    vertices, faces, _, _ = marching_cubes(density, level=iso_level, spacing=(voxel,) * 3,
                                          allow_degenerate=False, gradient_direction="descent")
    _require(len(vertices) <= 1_000_000 and len(faces) <= 2_000_000,
             "Reconstructed surface exceeds the bounded 1m vertices/2m triangles budget; reduce resolution or adjust iso_level")
    grid_coordinates = (vertices / voxel).T
    gradients = np.gradient(density, voxel)
    normals = -np.column_stack([map_coordinates(component, grid_coordinates, order=1, mode="nearest") for component in gradients])
    lengths = np.linalg.norm(normals, axis=1)
    normals /= np.maximum(lengths, 1e-20)[:, None]
    # Independently orient triangle winding to the outward density gradient.
    cross = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]], vertices[faces[:, 2]] - vertices[faces[:, 0]])
    if float(np.sum(cross * normals[faces].mean(axis=1))) < 0:
        faces = faces[:, [0, 2, 1]]
    vertices += origin
    return vertices, faces, normals


def _surface_colours(vertices, values, precision, weights, np, cKDTree):
    tree = cKDTree(values[:, :3])
    neighbours = min(16, len(values))
    colours = np.empty((len(vertices), 3), dtype=np.float32)
    for offset in range(0, len(vertices), 16384):
        batch = vertices[offset:offset + 16384]
        _, nearest = tree.query(batch, k=neighbours, workers=1)
        if neighbours == 1:
            nearest = nearest[:, None]
        delta = batch[:, None, :] - values[nearest, :3]
        distances = np.einsum("nki,nkij,nkj->nk", delta, precision[nearest], delta)
        influence = weights[nearest] * np.exp(-0.5 * np.minimum(distances, 100))
        total = influence.sum(axis=1)
        mixed = np.einsum("nk,nkc->nc", influence, values[nearest, 11:14]) / np.maximum(total[:, None], 1e-20)
        mixed[total <= 1e-20] = values[nearest[total <= 1e-20, 0], 11:14]
        colours[offset:offset + len(batch)] = np.clip(mixed, 0, 1)
    return colours


def _write_glb(path, vertices, faces, normals, colours, metadata, np):
    binary = bytearray()
    views, accessors = [], []

    def accessor(array, type_, component, target, bounds=False):
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        binary.extend(array.tobytes(order="C"))
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset, "target": target})
        result = {"bufferView": len(views) - 1, "componentType": component, "count": len(array), "type": type_}
        if bounds:
            result.update(min=array.min(axis=0).astype(float).tolist(), max=array.max(axis=0).astype(float).tolist())
        accessors.append(result)
        return len(accessors) - 1

    position = accessor(np.asarray(vertices, dtype="<f4"), "VEC3", 5126, 34962, True)
    normal = accessor(np.asarray(normals, dtype="<f4"), "VEC3", 5126, 34962)
    colour = accessor(np.asarray(colours, dtype="<f4"), "VEC3", 5126, 34962)
    indices = accessor(np.asarray(faces, dtype="<u4").reshape(-1), "SCALAR", 5125, 34963)
    document = {"asset": {"version": "2.0", "generator": "3d-product-suite experimental Gaussian density reconstruction"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "Experimental Gaussian density surface"}],
        "meshes": [{"name": "Approximate reconstructed visual surface", "primitives": [{"attributes": {"POSITION": position, "NORMAL": normal, "COLOR_0": colour}, "indices": indices, "material": 0}]}],
        "materials": [{"name": "Approximate SH0 vertex colour / rough surface", "doubleSided": True,
                       "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.85}}],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors,
        "extras": {"experimental": True, "sourceSha256": metadata["sourceSha256"], "algorithm": ALGORITHM,
                   "sourceUp": "Y", "units": "source asset units; retain the source world scaleToMeters", "limitations": LIMITATIONS}}
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    payload = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(binary))
    payload += struct.pack("<I4s", len(encoded), b"JSON") + encoded + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    _require(len(payload) <= MAX_ASSET_BYTES, "Reconstructed GLB exceeds the 128 MiB world asset limit")
    _validate_content(payload, "glb", path.name)
    with path.open("xb") as stream:
        stream.write(payload)
    return hashlib.sha256(payload).hexdigest(), len(payload)


def convert_splat(source_path, output_path, *, resolution=96, iso_level=0.5, max_splats=100000, source_up="Y"):
    """Convert a local Gaussian PLY/SPZ to a self-contained canonical Y-up GLB.

    The source world scale/rotation/translation must be retained by the caller;
    only its declared source-up basis is baked into the GLB. Output paths are
    never overwritten: callers can import the result into an immutable library.
    """
    _require(type(resolution) is int and 16 <= resolution <= MAX_GRID_RESOLUTION, "resolution must be an integer in [16,128]")
    _require(type(max_splats) is int and 1 <= max_splats <= 200000, "max_splats must be an integer in [1,200000]")
    _require(type(iso_level) in (int, float) and math.isfinite(iso_level) and iso_level > 0, "iso_level must be finite and positive")
    _require(source_up in ("Y", "Z"), "source_up must explicitly be Y or Z")
    source, output = Path(source_path).resolve(), Path(output_path).resolve()
    _require(source.suffix.lower() in (".spz", ".ply"), "Gaussian reconstruction source must be SPZ or Gaussian PLY")
    _require(output.suffix.lower() == ".glb", "Gaussian reconstruction output must be GLB")
    _require(source.is_file() and 0 < source.stat().st_size <= MAX_ASSET_BYTES, "Gaussian source must be a nonempty local file no larger than 128 MiB")
    sidecar = output.with_suffix(output.suffix + ".reconstruction.json")
    _require(not output.exists() and not sidecar.exists(), "Reconstruction output already exists; use a new output path")
    np, map_coordinates, cKDTree, Rotation, marching_cubes = _dependencies()
    started = time.monotonic()
    with source.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="splat-mesh-") as temporary:
        rows, decoder = (_read_ply(source, np) if source.suffix.lower() == ".ply" else _decode_spz(source, Path(temporary), np))
        if "sourceSha256" in decoder:
            _require(decoder["sourceSha256"] == source_hash, "Gaussian source changed while decoding")
        values, rotations, weights, selection = _prepare_gaussians(rows, source_up, max_splats, np, Rotation)
        density, origin, voxel, precision, grid = _density_grid(values, rotations, weights, resolution, np)
        vertices, faces, normals = _surface(density, origin, voxel, iso_level, np, map_coordinates, marching_cubes)
        colours = _surface_colours(vertices, values, precision, weights, np, cKDTree)
        metadata = {"schemaVersion": 1, "experimental": True, "algorithm": ALGORITHM, "sourceSha256": source_hash,
            "sourceFormat": source.suffix.lower()[1:], "sourceUp": source_up, "outputSourceUp": "Y",
            "alignmentPolicy": "Source-up basis converted to canonical Y; retain input world scaleToMeters, rotationXyzw and translationM unchanged.",
            "parameters": {"resolution": resolution, "isoLevel": iso_level, "maxSplats": max_splats, "opacityThreshold": 0.05},
            "decoder": decoder, "selection": selection, "grid": grid,
            "geometry": {"vertices": len(vertices), "triangles": len(faces), "boundsSourceUnits": {"min": vertices.min(axis=0).astype(float).tolist(), "max": vertices.max(axis=0).astype(float).tolist()}},
            "colors": {"source": "SH0/DC RGB clamped to [0,1]", "transfer": "opacity-density-weighted nearest 16 Gaussian centres", "viewDependentSH": False},
            "dependencies": {package: importlib.metadata.version(package) for package in ("numpy", "scipy", "scikit-image")},
            "limitations": LIMITATIONS}
        output_hash, output_bytes = _write_glb(output, vertices, faces, normals, colours, metadata, np)
        metadata["output"] = {"format": "glb", "sha256": output_hash, "bytes": output_bytes}
        metadata["elapsedSeconds"] = round(time.monotonic() - started, 3)
        with sidecar.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(metadata, indent=2, allow_nan=False) + "\n")
        return metadata
