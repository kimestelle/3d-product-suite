"""Normalize a sample GLB for Gesso product import: center at bounds, optional scale, strip animation.

Writes a sibling GLB with one added root node carrying the centering translation
and scale, then verifies the result with film.products.inspect_product_glb.
"""
import argparse
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film.products import _IDENTITY, _accessor_rows, _multiply, _node_matrix, inspect_product_glb  # noqa: E402

BIN_CHUNK = 0x004E4942
JSON_CHUNK = 0x4E4F534A


def read_glb(payload):
    magic, version, length = struct.unpack_from("<4sII", payload)
    assert magic == b"glTF" and version == 2 and length == len(payload), "not a GLB 2 file"
    offset, document, binary = 12, None, b""
    while offset < len(payload):
        size, kind = struct.unpack_from("<II", payload, offset)
        chunk = payload[offset + 8:offset + 8 + size]
        if kind == JSON_CHUNK:
            document = json.loads(chunk)
        elif kind == BIN_CHUNK:
            binary = chunk
        offset += 8 + size
    return document, binary


def write_glb(document, binary):
    text = json.dumps(document, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary = binary + b"\0" * (-len(binary) % 4)
    body = struct.pack("<II", len(text), JSON_CHUNK) + text + struct.pack("<II", len(binary), BIN_CHUNK) + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def world_bounds(document, buffers):
    nodes = document["nodes"]
    minimum, maximum = [math.inf] * 3, [-math.inf] * 3

    def visit(index, parent):
        node = nodes[index]
        matrix = _multiply(parent, _node_matrix(node))
        if "mesh" in node:
            for primitive in document["meshes"][node["mesh"]]["primitives"]:
                for point in _accessor_rows(document, buffers, primitive["attributes"]["POSITION"], positions=True):
                    for axis in range(3):
                        value = sum(matrix[axis][column] * point[column] for column in range(3)) + matrix[axis][3]
                        minimum[axis] = min(minimum[axis], value)
                        maximum[axis] = max(maximum[axis], value)
        for child in node.get("children", []):
            visit(child, matrix)

    for root in document["scenes"][document.get("scene", 0)]["nodes"]:
        visit(root, _IDENTITY)
    return minimum, maximum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scale", type=float, default=1.0, help="Uniform scale to metres (e.g. 0.01 for centimetre files)")
    args = parser.parse_args()
    payload = args.source.read_bytes()
    document, binary = read_glb(payload)
    assert all("uri" not in buffer for buffer in document.get("buffers", [])), "external buffers are not supported"
    for key in ("animations", "skins", "cameras"):
        if document.pop(key, None) is not None:
            print(f"  stripped {key}")
    document.get("extensionsUsed", [])
    low, high = world_bounds(document, [binary])
    center = [(a + b) / 2 for a, b in zip(low, high)]
    scene = document["scenes"][document.get("scene", 0)]
    root = {"name": "gesso-prep-root", "children": list(scene["nodes"]),
            "translation": [-args.scale * value for value in center]}
    if args.scale != 1.0:
        root["scale"] = [args.scale] * 3
    document["nodes"].append(root)
    scene["nodes"] = [len(document["nodes"]) - 1]
    result = write_glb(document, binary)
    report = inspect_product_glb(result)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(result)
    dims = report["dimensionsM"]
    print(f"{args.source.name} -> {args.output.name}: {len(result)} bytes, dimensions {[round(v, 4) for v in dims]} m, "
          f"vertices {report['vertexCount']}, raw center was {[round(v, 4) for v in center]}")


if __name__ == "__main__":
    main()
