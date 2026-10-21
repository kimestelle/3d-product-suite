"""Generate one World Labs world from a local inspiration photo and import its free assets.

Generation only (1,580 credits for marble-1.1): no HQ mesh export. Downloads the
500k SPZ splat, the free collider GLB and the free panorama, imports the splat
into the local world library with the provider's metric semantics, and keeps the
collider and panorama beside the provider state for the renderer.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film import worldlabs, worlds  # noqa: E402


def _urls(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _urls(child, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _urls(child, f"{path}[{index}]")
    elif isinstance(value, str) and value.startswith("https://"):
        yield path, value


def _first(urls, *needles):
    for path, url in urls:
        lowered = path.lower()
        if all(needle in lowered for needle in needles):
            return path, url
    return None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Per-world output directory")
    parser.add_argument("--name", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image-path", type=Path)
    parser.add_argument("--model", default="marble-1.1", choices=tuple(worldlabs.TEXT_GENERATION_MAX_CREDITS))
    parser.add_argument("--library", type=Path, default=ROOT / "workspace-data")
    parser.add_argument("--owner", default="Ximing Luo")
    parser.add_argument("--reuse-basis", default="Generated on the user's own World Labs API account for the Gesso demo")
    parser.add_argument("--world-id", default="", help="Skip generation and import an existing provider world")
    parser.add_argument("--resolution", default="500k", choices=("full_res", "500k", "150k", "100k"))
    parser.add_argument("--timeout-minutes", type=float, default=40)
    parser.add_argument("--poll-seconds", type=float, default=15)
    args = parser.parse_args()

    client = worldlabs.WorldLabsClient.from_environment()
    args.output.mkdir(parents=True, exist_ok=True)
    generation_dir = args.output / "provider-state" / "generation"
    generation_dir.mkdir(parents=True, exist_ok=True)
    world_id = args.world_id
    if not world_id:
        if (generation_dir / "generation.json").exists():
            state = worldlabs.load_generation(generation_dir)
            print("Resuming saved generation", state.get("operationId"))
        else:
            expected = worldlabs.estimate_pair(args.model)["generationMaxCredits"]
            print(f"Balance before: {client.get_credits().get('remaining_credits')} credits; expected charge {expected}")
            state = client.create_generation(generation_dir, name=args.name, text_prompt=args.prompt,
                                             max_credits=expected, model=args.model, image_path=args.image_path)
            print("Accepted operation", state.get("operationId"))
        deadline = time.monotonic() + args.timeout_minutes * 60
        while state.get("state") not in ("completed", "failed"):
            worldlabs._require(time.monotonic() < deadline, "Timed out waiting for the world; rerun to resume polling")
            time.sleep(args.poll_seconds)
            state = client.poll_generation(generation_dir)
            print("  state:", state.get("state"), time.strftime("%H:%M:%S"), flush=True)
        worldlabs._require(state["state"] == "completed", "World generation failed: " + str(state.get("error")))
        world_id = state["worldId"]
        print("World", world_id, "settled credits:", state.get("settledCredits"))

    world = client.get_world(world_id)
    (args.output / "world.json").write_text(json.dumps(client._redact(world), indent=2), encoding="utf-8")
    assets = world.get("assets") or {}
    splats = assets.get("splats") or {}
    spz_urls = splats.get("spz_urls") or {}
    worldlabs._require(spz_urls.get(args.resolution), "World has no SPZ at the requested resolution")
    semantics = splats.get("semantics_metadata") or {}
    scale, ground = semantics.get("metric_scale_factor", 1.0), semantics.get("ground_plane_offset", 0.0)
    urls = list(_urls(assets))
    collider_path, collider_url = _first(urls, "collider")
    pano_path, pano_url = _first(urls, "pano")
    print("asset url keys:", [path for path, _ in urls])

    downloads = {"splat": (spz_urls[args.resolution], args.output / "gaussian-world.spz")}
    if collider_url:
        downloads["collider"] = (collider_url, args.output / "collider.glb")
    if pano_url:
        downloads["pano"] = (pano_url, args.output / ("pano" + (".jpg" if ".jpg" in pano_url.lower() else ".png")))
    for label, (url, destination) in downloads.items():
        if destination.exists() and destination.stat().st_size > 0:
            print(f"  {label}: already downloaded")
            continue
        client._download(url, destination)
        print(f"  {label}: {destination.stat().st_size} bytes")

    provenance = {"source": "World Labs generated world " + world_id, "owner": args.owner, "reuseBasis": args.reuse_basis,
                  "allowedExternalDestinations": [], "provider": "worldlabs", "providerWorldId": world_id,
                  "providerModel": world.get("model"),
                  "providerSemantics": {"metric_scale_factor": scale, "ground_plane_offset": ground},
                  "axisConvention": "marble_raw_opencv", "documentationCheckedAt": worldlabs.DOCUMENTATION_CHECKED_AT,
                  "representation": "gaussian-spz", "splatResolution": args.resolution,
                  "alignmentBasis": "World Labs SPZ metric semantics, ground offset, then OpenCV-to-OpenGL rotation",
                  "metricScaleInferred": scale != 1.0, "colliderFile": str(downloads.get("collider", (None, ""))[1] or ""),
                  "panoFile": str(downloads.get("pano", (None, ""))[1] or ""),
                  "alignmentReview": "Unreviewed initial alignment from provider metadata."}
    worlds.validate_provenance(provenance)
    entry = worlds.import_world(downloads["splat"][1], args.library, name=args.name, provenance=provenance,
                                source_up="Y", scale_to_meters=scale, rotation_xyzw=[1, 0, 0, 0],
                                translation_m=[0, ground, 0])
    summary = {"worldId": world_id, "libraryWorldId": entry["id"], "name": args.name, "scale": scale, "ground": ground,
               "files": {label: str(path) for label, (_, path) in downloads.items()}, "assetUrlKeys": [p for p, _ in urls]}
    (args.output / "world-set.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"Balance after: {client.get_credits().get('remaining_credits')} credits")


if __name__ == "__main__":
    main()
