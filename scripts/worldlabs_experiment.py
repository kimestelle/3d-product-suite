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

from film.world_requests import DEFAULT_PROMPT, DEFAULT_ENVIRONMENTS, generation_identity  # noqa: E402
from film.world_cache import WorldCache, copy_payload, read_json, verify_pair  # noqa: E402


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--output", type=Path, default=Path("worldlabs-experiment"))
    result.add_argument("--cache-dir", type=Path, help="Persistent cache directory (default: output parent/.worldlabs-cache)")
    result.add_argument("--force-new", action="store_true",
                        default=os.environ.get("WORLDLABS_FORCE_NEW", "").lower() in ("1", "true", "yes"),
                        help="Explicitly create a new paid variation; reruns of the same GitHub run/local experiment remain resumable")
    result.add_argument("--seed", type=int, default=42)
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
    invisible_since = None
    while monotonic() < deadline:
        try:
            state = client.poll_generation(directory)
        except worldlabs.WorldLabsError as error:
            transient = any(text in str(error) for text in ("connection failed", "HTTP 429", "HTTP 502", "HTTP 503", "HTTP 504"))
            if "HTTP 404" in str(error):
                saved = worldlabs.load_generation(directory)
                if saved.get("operationType", "generation") != "generation":
                    raise
                now = monotonic()
                invisible_since = now if invisible_since is None else invisible_since
                if now - invisible_since >= 120:
                    raise worldlabs.WorldLabsError("Generation operation remained unavailable for 120 seconds. Its saved operation ID is preserved; do not submit another generation.") from None
                transient = True
            if not transient:
                raise
            print("A read-only operation poll failed temporarily; waiting before polling the same operation.", flush=True)
        else:
            invisible_since = None
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


def _partial_imported_pair(library, world_id):
    """Reuse already verified downloads after local reconstruction interruption."""
    entries = worlds.list_worlds(library)
    selected = {}
    for kind, representation in (("mesh", "hq-visual-glb"), ("splat", "gaussian-spz")):
        matches = [entry for entry in entries if entry["environment"]["provenance"].get("providerWorldId") == world_id
                   and entry["environment"]["provenance"].get("representation") == representation]
        worldlabs._require(len(matches) <= 1, "Partial cache contains conflicting imported representations; recover the original pair")
        if matches:
            selected[kind] = matches[0]
    if len(selected) == 2:
        return {"provider": "worldlabs", "worldId": world_id, "reviewStatus": "unreviewed", **selected}
    return None


def _run_provider_experiment(args, *, client=None, monotonic=time.monotonic, sleep=time.sleep, converter=None):
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
    else:
        manifest = {"schemaVersion": 1, "provider": "worldlabs", "model": args.model,
                    "experimentId": args.experiment_id,
                    "promptSha256": request_digest, "budgetCredits": args.budget_credits,
                    "documentedMaximumCredits": maximum, "pricingCheckedAt": worldlabs.DOCUMENTATION_CHECKED_AT,
                    "qualityGate": "unreviewed", "rendersCompleted": False, "state": "prepared",
                    "referenceImageProvided": bool(args.image_path or args.reference_image_url),
                    "alignmentReview": "SPZ uses provider metric metadata. HQ visual GLB metric scale and ground remain uncalibrated; review before comparing quality."}
    # Display labels are not provider generation inputs. Preserve the first
    # immutable import metadata when another output resumes the same world.
    manifest.setdefault("importName", args.name)
    manifest.setdefault("importOwner", args.owner)
    args.name, args.owner = manifest["importName"], manifest["importOwner"]
    worldlabs._atomic_json(manifest_path, manifest)
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
        existing_mesh_work = (args.mesh_operation_id or manifest.get("meshOperationId")
                              or manifest.get("meshExportSubmissionStarted") or (mesh_dir / "generation.json").exists())
        new_mesh_cost = 0 if cached_mesh or existing_mesh_work else worldlabs.HQ_MESH_EXPORT_CREDITS
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
                    model=args.model, max_credits=estimate["generationMaxCredits"], seed=getattr(args, "seed", 42),
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
        elif manifest.get("meshOperationId"):
            # A partial restore can omit the journal while retaining its known
            # accepted operation ID. Reattach that work using GETs only.
            state = client.attach_operation(mesh_dir, manifest["meshOperationId"], operation_type="mesh-export",
                                            world_id=world_id, max_credits=worldlabs.HQ_MESH_EXPORT_CREDITS)
        elif manifest.get("meshExportSubmissionStarted"):
            raise worldlabs.WorldLabsError("Cached mesh export journal is missing after a submission attempt. Recover its accepted mesh operation ID; no replacement export was submitted.")
        elif ((world.get("assets") or {}).get("mesh") or {}).get("hq_mesh_url"):
            state = None
            manifest["meshExportReusedExistingAsset"] = True
        else:
            # Separate from generation.json: if an artifact loses that one file
            # after an accepted POST, its absence cannot authorize another POST.
            manifest.update(meshExportSubmissionStarted=True, state="submitting-mesh")
            worldlabs._atomic_json(manifest_path, manifest)
            state = client.create_mesh_export(mesh_dir, world_id, max_credits=worldlabs.HQ_MESH_EXPORT_CREDITS)
        if state is not None:
            _record_identity("mesh", state)
            manifest.update(state="exporting-mesh", meshOperationId=state.get("operationId"))
            worldlabs._atomic_json(manifest_path, manifest)
            if state["state"] != "completed":
                state = _wait(client, mesh_dir, deadline=deadline, monotonic=monotonic, sleep=sleep)
            manifest["meshSettledCredits"] = state.get("settledCredits")
        pair = _partial_imported_pair(args.output / "world-library", world_id)
        if pair is None:
            pair = client.import_world_pair(world_id, args.output / "world-library", name=args.name, owner=args.owner,
                                           reuse_basis="Generated in the user's World Labs API account; review the account's applicable asset terms",
                                           resolution="500k", mesh_variant="textured")
        manifest["state"] = "reconstructing-gaussians"
        worldlabs._atomic_json(manifest_path, manifest)
        pair = prepare_reconstructed_mesh(pair, args.output / "world-library", args.output, converter=converter)
        worldlabs._atomic_json(args.output / "world-pair.json", pair)
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


