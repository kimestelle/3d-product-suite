#!/usr/bin/env python3
"""Build original Gallery and Botanical room default environments offline.

Run ``python scripts/create_default_environments.py`` to regenerate the two
self-contained GLBs and examples/worlds/defaults.json. Python's standard library
and the adjacent original fixture GLB writer are the only dependencies. All
geometry remains behind the exact scene product/contact plinth. These are authored
starter environments, not World Labs exports or validated generated-world results.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct


ROOT = Path(__file__).resolve().parents[1]


def box(name: str, center: list[float], size: list[float], material: int,
        rotation_z_deg: float = 0) -> dict:
    result = {"name": name, "centerM": center, "sizeM": size, "material": material}
    if rotation_z_deg:
        result["rotationZDeg"] = rotation_z_deg
    return result


GALLERY = {
    "id": "gallery", "displayName": "Gallery", "assetFile": "default-gallery.glb",
    "description": "A warm limestone gallery with a recessed ivory niche and distant stepped display ledge.",
    "worldColor": [0.24, 0.23, 0.20],
    "materials": [
        {"name": "sand limestone", "rgb": [0.56, 0.50, 0.41], "roughness": 0.86},
        {"name": "warm gallery plaster", "rgb": [0.75, 0.71, 0.63], "roughness": 0.90},
        {"name": "niche ivory", "rgb": [0.86, 0.82, 0.73], "roughness": 0.84},
        {"name": "recess shadow stone", "rgb": [0.32, 0.29, 0.24], "roughness": 0.92},
    ],
    "boxes": [
        box("distant gallery floor", [0, -0.035, -0.64], [1.8, 0.02, 0.92], 0),
        box("gallery back wall", [0, 0.515, -0.72], [1.8, 1.08, 0.04], 1),
        box("niche recessed backing", [-0.30, 0.30, -0.694], [0.58, 0.54, 0.012], 3),
        box("niche ivory field", [-0.30, 0.30, -0.684], [0.47, 0.43, 0.012], 2),
        box("niche left return", [-0.585, 0.30, -0.655], [0.06, 0.60, 0.09], 1),
        box("niche right return", [-0.015, 0.30, -0.655], [0.06, 0.60, 0.09], 1),
        box("niche top return", [-0.30, 0.585, -0.655], [0.51, 0.06, 0.09], 1),
        box("niche lower return", [-0.30, 0.015, -0.655], [0.51, 0.06, 0.09], 0),
        box("distant display ledge lower step", [0.36, 0.025, -0.47], [0.38, 0.10, 0.20], 0),
        box("distant display ledge upper step", [0.43, 0.090, -0.50], [0.20, 0.03, 0.14], 2),
    ],
}


BOTANICAL = {
    "id": "botanical-room", "displayName": "Botanical room", "assetFile": "default-botanical.glb",
    "description": "A muted sage room with a pale wall panel and an original stylized potted plant made from simple box geometry.",
    "worldColor": [0.16, 0.21, 0.17],
    "materials": [
        {"name": "pale botanical stone", "rgb": [0.60, 0.59, 0.50], "roughness": 0.89},
        {"name": "sage limewash", "rgb": [0.36, 0.47, 0.37], "roughness": 0.93},
        {"name": "pale sage wall panel", "rgb": [0.54, 0.62, 0.50], "roughness": 0.88},
        {"name": "terracotta planter", "rgb": [0.43, 0.29, 0.19], "roughness": 0.88},
        {"name": "dark planter soil", "rgb": [0.08, 0.07, 0.045], "roughness": 1.0},
        {"name": "olive stems", "rgb": [0.16, 0.24, 0.10], "roughness": 0.91},
        {"name": "soft sage leaf", "rgb": [0.28, 0.39, 0.18], "roughness": 0.82},
        {"name": "deep olive leaf", "rgb": [0.17, 0.29, 0.12], "roughness": 0.86},
    ],
    "boxes": [
        box("distant botanical floor", [0, -0.035, -0.64], [1.8, 0.02, 0.92], 0),
        box("botanical back wall", [0, 0.515, -0.68], [1.8, 1.08, 0.04], 1),
        box("pale sage inset panel", [0.25, 0.34, -0.652], [0.49, 0.61, 0.016], 2),
        box("planter main body", [-0.39, 0.020, -0.43], [0.12, 0.09, 0.12], 3),
        box("planter rim", [-0.39, 0.070, -0.43], [0.14, 0.016, 0.14], 3),
        box("planter soil surface", [-0.39, 0.079, -0.43], [0.112, 0.004, 0.112], 4),
        box("plant main stem", [-0.39, 0.235, -0.43], [0.008, 0.31, 0.008], 5),
        box("plant side stem", [-0.35, 0.220, -0.43], [0.006, 0.23, 0.006], 5, -14),
        box("leaf left lower", [-0.438, 0.155, -0.424], [0.104, 0.030, 0.008], 6, -25),
        box("leaf right lower", [-0.337, 0.187, -0.415], [0.104, 0.032, 0.008], 7, 24),
        box("leaf left middle", [-0.438, 0.235, -0.425], [0.110, 0.033, 0.008], 7, -24),
        box("leaf right middle", [-0.331, 0.276, -0.417], [0.108, 0.034, 0.008], 6, 29),
        box("leaf left upper", [-0.430, 0.315, -0.424], [0.095, 0.030, 0.008], 6, -32),
        box("leaf right upper", [-0.350, 0.348, -0.422], [0.082, 0.029, 0.008], 7, 35),
        box("leaf crown", [-0.386, 0.391, -0.425], [0.033, 0.077, 0.008], 6, -12),
    ],
}


def load_fixture_writer():
    spec = importlib.util.spec_from_file_location(
        "original_fixture_writer", Path(__file__).with_name("create_world_fixtures.py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load the adjacent original fixture GLB writer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finalize_glb(path: Path, definition: dict, provenance: dict) -> None:
    """Name the scene accurately and rotate leaf/stem nodes about their centers."""
    raw = path.read_bytes()
    json_length, _ = struct.unpack_from("<I4s", raw, 12)
    document = json.loads(raw[20:20 + json_length])
    binary_length, _ = struct.unpack_from("<I4s", raw, 20 + json_length)
    binary = bytearray(raw[28 + json_length:28 + json_length + binary_length])
    document["asset"]["generator"] = "3d-product-suite original offline default environment generator v1"
    document["scenes"][0]["name"] = definition["displayName"]
    document["extras"].update(
        displayName=definition["displayName"], defaultEnvironment=True,
        provenance=provenance, reviewStatus="unreviewed")
    for index, item in enumerate(definition["boxes"]):
        angle = math.radians(item.get("rotationZDeg", 0))
        if not angle:
            continue
        mesh = document["meshes"][index]
        accessor = document["accessors"][mesh["primitives"][0]["attributes"]["POSITION"]]
        view = document["bufferViews"][accessor["bufferView"]]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        center = item["centerM"]
        local_positions = []
        for vertex in range(accessor["count"]):
            position = struct.unpack_from("<3f", binary, offset + vertex * 12)
            struct.pack_into("<3f", binary, offset + vertex * 12,
                             *(position[i] - center[i] for i in range(3)))
            local_positions.append(struct.unpack_from("<3f", binary, offset + vertex * 12))
        # Recentered coordinates retain axis-aligned local normals; glTF applies
        # the same rigid node rotation to positions and normals at load time.
        accessor["min"] = [min(p[i] for p in local_positions) for i in range(3)]
        accessor["max"] = [max(p[i] for p in local_positions) for i in range(3)]
        document["nodes"][index].update(
            translation=center, rotation=[0, 0, math.sin(angle / 2), math.cos(angle / 2)])
    json_bytes = json.dumps(document, sort_keys=True, separators=(",", ":"),
                            allow_nan=False).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, total)
                     + struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
                     + struct.pack("<I4s", len(binary), b"BIN\0") + binary)


def world_bounds(boxes: list[dict]) -> dict:
    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for item in boxes:
        angle = math.radians(item.get("rotationZDeg", 0))
        sx, sy, sz = item["sizeM"]
        half = [(abs(math.cos(angle)) * sx + abs(math.sin(angle)) * sy) / 2,
                (abs(math.sin(angle)) * sx + abs(math.cos(angle)) * sy) / 2, sz / 2]
        for axis in range(3):
            minimum[axis] = min(minimum[axis], item["centerM"][axis] - half[axis])
            maximum[axis] = max(maximum[axis], item["centerM"][axis] + half[axis])
    return {"min": [round(v, 9) for v in minimum],
            "max": [round(v, 9) for v in maximum],
            "size": [round(maximum[i] - minimum[i], 9) for i in range(3)]}


def create_defaults(output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    writer = load_fixture_writer()
    manifest = {"schemaVersion": 1, "generatorVersion": 1,
                "regenerate": "python scripts/create_default_environments.py",
                "environments": []}
    for definition in (GALLERY, BOTANICAL):
        provenance = {
            "source": f"Original authored offline {definition['displayName'].lower()} starter environment; not a World Labs export or a captured real location.",
            "owner": "3d-product-suite project",
            "reuseBasis": "Original project geometry and material colors. No third-party models, textures, photographs or provider output.",
            "allowedExternalDestinations": [],
        }
        geometry = {"coordinates": {"up": "Y", "units": "meters", "handedness": "right"},
                    "materials": definition["materials"], "boxes": definition["boxes"]}
        geometry_hash = hashlib.sha256(writer.canonical_json(geometry)).hexdigest()
        writer.MATERIALS = definition["materials"]
        writer.ROOM_BOXES = definition["boxes"]
        path = output / definition["assetFile"]
        details = writer.write_glb(path, geometry_hash)
        finalize_glb(path, definition, provenance)
        data = path.read_bytes()
        bounds = world_bounds(definition["boxes"])
        if bounds["max"][2] > -0.15:
            raise ValueError("Default environment enters the reserved near-field region")
        manifest["environments"].append({
            "id": definition["id"], "displayName": definition["displayName"],
            "description": definition["description"], "assetFile": path.name,
            "worldColor": definition["worldColor"], "format": "glb", "sourceUp": "Y",
            "scaleToMeters": 1, "translationM": [0, 0, 0], "rotationXyzw": [0, 0, 0, 1],
            "fixture": True, "defaultEnvironment": True, "reviewStatus": "unreviewed",
            "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "geometrySha256": geometry_hash, "boundsM": bounds,
            "provenance": provenance, "geometry": geometry, **details,
            "limitations": [
                "Authored starter environment; no validated generated-world quality or provider generation claim.",
                "All geometry is behind Z=-0.15 m. The exact product and contact plinth are deliberately absent and must come from the scene.",
                "The gallery's distant display ledge and the botanical planter are background decorations, not product placement or collision surfaces.",
                "Offline self-contained mesh; no API key, credits, image upload or network request is required.",
            ],
        })
    (output / "defaults.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "examples" / "worlds")
    args = parser.parse_args()
    manifest = create_defaults(args.output)
    for entry in manifest["environments"]:
        print(f"{entry['displayName']}: {args.output / entry['assetFile']} "
              f"({entry['bytes']} bytes; sha256 {entry['sha256']})")


if __name__ == "__main__":
    main()
