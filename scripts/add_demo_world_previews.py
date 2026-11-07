#!/usr/bin/env python3
"""Add selected, protected Atlas rooms to a previously published campaign."""
import argparse
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from film.scene import sample_scene, scene_digest, validate_scene
from film.scene_objects import resolve_scene_objects
from film.textures import verify_texture_asset
from film.worlds import safe_asset_path, verify_scene_assets
from scripts.build_campaign_demo import _json_bytes, public_metadata


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def add_demo_world_previews(base, overlay, output):
    bootstrap = read_json(base / "bootstrap.json")
    manifest = read_json(base / "manifest.json")
    main_project = bootstrap["project"]
    main_scene = main_project["scene"]
    if (bootstrap["demo"]["playbackMode"] != "sampled"
            or scene_digest(main_scene) != manifest["sceneDigest"]):
        raise ValueError("Use the existing sampled campaign and its manifest")
    index = read_json(overlay / "world-previews.json")
    worlds, previews = index["worlds"], index["worldPreviews"]
    world_ids = {world["id"] for world in worlds}
    if not worlds or len(world_ids) != len(worlds) or world_ids != previews.keys() or public_metadata(index) != index:
        raise ValueError("Every public world must have exactly one preview and public metadata")
    if output.is_symlink() or (output.exists() and any(output.iterdir())):
        raise ValueError("Choose an empty output directory")

    with tempfile.TemporaryDirectory(dir=output.parent, prefix=".world-previews-") as directory:
        staged = Path(directory) / "demo"
        staged.mkdir()
        records = {}

        def copy_records(entries, source):
            for record in entries:
                relative = record["path"]
                destination = staged / relative
                if source != staged:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(safe_asset_path(source, relative), destination)
                records[relative] = {key: record[key] for key in ("path", "sha256", "format", "bytes")}

        copy_records(verify_scene_assets(main_scene, base), base)
        for world in worlds:
            environment = world["environment"]
            relative = previews[world["id"]]
            if (environment["kind"] != "splat" or environment["revisionId"] != world["id"]
                    or not re.fullmatch(r"previews/[a-z0-9-]+\.json", relative)):
                raise ValueError("Expected a saved splat and a local preview file")
            payload = read_json(safe_asset_path(overlay, relative))
            project, samples = payload["project"], payload["samples"]
            scene = project["scene"]
            if (public_metadata(payload) != payload
                    or scene["environment"]["asset"] != environment["asset"]
                    or scene["environment"]["gaussianProtection"] != world["cameraProtection"]["bounds"]
                    or scene["product"]["revisionId"] != main_scene["product"]["revisionId"]):
                raise ValueError("Preview must use the published world, its camera bounds and the existing product")
            validate_scene(scene)
            sampled = sample_scene(scene)
            sampled["objects"] = resolve_scene_objects(scene)
            sampled["digest"] = scene_digest(scene)
            if samples != sampled or project["revisionId"] != sampled["digest"]:
                raise ValueError("Preview samples do not match the protected scene")

            copy_records(verify_scene_assets({"environment": environment}, overlay), overlay)
            cover = verify_texture_asset(world["previewAsset"], overlay)
            if cover["widthPx"] > 1024 or cover["heightPx"] > 1024 or cover["bytes"] > 1024 * 1024:
                raise ValueError("World covers must be at most 1024 pixels and 1 MiB")
            copy_records([cover], overlay)
            # An alternate can add materials to its set while sharing the base product.
            for path in (overlay / "assets").iterdir():
                if path.is_file() and not (staged / "assets" / path.name).exists():
                    shutil.copyfile(safe_asset_path(overlay, f"assets/{path.name}"), staged / "assets" / path.name)
            copy_records(verify_scene_assets(scene, staged), staged)
            preview_path = staged / relative
            preview_path.parent.mkdir(exist_ok=True)
            preview_path.write_bytes(_json_bytes(payload))

        for path in (staged / "assets").iterdir():
            if f"assets/{path.name}" not in records:
                path.unlink()
        bootstrap["worlds"] = worlds
        bootstrap["demo"]["worldPreviews"] = previews
        manifest["assets"] = [records[path] for path in sorted(records)]
        manifest["worldPreviews"] = previews
        (staged / "bootstrap.json").write_bytes(_json_bytes(bootstrap))
        (staged / "manifest.json").write_bytes(_json_bytes(manifest))
        shutil.copyfile(base / "samples.json", staged / "samples.json")
        staged.rename(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "overlay", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    add_demo_world_previews(**vars(parser.parse_args()))
