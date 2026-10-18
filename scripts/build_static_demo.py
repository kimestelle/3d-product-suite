#!/usr/bin/env python3
"""Build the public browser demo entirely from original, offline project fixtures.

This script deliberately does not read workspace-data, downloaded manufacturer
assets, World Labs results, environment variables or account credentials. The
MORA product, two authored room GLBs and pixel label below are original fictional
fixtures. No provider or other network request is made.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import zlib


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film.scene import load_scene, sample_scene, scene_digest  # noqa: E402
from film.scene_objects import resolve_scene_objects  # noqa: E402
from film.textures import import_texture  # noqa: E402
from film.worlds import _immutable_write, import_world, verify_scene_assets  # noqa: E402


def demo_label_png() -> bytes:
    """Draw original MORA / DEMO pixel artwork, including four UV corner marks."""
    width, height = 256, 320
    pixels = bytearray([241, 233, 210, 255] * width * height)

    def rect(x, y, w, h, color):
        for row in range(y, min(height, y + h)):
            for col in range(x, min(width, x + w)):
                offset = (row * width + col) * 4
                pixels[offset:offset + 4] = bytes(color)

    green = (36, 66, 48, 255)
    glyphs = {
        "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
        "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
        "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
        "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
        "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
        "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    }

    def text(word, top, scale):
        left = (width - (len(word) * 6 - 1) * scale) // 2
        for index, letter in enumerate(word):
            for y, row in enumerate(glyphs[letter]):
                for x, bit in enumerate(row):
                    if bit == "1":
                        rect(left + (index * 6 + x) * scale, top + y * scale, scale, scale, green)

    text("MORA", 82, 8)
    text("DEMO", 222, 3)
    rect(38, 174, 180, 2, green)
    # Different corners make orientation/rotation easy to see in the UV editor.
    for x, y, color in [(9, 9, green), (231, 9, (179, 119, 65, 255)),
                         (9, 295, (134, 153, 105, 255)), (231, 295, (99, 108, 133, 255))]:
        rect(x, y, 16, 16, color)

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)

    scanlines = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b""))


def _write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


def _build_demo(output: Path, library: Path) -> dict:
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    scene = load_scene(ROOT / "examples" / "bottle.scene.json")
    scene["environment"]["plinth"]["visible"] = False
    scene["environment"]["floorY"] = 0
    scene["placement"]["restsOn"] = "floor"
    texture = import_texture(demo_label_png(), library, filename="mora-original-demo.png")["asset"]
    label = next(component for component in scene["product"]["components"] if component["id"] == "label")
    label["labelTexture"] = {
        "asset": texture,
        "mapping": {"mode": "planar", "face": "front", "scale": [.8, .8], "offset": [0, 0], "rotationDegrees": 0},
        "material": {"baseColor": [1, 1, 1, 1], "roughness": .6, "metallic": 0},
    }

    # Explicit allowlist: never package arbitrary world-library or private assets.
    defaults_path = ROOT / "examples" / "worlds" / "defaults.json"
    defaults = json.loads(defaults_path.read_text(encoding="utf-8"))
    worlds = []
    for default in defaults["environments"]:
        if default["assetFile"] not in {"default-gallery.glb", "default-botanical.glb"}:
            raise ValueError("Only original offline room defaults may enter the public demo")
        source = defaults_path.parent / default["assetFile"]
        if hashlib.sha256(source.read_bytes()).hexdigest() != default["sha256"]:
            raise ValueError("Original default environment does not match its manifest")
        world = import_world(source, library, name=f"Default · {default['displayName']}",
                             provenance=default["provenance"], source_up="Y", fixture=True)
        world["environment"]["worldColor"] = deepcopy(default["worldColor"])
        world["environment"]["plinth"] = deepcopy(scene["environment"]["plinth"])
        world["environment"]["floorY"] = 0
        worlds.append(world)

    verify_scene_assets(scene, library)
    sampled = sample_scene(scene)
    sampled["objects"] = resolve_scene_objects(scene)
    sampled["digest"] = scene_digest(scene)
    project = {"id": "demo", "name": "Gesso / browser demo", "scene": scene,
               "revisionId": sampled["digest"], "approvedRevisionId": None}
    bootstrap = {
        "schemaVersion": 1, "project": project,
        "projects": [{key: value for key, value in project.items() if key != "scene"}],
        "worlds": worlds, "jobs": [],
        "capabilities": {"staticDemo": True, "blenderAvailable": False, "ffmpegAvailable": False,
                         "githubWorldsAvailable": False, "worldlabsConfigured": False,
                         "productMeshImportAvailable": False, "textureImportAvailable": False},
        "demo": {"labelAsset": texture, "persistence": "Changes are kept in this browser session only.",
                 "provenance": "Original fictional MORA fixture, original pixel label, and original offline room defaults. No manufacturer assets or generated provider results."},
    }
    assets = [path for path in (library / "assets").iterdir()]
    allowed = {"bootstrap.json", "samples.json", *[f"assets/{path.name}" for path in assets]}
    # A stale/private file in a reused output directory must stop publishing.
    # Do not delete or silently include content that this builder does not own.
    for path in output.rglob("*"):
        if path.is_symlink() or (path.is_file() and path.relative_to(output).as_posix() not in allowed):
            raise ValueError("Demo output contains an unexpected file; choose an empty output directory")
    for path in assets:
        _immutable_write(output / "assets" / path.name, path.read_bytes())
    _write_json(output / "bootstrap.json", bootstrap)
    _write_json(output / "samples.json", sampled)
    return bootstrap


def build_demo(output: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="gesso-original-demo-") as temporary:
        return _build_demo(output, Path(temporary))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "web" / "public" / "demo")
    args = parser.parse_args()
    bootstrap = build_demo(args.output)
    print(f"Built original static demo: {len(bootstrap['worlds'])} offline worlds; 360 sampled frames; no API calls")


if __name__ == "__main__":
    main()