def _prepare_comparison(args, pair):
    """Scene, camera and product edits only rebuild local probes, never a world."""
    from film.scene import load_scene, scene_digest
    destination = args.output / "comparison"
    path = destination / "comparison.json"
    if path.exists():
        existing = read_json(path)
        expected = {pair["mesh"]["id"], pair["gaussianMesh"]["id"]}
        worldlabs._require(set(existing.get("conditions", {}).values()) == expected
                           and existing.get("pairing", {}).get("worldId") == pair["worldId"],
                           "Existing comparison pins different immutable worlds; use a new output directory")
        if existing.get("sourceDigest") == scene_digest(load_scene(args.scene)):
            return
    # Assemble in a sibling directory first. Failed local regeneration does not
    # discard the previous comparison or the cached provider result.
    with tempfile.TemporaryDirectory(prefix=".comparison-", dir=args.output) as temporary:
        staged = Path(temporary) / "comparison"
        probes.create_comparison(args.scene, args.output / "world-library", staged,
                                 mesh_id=pair["mesh"]["id"], splat_id=pair["gaussianMesh"]["id"], world_id=pair["worldId"])
        if destination.exists():
            backup = args.output / ".comparison-previous"
            worldlabs._require(not backup.exists(), "Previous comparison recovery directory exists; preserve it before rebuilding probes")
            destination.rename(backup)
            try:
                staged.rename(destination)
            except BaseException:
                backup.rename(destination)
                raise
            shutil.rmtree(backup)
        else:
            staged.rename(destination)


