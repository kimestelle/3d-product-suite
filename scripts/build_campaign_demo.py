#!/usr/bin/env python3
"""Package one explicitly chosen campaign for a browser-only demonstration.

Unlike build_static_demo.py, this command publishes the named scene's assets.
It never copies a workspace, scans for other projects, or makes a network call.
Only verified, content-addressed references enter the output directory.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path, PureWindowsPath
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film.textures import verify_texture_asset
from film.products import hydrate_product_nodes  # noqa: E402
from film.scene import sample_scene, scene_digest, validate_scene  # noqa: E402
from film.scene_objects import resolve_scene_objects  # noqa: E402
from film.worlds import _immutable_write, import_world, safe_asset_path, verify_scene_assets  # noqa: E402


def public_metadata(value):
    """Keep credit while reducing local filesystem references to filenames."""
    if isinstance(value, dict):
        if any(re.sub(r"[^a-z]", "", key.lower()) in {
            "apikey", "accesstoken", "refreshtoken", "authorization", "password", "secret"
        } for key in value):
            raise ValueError("Scene metadata contains a credential field; remove it before publishing")
        return {key: public_metadata(item) for key, item in value.items()}
    if isinstance(value, list):
        return [public_metadata(item) for item in value]
    if isinstance(value, str):
        if value.startswith(("/", "~/", "file://")):
            return Path(value.removeprefix("file://")).name
        if re.match(r"^[A-Za-z]:[\\/]", value):
            return PureWindowsPath(value).name
        if re.search(r"(?:/Users/|/home/|file://|[A-Za-z]:\\Users\\)", value):
            raise ValueError("Scene contains an embedded private filesystem path; redact it before publishing")
    return value


def _json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def build_campaign_demo(scene_path: Path, library: Path, output: Path, *, name="Ambre perfume / demo", include_audio=False, world_replacements: dict[str, Path] | None = None):
    """Publish the selected campaign; original scene and assets stay unchanged."""
    scene_path, library = Path(scene_path), Path(library).resolve()
    output = Path(output)
    if output.is_symlink():
        raise ValueError("Demo output must not be a symlink")
    output = output.resolve()
    raw = json.loads(scene_path.read_text(encoding="utf-8"))
    scene = deepcopy(raw.get("scene", raw))
    source_digest = scene_digest(validate_scene(scene))
    omitted_audio = bool(scene.get("audio")) and not include_audio
    if not include_audio:
        scene.pop("audio", None)
    scene = public_metadata(scene)
    hydrate_product_nodes(scene, library)
    validate_scene(scene)
    records = verify_scene_assets(scene, library)
    sources = {record["path"]: (library, record) for record in records}
    worlds = []
    world_replacements = world_replacements or {}
    if scene["environment"]["kind"] != "authored":
        env = deepcopy(scene["environment"])
        worlds.append({"id": env["revisionId"], "name": env.get("displayName", "Saved world"), "environment": env})

    with tempfile.TemporaryDirectory(prefix="gesso-campaign-worlds-") as temporary:
        defaults_library = Path(temporary)
        defaults_path = ROOT / "examples/worlds/defaults.json"
        defaults = json.loads(defaults_path.read_text())
        unknown = set(world_replacements) - {item["id"] for item in defaults["environments"]}
        if unknown:
            raise ValueError(f"Unknown offline world replacement: {', '.join(sorted(unknown))}")
        for default in defaults["environments"]:
            replacement = world_replacements.get(default["id"])
            if replacement is not None:
                world = public_metadata(json.loads(Path(replacement).read_text(encoding="utf-8")))
                if not isinstance(world, dict) or not isinstance(world.get("id"), str) or not isinstance(world.get("name"), str):
                    raise ValueError("World replacement needs an id, name and environment")
                validate_scene({**scene, "environment": world["environment"]})
                world_records = verify_scene_assets({"environment": world["environment"]}, library)
                if world.get("previewAsset") is not None:
                    preview = verify_texture_asset(world["previewAsset"], library)
                    if preview["widthPx"] > 1024 or preview["heightPx"] > 1024 or preview["bytes"] > 1024 * 1024:
                        raise ValueError("World preview must be at most 1024px and 1 MiB")
                    world_records.append(preview)
                if any(item["id"] == world["id"] for item in worlds):
                    raise ValueError("World replacement duplicates an included world")
                worlds.append(world)
                for record in world_records:
                    sources[record["path"]] = (library, record)
                continue
            if default["assetFile"] not in {"default-gallery.glb", "default-botanical.glb"}:
                raise ValueError("Only the original offline defaults may accompany a campaign")
            source = defaults_path.parent / default["assetFile"]
            if hashlib.sha256(source.read_bytes()).hexdigest() != default["sha256"]:
                raise ValueError("Offline default does not match its manifest")
            world = import_world(source, defaults_library, name=default["displayName"], provenance=default["provenance"], source_up="Y", fixture=True)
            world["environment"]["worldColor"] = deepcopy(default["worldColor"])
            world["environment"]["plinth"] = deepcopy(scene["environment"]["plinth"])
            worlds.append(world)
            for record in verify_scene_assets({"environment": world["environment"]}, defaults_library):
                sources[record["path"]] = (defaults_library, record)

        for world in worlds:
            for key in ("plinth", "props", "floorY", "studioSizeM"):
                if key in scene["environment"]:
                    world["environment"][key] = deepcopy(scene["environment"][key])
                else:
                    world["environment"].pop(key, None)
        sampled = sample_scene(scene)
        sampled["objects"] = resolve_scene_objects(scene)
        sampled["digest"] = scene_digest(scene)
        project = {"id": "demo", "name": name, "scene": scene, "revisionId": sampled["digest"], "approvedRevisionId": None}
        allowed_parts = []
        for component in scene["product"]["components"]:
            allowed_parts.append(component["id"])
            allowed_parts.extend(f"{component['id']}::node:{node['nodeIndex']}" for node in component.get("sourceNodes", []) if node["drawable"])
        bootstrap = {
            "schemaVersion": 1, "project": project,
            "projects": [{key: value for key, value in project.items() if key != "scene"}],
            "worlds": worlds, "jobs": [],
            "capabilities": {"staticDemo": True, "blenderAvailable": False, "ffmpegAvailable": False,
                             "githubWorldsAvailable": False, "worldlabsConfigured": False,
                             "productMeshImportAvailable": False, "textureImportAvailable": False},
            "demo": {"playbackMode": "sampled", "allowedPartIds": allowed_parts,
                     "persistence": "Changes are kept in this browser session only.",
                     "provenance": "Selected campaign with its saved world and explicitly packaged room choices. Product and world credit remains in the scene.",
                     "audioOmitted": omitted_audio},
        }
        manifest = {"schemaVersion": 1, "sourceSceneDigest": source_digest, "sceneDigest": sampled["digest"],
                    "frameCount": len(sampled["frames"]), "audioOmitted": omitted_audio,
                    "assets": [{key: record[key] for key in ("path", "sha256", "format", "bytes")}
                               for _, record in sorted(sources.values(), key=lambda item: item[1]["path"])]}
        allowed = {"bootstrap.json", "samples.json", "manifest.json", *sources}
        if output.exists():
            for path in output.rglob("*"):
                if path.is_symlink() or (path.is_file() and path.relative_to(output).as_posix() not in allowed):
                    raise ValueError("Demo output contains an unexpected file; choose an empty output directory")
        output.mkdir(parents=True, exist_ok=True)
        for relative, (source_root, record) in sources.items():
            payload = safe_asset_path(source_root, relative).read_bytes()
            if hashlib.sha256(payload).hexdigest() != record["sha256"]:
                raise ValueError("Asset changed while packaging")
            _immutable_write(output / relative, payload)
        for filename, value in (("bootstrap.json", bootstrap), ("samples.json", sampled), ("manifest.json", manifest)):
            _immutable_write(output / filename, _json_bytes(value))
    return bootstrap, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", default="Ambre perfume / demo")
    parser.add_argument("--include-audio", action="store_true", help="Also publish the selected campaign's referenced soundtrack")
    parser.add_argument("--replace-world", action="append", default=[], metavar="DEFAULT_ID=WORLD_JSON",
                        help="Replace one offline room choice with an explicitly selected saved world from the same asset library")
    args = parser.parse_args()
    replacements = {}
    for spec in args.replace_world:
        default_id, separator, path = spec.partition("=")
        if not separator or not default_id or not path or default_id in replacements:
            parser.error("Each --replace-world must be a unique DEFAULT_ID=WORLD_JSON pair")
        replacements[default_id] = Path(path)
    _, manifest = build_campaign_demo(args.scene, args.library, args.output, name=args.name, include_audio=args.include_audio, world_replacements=replacements)
    print(json.dumps({"frames": manifest["frameCount"], "assets": len(manifest["assets"]), "assetBytes": sum(item["bytes"] for item in manifest["assets"]), "audioOmitted": manifest["audioOmitted"]}))


if __name__ == "__main__":
    main()
