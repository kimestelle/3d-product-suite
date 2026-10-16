#!/usr/bin/env python3
"""One World Labs world, one HQ export, and fifteen unreviewed probe scenes.

Only explicit execution of this script can spend credits. Tests inject a fake
client. Existing operation IDs recover accepted work without another paid POST.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film import probes, worldlabs, worlds  # noqa: E402

DEFAULT_PROMPT = (
    "A refined botanical product photography studio with warm limestone walls, "
    "subtle olive foliage in the distant background, and soft daylight from a large side window. "
    "Leave the central foreground empty for a separately modeled small skincare bottle and its pedestal. "
    "No products, labels, typography, people, or floating objects. Calm, realistic materials."
)
DEFAULT_ENVIRONMENTS = {
    "botanical-studio": DEFAULT_PROMPT,
    "warm-gallery": "A quiet warm limestone art gallery, soft side light, subtle natural materials and an empty foreground for a separately modeled product and pedestal. No products, labels, text or people.",
    "modern-loft": "A refined modern loft with muted concrete, distant greenery and diffuse window light. Leave the central foreground empty for a separately modeled product and pedestal. No products, labels, text or people.",
}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--output", type=Path, default=Path("worldlabs-experiment"))
    result.add_argument("--experiment-id", default=os.environ.get("WORLDLABS_EXPERIMENT_ID") or "world-comparison")
    result.add_argument("--prompt", default=os.environ.get("WORLDLABS_PROMPT") or "")
    result.add_argument("--default-environment", choices=tuple(DEFAULT_ENVIRONMENTS),
                        default=os.environ.get("WORLDLABS_DEFAULT_ENVIRONMENT") or "botanical-studio")
    result.add_argument("--reference-image-url", default=os.environ.get("WORLDLABS_REFERENCE_IMAGE_URL") or "")
    result.add_argument("--image-path", type=Path)
    result.add_argument("--name", default=os.environ.get("WORLDLABS_WORLD_NAME") or "Botanical product studio")
    result.add_argument("--model", choices=tuple(worldlabs.TEXT_GENERATION_MAX_CREDITS),
                        default=os.environ.get("WORLDLABS_MODEL") or "marble-1.1")
    result.add_argument("--budget-credits", type=int, default=int(os.environ.get("WORLDLABS_BUDGET_CREDITS") or "6000"))
    result.add_argument("--world-id", default=os.environ.get("WORLDLABS_WORLD_ID") or "")
    result.add_argument("--generation-operation-id", default=os.environ.get("WORLDLABS_GENERATION_OPERATION_ID") or "")
    result.add_argument("--mesh-operation-id", default=os.environ.get("WORLDLABS_MESH_OPERATION_ID") or "")
    result.add_argument("--owner", default=os.environ.get("GITHUB_REPOSITORY_OWNER") or "World Labs account owner")
    result.add_argument("--timeout-minutes", type=float, default=90)
    result.add_argument("--scene", type=Path, default=ROOT / "examples" / "bottle.scene.json")
    return result


def _summary(message):
    print(message, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(message + "\n\n")


def _record_identity(label, state):
    if state.get("operationId"):
        _summary(f"{label}_operation_id: `{state['operationId']}`")
    if state.get("worldId"):
        _summary(f"world_id: `{state['worldId']}`")


def _wait(client, directory, *, deadline, monotonic, sleep):
    while monotonic() < deadline:
        try:
            state = client.poll_generation(directory)
        except worldlabs.WorldLabsError as error:
            transient = any(text in str(error) for text in ("connection failed", "HTTP 429", "HTTP 502", "HTTP 503", "HTTP 504"))
            if not transient:
                raise
            print("A read-only operation poll failed temporarily; waiting before polling the same operation.", flush=True)
        else:
            if state["state"] == "completed":
                return state
            if state["state"] == "failed":
                raise worldlabs.WorldLabsError(state["error"])
        sleep(min(15, max(0, deadline - monotonic())))
    raise worldlabs.WorldLabsError("Operation polling time budget expired. Recover the saved operation ID; do not start another generation.")


def prepare_reconstructed_mesh(pair, library_root, output_dir, *, converter=None):
    """The Gaussian condition ends as an experimental local mesh, with lineage."""
    if converter is None:
        from film.splat_mesh import convert_splat
        converter = convert_splat
    environment = pair["splat"]["environment"]
    asset = environment["asset"]
    source = worlds.safe_asset_path(library_root, asset["path"])
    with tempfile.TemporaryDirectory(prefix="gaussian-mesh-") as temporary:
        destination = Path(temporary) / "reconstructed-world.glb"
        report = converter(source, destination, resolution=96, iso_level=0.5, max_splats=100000,
                           source_up=asset["sourceUp"])
        stable_report = copy.deepcopy(report)
        stable_report.pop("elapsedSeconds", None)
        if isinstance(stable_report.get("decoder"), dict):
            stable_report["decoder"].pop("output", None)
        provenance = copy.deepcopy(environment["provenance"])
        provenance.update(representation="gaussian-reconstructed-mesh", sourceSplatSha256=asset["sha256"],
                          reconstruction=stable_report,
                          reconstructionReview="Experimental density isosurface mesh. Not an official World Labs visual mesh. Review holes, thin structures, appearance and geometry before use.")
        entry = worlds.import_world(destination, library_root, name="Gaussian reconstructed mesh", provenance=provenance,
                                    source_up="Y", scale_to_meters=asset["scaleToMeters"],
                                    rotation_xyzw=asset["rotationXyzw"], translation_m=asset["translationM"])
    worldlabs._atomic_json(Path(output_dir) / "reconstruction" / "report.json", report)
    pair = dict(pair, gaussianMesh=entry, reconstruction=report)
    return pair


def preflight_reconstruction():
    """Check local requirements before any provider work can incur a charge."""
    from film.splat_mesh import _dependencies
    _dependencies()
    worldlabs._require(shutil.which("node"), "SPZ reconstruction requires Node.js before generation")
    package = ROOT / "web" / "node_modules" / "@sparkjsdev" / "spark" / "package.json"
    worldlabs._require(package.is_file(), "Install the pinned SPZ decoder with npm ci --prefix web before generation")
    worldlabs._require(json.loads(package.read_text())["version"] == "2.3.1", "SPZ decoder version must match pinned Spark 2.3.1")


def run_experiment(args, *, client=None, monotonic=time.monotonic, sleep=time.sleep, converter=None):
    if not args.prompt.strip():
        args.prompt = DEFAULT_ENVIRONMENTS[args.default_environment]
    worldlabs._identifier(args.experiment_id, "experiment ID")
    worldlabs._require(args.budget_credits > 0, "Credit budget must be positive")
    worldlabs._require(0 < args.timeout_minutes <= 95, "Polling time budget must be between 0 and 95 minutes")
    worldlabs._require(not (args.world_id and args.generation_operation_id),
                       "Supply an existing world ID or a generation operation ID, not both")
    estimate = worldlabs.estimate_pair(args.model)
    generation_dir = args.output / "provider-state" / "generation"
    mesh_dir = args.output / "provider-state" / "mesh-export"
    has_generation = (generation_dir / "generation.json").exists()
    recoverable = args.world_id or args.generation_operation_id or has_generation
    worldlabs._require(not args.mesh_operation_id or recoverable,
                       "Recovering a mesh operation also requires its existing world or generation operation ID")
    worldlabs._require(not (int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")) > 1 and not recoverable),
                       "A GitHub rerun cannot create a fresh paid world. Supply the saved world or generation operation ID in a recovery dispatch.")
    # Without an existing world, conservatively reserve one generation and HQ
    # export against the whole experiment cap, including generation recovery.
    maximum = estimate["meshExportMaxCredits"] + (0 if args.world_id else estimate["generationMaxCredits"])
    worldlabs._require(maximum <= args.budget_credits, "Documented experiment maximum exceeds the authorized credit cap")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "experiment.json"
    worldlabs._require(not (args.image_path and args.reference_image_url), "Supply a reference image URL or local image path, not both")
    if args.image_path:
        worldlabs._require(args.image_path.is_file() and args.image_path.stat().st_size <= 6 * 1024 * 1024,
                           "Private inline reference image must be a file of at most 6 MiB")
    image_fingerprint = hashlib.sha256(args.image_path.read_bytes()).hexdigest() if args.image_path else args.reference_image_url
    request_digest = hashlib.sha256(json.dumps({"prompt": args.prompt, "image": image_fingerprint}, sort_keys=True).encode()).hexdigest()
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        worldlabs._require(manifest.get("promptSha256") == request_digest and manifest.get("model") == args.model,
                           "Existing experiment uses a different model or prompt; resume it with its original settings")
        worldlabs._require(manifest.get("experimentId") == args.experiment_id,
                           "Existing output belongs to a different experiment ID")
    else:
        manifest = {"schemaVersion": 1, "provider": "worldlabs", "model": args.model,
                    "experimentId": args.experiment_id,
                    "promptSha256": request_digest, "budgetCredits": args.budget_credits,
                    "documentedMaximumCredits": maximum, "pricingCheckedAt": worldlabs.DOCUMENTATION_CHECKED_AT,
                    "qualityGate": "unreviewed", "rendersCompleted": False, "state": "prepared",
                    "referenceImageProvided": bool(args.image_path or args.reference_image_url),
                    "alignmentReview": "SPZ uses provider metric metadata. HQ visual GLB metric scale and ground remain uncalibrated; review before comparing quality."}
    worldlabs._atomic_json(manifest_path, manifest)
    if converter is None:
        preflight_reconstruction()
    client = client or worldlabs.WorldLabsClient.from_environment()
    deadline = monotonic() + args.timeout_minutes * 60
    _summary(f"Documented maximum: {maximum} API credits (${maximum / 1250:.3f}); authorized cap: {args.budget_credits} credits. No automatic paid retries.")
    try:
        # The provider's own low-balance threshold permits overages. Preflight
        # the maximum cost of every new operation, not merely its threshold.
        existing_world = client.get_world(args.world_id) if args.world_id else None
        if existing_world is not None:
            worldlabs._require(existing_world.get("world_id") == args.world_id, "Provider returned a different world ID")
        cached_mesh = bool((((existing_world or {}).get("assets") or {}).get("mesh") or {}).get("hq_mesh_url"))
        new_generation_cost = 0 if recoverable else estimate["generationMaxCredits"]
        new_mesh_cost = 0 if cached_mesh or args.mesh_operation_id or (mesh_dir / "generation.json").exists() else worldlabs.HQ_MESH_EXPORT_CREDITS
        client._check_balance(new_generation_cost + new_mesh_cost)
        world_id = args.world_id
        if not world_id:
            if args.generation_operation_id:
                state = client.attach_operation(generation_dir, args.generation_operation_id,
                    operation_type="generation", max_credits=estimate["generationMaxCredits"])
            elif has_generation:
                state = worldlabs.load_generation(generation_dir)
            else:
                state = client.create_generation(generation_dir, name=args.name, text_prompt=args.prompt,
                    model=args.model, max_credits=estimate["generationMaxCredits"],
                    image_url=args.reference_image_url or None, image_path=args.image_path)
            _record_identity("generation", state)
            manifest.update(state="generating", generationOperationId=state.get("operationId"))
            worldlabs._atomic_json(manifest_path, manifest)
            if state["state"] != "completed":
                state = _wait(client, generation_dir, deadline=deadline, monotonic=monotonic, sleep=sleep)
            world_id = state["worldId"]
            manifest["generationSettledCredits"] = state.get("settledCredits")
            worldlabs._require(not state.get("budgetExceeded"),
                               "Provider generation settled above its documented authorized maximum; no mesh export will be submitted")
        _summary(f"world_id: `{world_id}`")
        manifest.update(worldId=world_id, state="world-ready")
        worldlabs._atomic_json(manifest_path, manifest)
        world = existing_world or client.get_world(world_id)
        worldlabs._require(world.get("world_id") == world_id, "Provider returned a different world ID")
        if args.mesh_operation_id:
            state = client.attach_operation(mesh_dir, args.mesh_operation_id, operation_type="mesh-export",
                                            world_id=world_id, max_credits=worldlabs.HQ_MESH_EXPORT_CREDITS)
        elif (mesh_dir / "generation.json").exists():
            state = worldlabs.load_generation(mesh_dir)
            worldlabs._require(state.get("worldId") == world_id, "Existing mesh operation belongs to a different world")
        elif ((world.get("assets") or {}).get("mesh") or {}).get("hq_mesh_url"):
            state = None
            manifest["meshExportReusedExistingAsset"] = True
        else:
            state = client.create_mesh_export(mesh_dir, world_id, max_credits=worldlabs.HQ_MESH_EXPORT_CREDITS)
        if state is not None:
            _record_identity("mesh", state)
            manifest.update(state="exporting-mesh", meshOperationId=state.get("operationId"))
            worldlabs._atomic_json(manifest_path, manifest)
            if state["state"] != "completed":
                state = _wait(client, mesh_dir, deadline=deadline, monotonic=monotonic, sleep=sleep)
            manifest["meshSettledCredits"] = state.get("settledCredits")
        pair = client.import_world_pair(world_id, args.output / "world-library", name=args.name, owner=args.owner,
                                       reuse_basis="Generated in the user's World Labs API account; review the account's applicable asset terms",
                                       resolution="500k", mesh_variant="textured")
        manifest["state"] = "reconstructing-gaussians"
        worldlabs._atomic_json(manifest_path, manifest)
        pair = prepare_reconstructed_mesh(pair, args.output / "world-library", args.output, converter=converter)
        worldlabs._atomic_json(args.output / "world-pair.json", pair)
        comparison_path = args.output / "comparison"
        if not (comparison_path / "comparison.json").exists():
            probes.create_comparison(args.scene, args.output / "world-library", comparison_path,
                                     mesh_id=pair["mesh"]["id"], splat_id=pair["gaussianMesh"]["id"], world_id=world_id)
        else:
            existing = json.loads((comparison_path / "comparison.json").read_text())
            expected = {pair["mesh"]["id"], pair["gaussianMesh"]["id"]}
            worldlabs._require(set(existing.get("conditions", {}).values()) == expected
                               and existing.get("pairing", {}).get("worldId") == world_id,
                               "Existing comparison pins different immutable worlds; use a new output directory with the saved world ID")
        manifest.update(state="prepared-for-review", meshWorldRevision=pair["mesh"]["id"], splatWorldRevision=pair["splat"]["id"],
                        gaussianMeshRevision=pair["gaussianMesh"]["id"],
                        comparisonManifest="comparison/comparison.json", sceneCount=15)
        worldlabs._atomic_json(manifest_path, manifest)
        _summary("Prepared one official visual GLB and one mesh reconstructed locally from the same world's Gaussian SPZ, plus fifteen probe scenes. Alignment, reconstruction and rendering quality remain unreviewed; no final renders were produced by this workflow.")
        return manifest
    except Exception:
        manifest.update(state="incomplete", recovery="Use the saved provider-state artifact or the logged world/operation IDs. Do not create another world to recover this experiment.")
        worldlabs._atomic_json(manifest_path, manifest)
        raise


def main():
    try:
        run_experiment(parser().parse_args())
        return 0
    except (worldlabs.WorldLabsError, ValueError, OSError) as error:
        # Never print provider response objects, headers, environment, or a
        # traceback containing a credential-bearing request.
        message = str(error)
        key = os.environ.get("WORLDLABS_API_KEY")
        if key:
            message = message.replace(key, "<redacted>")
        print("World Labs experiment incomplete: " + message, file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