def run_experiment(args, *, client=None, monotonic=time.monotonic, sleep=time.sleep, converter=None):
    """Reuse verified provider work before credentials, balance checks or POSTs."""
    args = copy.copy(args)
    args.output = Path(args.output)
    worldlabs._identifier(args.experiment_id, "experiment ID")
    worldlabs._require(args.budget_credits > 0, "Credit budget must be positive")
    worldlabs._require(0 < args.timeout_minutes <= 95, "Polling time budget must be between 0 and 95 minutes")
    worldlabs._require(not (args.world_id and args.generation_operation_id),
                       "Supply an existing world ID or a generation operation ID, not both")
    worldlabs._require(not (args.image_path and args.reference_image_url), "Supply a reference image URL or local image path, not both")
    if args.image_path:
        worldlabs._require(args.image_path.is_file() and 0 < args.image_path.stat().st_size <= 6 * 1024 * 1024,
                           "Private inline reference image must be a file of at most 6 MiB")
    seed = getattr(args, "seed", 42)
    worldlabs._require(type(seed) is int and 0 <= seed <= 4294967295, "World Labs seed must be a uint32 integer")
    identity = generation_identity(prompt=args.prompt, preset=args.default_environment, model=args.model,
                                   image_url=args.reference_image_url,
                                   image_sha256=hashlib.sha256(args.image_path.read_bytes()).hexdigest() if args.image_path else None,
                                   seed=seed)
    args.prompt = identity["prompt"]
    args.reference_image_url = args.reference_image_url.strip()
    manifest_path = args.output / "experiment.json"
    previous = read_json(manifest_path) if manifest_path.exists() else None
    if previous:
        worldlabs._require(previous.get("promptSha256") == identity["promptSha256"]
                           and previous.get("model") == args.model and previous.get("seed", 42) == seed,
                           "Existing experiment uses a different model or prompt; resume it with its original settings")
        worldlabs._require(previous.get("experimentId") == args.experiment_id,
                           "Existing output belongs to a different experiment ID")
        expected_variation = os.environ.get("GITHUB_RUN_ID") or args.experiment_id
        worldlabs._require(not (getattr(args, "force_new", False) and previous.get("cacheVariation")
                               and previous["cacheVariation"] != expected_variation),
                           "Existing output belongs to a different cache variation")
        worldlabs._require(not (getattr(args, "force_new", False) and not previous.get("cacheVariation")),
                           "A new variation requires a new output directory and experiment ID")
    cache_root = getattr(args, "cache_dir", None) or args.output.parent / ".worldlabs-cache"
    variation = (os.environ.get("GITHUB_RUN_ID") or args.experiment_id) if getattr(args, "force_new", False) else (previous or {}).get("cacheVariation")
    cache = WorldCache(cache_root, identity, variation=variation)
    args.output.mkdir(parents=True, exist_ok=True)
    with cache.locked():
        if not cache.record.get("providerWorkStarted") and previous:
            cache.seed_from_output(args.output, previous)
        # Recovery IDs select existing work; they must never silently select a
        # different cached operation or world that happens to share its prompt.
        for folder, requested in (("generation", args.generation_operation_id), ("mesh-export", args.mesh_operation_id)):
            journal_path = cache.directory / "provider-state" / folder / "generation.json"
            if journal_path.exists():
                saved_state = worldlabs.load_generation(journal_path.parent)
                worldlabs._require(not requested or not saved_state.get("operationId")
                                   or saved_state["operationId"] == requested,
                                   "Requested recovery operation differs from the cached operation")
                worldlabs._require(not args.world_id or not saved_state.get("worldId")
                                   or saved_state["worldId"] == args.world_id,
                                   "Requested recovery world differs from the cached world")
        pair = cache.completed_pair()
        if pair is None and (cache.directory / "world-pair.json").exists():
            # A crash after final asset publication may precede the index write.
            pair = verify_pair(cache.directory)
            cache.save(status="completed", worldId=pair["worldId"], providerWorkStarted=True)
        hit = pair is not None
        resumed = bool(cache.record.get("providerWorkStarted")) and not hit
        if pair:
            worldlabs._require(not args.world_id or args.world_id == pair["worldId"],
                               "Requested existing world differs from the cached world; use a separate explicit variation")
        manifest = previous or {"schemaVersion": 1, "provider": "worldlabs", "model": args.model,
                "experimentId": args.experiment_id, "promptSha256": identity["promptSha256"],
                "budgetCredits": args.budget_credits, "qualityGate": "unreviewed", "rendersCompleted": False,
                "referenceImageProvided": bool(args.image_path or args.reference_image_url), "state": "prepared"}
        manifest.update(seed=seed, cacheKey=identity["key"], cacheHit=hit,
                        cacheStatus="hit" if hit else "resumed" if resumed else "miss")
        if variation:
            manifest["cacheVariation"] = variation
        worldlabs._atomic_json(manifest_path, manifest)
        try:
            if not hit:
                provider_args = copy.copy(args)
                provider_args.output = cache.directory
                journal = cache.directory / "provider-state" / "generation" / "generation.json"
                cached_manifest_path = cache.directory / "experiment.json"
                cached_manifest = read_json(cached_manifest_path) if cached_manifest_path.exists() else {}
                saved_world = cache.record.get("worldId") or cached_manifest.get("worldId")
                if not args.world_id and not args.generation_operation_id and not journal.exists() and saved_world:
                    provider_args.world_id = saved_world
                elif not args.world_id and not args.generation_operation_id and not journal.exists() and cached_manifest.get("generationOperationId"):
                    provider_args.generation_operation_id = cached_manifest["generationOperationId"]
                worldlabs._require(not (resumed and not journal.exists() and not provider_args.world_id
                                        and not provider_args.generation_operation_id),
                                   "Cached provider journal is missing; recover its existing world or operation ID before continuing")
                recoverable = provider_args.world_id or provider_args.generation_operation_id or journal.exists()
                worldlabs._require(not args.mesh_operation_id or recoverable,
                                   "Recovering a mesh operation also requires its existing world or generation operation ID")
                worldlabs._require(not (int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")) > 1 and not recoverable),
                                   "A GitHub rerun cannot create a fresh paid world. Supply the saved world or generation operation ID in a recovery dispatch.")
                estimate = worldlabs.estimate_pair(args.model)
                maximum = estimate["meshExportMaxCredits"] + (0 if provider_args.world_id else estimate["generationMaxCredits"])
                worldlabs._require(maximum <= args.budget_credits, "Documented experiment maximum exceeds the authorized credit cap")
                if converter is None:
                    preflight_reconstruction()
                # Missing credentials are a local configuration failure, before
                # there can be any accepted work or submission uncertainty.
                active_client = client or worldlabs.WorldLabsClient.from_environment()
                definitely_fresh = (not resumed and not cache.record.get("backfilledExistingOutput")
                                    and not any((provider_args.world_id, provider_args.generation_operation_id,
                                                 provider_args.mesh_operation_id, cache.record.get("worldId")))
                                    and not (cache.directory / "provider-state").exists()
                                    and not any(cached_manifest.get(key) for key in
                                                ("worldId", "generationOperationId", "meshOperationId", "meshExportSubmissionStarted")))
                cache.save(status="incomplete", providerWorkStarted=True)
                try:
                    provider_manifest = _run_provider_experiment(provider_args, client=active_client, monotonic=monotonic,
                                                                 sleep=sleep, converter=converter)
                except Exception:
                    # A fresh read-only balance/preflight rejection has never
                    # entered _submit: that routine creates its journal directory
                    # before its first paid POST. Permit a funded retry only
                    # while every durable and explicit work identity is absent.
                    # Process interruption deliberately bypasses this rollback.
                    if (definitely_fresh and not (cache.directory / "provider-state").exists()
                            and not (cache.directory / "world-pair.json").exists()):
                        try:
                            failed_manifest = read_json(cached_manifest_path)
                        except worldlabs.WorldLabsError:
                            pass
                        else:
                            if not any(failed_manifest.get(key) for key in
                                       ("worldId", "generationOperationId", "meshOperationId", "meshExportSubmissionStarted")):
                                cache.save(status="prepared", providerWorkStarted=False)
                    raise
                pair = verify_pair(cache.directory)
                cache.save(status="completed", worldId=pair["worldId"])
                manifest.update(provider_manifest)
            else:
                cached_path = cache.directory / "experiment.json"
                if cached_path.exists():
                    manifest.update(read_json(cached_path))
                manifest["additionalProviderCredits"] = 0
                _summary("Verified World Labs cache hit: 0 provider requests, 0 additional provider credits. Reusing the official mesh, Gaussian source and reconstructed mesh.")
            # Cache metadata describes this invocation, independent of the
            # experiment ID/name/budget attached to the first provider result.
            manifest.update(experimentId=args.experiment_id, budgetCredits=args.budget_credits, seed=seed,
                            cacheKey=identity["key"], cacheHit=hit,
                            cacheStatus="hit" if hit else "resumed" if resumed else "miss", worldId=pair["worldId"])
            if variation:
                manifest["cacheVariation"] = variation
            copy_payload(cache.directory, args.output)
            _prepare_comparison(args, pair)
            manifest.update(state="prepared-for-review", meshWorldRevision=pair["mesh"]["id"],
                            splatWorldRevision=pair["splat"]["id"], gaussianMeshRevision=pair["gaussianMesh"]["id"],
                            comparisonManifest="comparison/comparison.json", sceneCount=15)
            worldlabs._atomic_json(manifest_path, manifest)
            return manifest
        except BaseException:
            manifest.update(state="incomplete", recovery="Use the preserved cache/provider-state and existing world/operation IDs. Do not create another world to recover this experiment.")
            worldlabs._atomic_json(manifest_path, manifest)
            raise
        finally:
            # Accepted IDs survive even KeyboardInterrupt and local conversion
            # errors; GitHub artifacts and existing CLI recovery paths retain a
            # mirror while the shared cache remains the authoritative journal.
            copy_payload(cache.directory, args.output)


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
