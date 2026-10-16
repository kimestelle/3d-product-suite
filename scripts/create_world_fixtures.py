#!/usr/bin/env python3
"""Rebuild original, synthetic room GLB and 3D Gaussian PLY fixtures.

Uses only Python's standard library. Both assets are derived from ROOM_BOXES;
the Gaussian asset approximates those surfaces and is not a learned radiance field.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_VERSION = 1
SH_C0 = 0.28209479177387814
SPLAT_SPACING_M = 0.03

# Color factors are linear RGB, matching glTF's baseColorFactor convention.
MATERIALS = [
    {"name": "warm limestone", "rgb": [0.49, 0.46, 0.40], "roughness": 0.88},
    {"name": "chalk plaster", "rgb": [0.69, 0.66, 0.59], "roughness": 0.91},
    {"name": "inset ivory", "rgb": [0.78, 0.75, 0.67], "roughness": 0.83},
    {"name": "muted bronze", "rgb": [0.31, 0.26, 0.18], "roughness": 0.72},
]

# These are distant environment surfaces. The product and exact contact plinth
# are separate scene objects and deliberately absent from both world assets.
ROOM_BOXES = [
    {"name": "floor behind contact stage", "centerM": [0, -0.030, -0.505],
     "sizeM": [1.8, 0.010, 0.750], "material": 0},
    {"name": "back wall", "centerM": [0, 0.525, -0.520],
     "sizeM": [1.8, 1.100, 0.040], "material": 1},
    {"name": "left wall return", "centerM": [-0.880, 0.315, -0.290],
     "sizeM": [0.040, 0.680, 0.460], "material": 1},
    {"name": "ivory inset", "centerM": [-0.305, 0.310, -0.492],
     "sizeM": [0.470, 0.470, 0.016], "material": 2},
    {"name": "inset bottom reveal", "centerM": [-0.305, 0.070, -0.488],
     "sizeM": [0.470, 0.010, 0.024], "material": 3},
    {"name": "bronze fin 1", "centerM": [0.160, 0.275, -0.476],
     "sizeM": [0.012, 0.600, 0.048], "material": 3},
    {"name": "bronze fin 2", "centerM": [0.220, 0.275, -0.476],
     "sizeM": [0.012, 0.600, 0.048], "material": 3},
    {"name": "bronze fin 3", "centerM": [0.280, 0.275, -0.476],
     "sizeM": [0.012, 0.600, 0.048], "material": 3},
]

# Per face: outward normal, tangent U, tangent V; cross(U, V) == normal.
FACES = [
    ((1, 0, 0), (0, 0, -1), (0, 1, 0)),
    ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    ((0, 1, 0), (1, 0, 0), (0, 0, -1)),
    ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
    ((0, 0, 1), (1, 0, 0), (0, 1, 0)),
    ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
]


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def extent(size: list[float], axis: tuple[int, int, int]) -> float:
    return sum(abs(axis[i]) * size[i] for i in range(3))


def surface_point(box: dict, normal: tuple, u: tuple, v: tuple,
                  along_u: float, along_v: float) -> list[float]:
    half_normal = extent(box["sizeM"], normal) / 2
    return [box["centerM"][i] + normal[i] * half_normal
            + u[i] * along_u + v[i] * along_v for i in range(3)]


def write_glb(path: Path, geometry_digest: str) -> dict:
    binary = bytearray()
    views, accessors, meshes, nodes = [], [], [], []

    def accessor(values: list, component_type: int, type_name: str,
                 target: int, minimum=None, maximum=None) -> int:
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        fmt = "f" if component_type == 5126 else "H"
        flat = [v for row in values for v in row] if type_name != "SCALAR" else values
        binary.extend(struct.pack("<" + fmt * len(flat), *flat))
        views.append({"buffer": 0, "byteOffset": offset,
                      "byteLength": len(binary) - offset, "target": target})
        result = {"bufferView": len(views) - 1, "componentType": component_type,
                  "count": len(values), "type": type_name}
        if minimum is not None:
            result.update(min=minimum, max=maximum)
        accessors.append(result)
        return len(accessors) - 1

    for box in ROOM_BOXES:
        positions, normals, indices = [], [], []
        for n, u, v in FACES:
            width, height = extent(box["sizeM"], u), extent(box["sizeM"], v)
            base = len(positions)
            for sign_u, sign_v in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                positions.append(surface_point(box, n, u, v,
                                               sign_u * width / 2, sign_v * height / 2))
                normals.append(n)
            indices.extend(base + i for i in (0, 1, 2, 0, 2, 3))
        minimum = [min(p[i] for p in positions) for i in range(3)]
        maximum = [max(p[i] for p in positions) for i in range(3)]
        pa = accessor(positions, 5126, "VEC3", 34962, minimum, maximum)
        na = accessor(normals, 5126, "VEC3", 34962)
        ia = accessor(indices, 5123, "SCALAR", 34963)
        meshes.append({"name": box["name"], "primitives": [{
            "attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia,
            "material": box["material"], "mode": 4}]})
        nodes.append({"name": box["name"], "mesh": len(meshes) - 1})
    while len(binary) % 4:
        binary.append(0)
    gltf = {
        "asset": {"version": "2.0", "generator": "3d-product-suite original fixture generator v1"},
        "scene": 0, "scenes": [{"name": "Original synthetic neutral room", "nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes,
        "materials": [{"name": material["name"], "pbrMetallicRoughness": {
            "baseColorFactor": material["rgb"] + [1], "metallicFactor": 0,
            "roughnessFactor": material["roughness"]}} for material in MATERIALS],
        "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors,
        "extras": {"fixture": True, "sourceUp": "Y", "units": "meters",
                   "geometrySha256": geometry_digest, "provenance": "Original synthetic geometry; not a World Labs export."},
    }
    json_bytes = canonical_json(gltf)
    json_bytes += b" " * (-len(json_bytes) % 4)
    length = 12 + 8 + len(json_bytes) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, length)
                     + struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
                     + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    return {"meshes": len(meshes), "triangles": len(meshes) * 12,
            "vertices": len(meshes) * 24}


def face_quaternion_wxyz(u: tuple, v: tuple, n: tuple) -> list[float]:
    """Quaternion for orthonormal matrix whose columns are u, v, normal."""
    matrix = [[u[i], v[i], n[i]] for i in range(3)]
    trace = sum(matrix[i][i] for i in range(3))
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        return [s / 4, (matrix[2][1] - matrix[1][2]) / s,
                (matrix[0][2] - matrix[2][0]) / s,
                (matrix[1][0] - matrix[0][1]) / s]
    i = max(range(3), key=lambda index: matrix[index][index])
    j, k = (i + 1) % 3, (i + 2) % 3
    s = math.sqrt(1 + matrix[i][i] - matrix[j][j] - matrix[k][k]) * 2
    quaternion = [0.0, 0.0, 0.0, 0.0]
    quaternion[0] = (matrix[k][j] - matrix[j][k]) / s
    quaternion[i + 1] = s / 4
    quaternion[j + 1] = (matrix[j][i] + matrix[i][j]) / s
    quaternion[k + 1] = (matrix[k][i] + matrix[i][k]) / s
    return quaternion


def write_gaussian_ply(path: Path, geometry_digest: str) -> dict:
    vertices = bytearray()
    count = 0
    for box in ROOM_BOXES:
        rgb = MATERIALS[box["material"]]["rgb"]
        # Convert material linear RGB to display RGB for constant degree-0 SH.
        display_rgb = [12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
                       for c in rgb]
        dc = [(c - 0.5) / SH_C0 for c in display_rgb]
        for n, u, v in FACES:
            width, height = extent(box["sizeM"], u), extent(box["sizeM"], v)
            nu, nv = math.ceil(width / SPLAT_SPACING_M), math.ceil(height / SPLAT_SPACING_M)
            du, dv = width / nu, height / nv
            scales = [math.log(du * 0.65), math.log(dv * 0.65), math.log(0.0006)]
            quaternion = face_quaternion_wxyz(u, v, n)
            for row in range(nv):
                for col in range(nu):
                    position = surface_point(box, n, u, v,
                                             -width / 2 + (col + 0.5) * du,
                                             -height / 2 + (row + 0.5) * dv)
                    values = position + list(n) + dc + [math.log(0.98 / 0.02)] + scales + quaternion
                    vertices.extend(struct.pack("<17f", *values))
                    count += 1
    properties = ("x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2",
                  "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")
    header = ("ply\nformat binary_little_endian 1.0\n"
              "comment Original synthetic QA fixture; not a World Labs export\n"
              "comment sourceUp Y; units meters; quaternion order w x y z\n"
              f"comment geometry_sha256 {geometry_digest}\n"
              "comment degree-0 SH display RGB; log scales; logit opacity\n"
              f"element vertex {count}\n"
              + "".join(f"property float {name}\n" for name in properties)
              + "end_header\n")
    path.write_bytes(header.encode("ascii") + vertices)
    return {"gaussians": count, "shDegree": 0, "spacingM": SPLAT_SPACING_M,
            "quaternionOrder": "wxyz", "scaleEncoding": "natural logarithm",
            "opacityEncoding": "logit", "sourceUp": "Y"}


def create_fixtures(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    geometry = {"coordinates": {"up": "Y", "units": "meters", "handedness": "right"},
                "materials": MATERIALS, "boxes": ROOM_BOXES}
    geometry_digest = hashlib.sha256(canonical_json(geometry)).hexdigest()
    glb_path, ply_path = output / "neutral-room.glb", output / "neutral-room.ply"
    mesh_details = write_glb(glb_path, geometry_digest)
    splat_details = write_gaussian_ply(ply_path, geometry_digest)
    lower = [min(box["centerM"][i] - box["sizeM"][i] / 2 for box in ROOM_BOXES) for i in range(3)]
    upper = [max(box["centerM"][i] + box["sizeM"][i] / 2 for box in ROOM_BOXES) for i in range(3)]
    manifest = {
        "schemaVersion": 1, "generatorVersion": GENERATOR_VERSION,
        "displayName": "Synthetic neutral architectural room",
        "fixture": True, "reviewStatus": "unreviewed",
        "provenance": {
            "source": "Original programmatically authored synthetic room; not a World Labs export or a captured real location.",
            "owner": "3d-product-suite project",
            "reuseBasis": "Original project QA geometry and material colors; no third-party assets, textures, models, or training data.",
            "allowedExternalDestinations": [],
        },
        "alignment": {"sourceUp": "Y", "scaleToMeters": 1,
                      "translationM": [0, 0, 0], "rotationXyzw": [0, 0, 0, 1]},
        "geometrySha256": geometry_digest,
        "boundsM": {"min": lower, "max": upper,
                    "size": [round(upper[i] - lower[i], 9) for i in range(3)]},
        "landmarksM": {"floorTopY": -0.025, "floorFrontZ": -0.13,
                       "backWallFrontZ": -0.50, "productOrigin": [0, 0, 0]},
        "geometry": geometry,
        "assets": [],
        "limitations": [
            "Synthetic import, alignment, and render-path QA only; no generated-world quality or human review result.",
            "The PLY samples the same box faces as the GLB; it is an approximate surface Gaussian field with degree-0 color, not trained 3DGS or a provider export.",
            "Gaussian edges and color differ from lit PBR mesh edges; splats contain no learned shadows, view dependence, reflections, transmission, or near-field contact.",
            "Product and exact contact plinth are deliberately absent. The floor starts behind the plinth and is not a contact or collision surface.",
        ],
    }
    for path, format_name, details in ((glb_path, "glb", mesh_details), (ply_path, "ply", splat_details)):
        data = path.read_bytes()
        manifest["assets"].append({"path": path.name, "format": format_name,
                                   "sha256": hashlib.sha256(data).hexdigest(),
                                   "bytes": len(data), "sourceUp": "Y", **details})
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "examples" / "worlds")
    args = parser.parse_args()
    manifest = create_fixtures(args.output)
    for asset in manifest["assets"]:
        print(f"{args.output / asset['path']} ({asset['bytes']} bytes; sha256 {asset['sha256']})")


if __name__ == "__main__":
    main()
