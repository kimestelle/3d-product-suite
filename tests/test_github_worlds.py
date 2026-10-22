"""GitHub dispatch and artifact import with every external call mocked."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

from film import github_worlds, worlds
from film.world_requests import DEFAULT_ENVIRONMENTS, generation_identity
from tests.test_worlds import glb_bytes, ply_bytes


class GitHubWorldTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "data"
        self.client = github_worlds.GitHubWorlds(self.data, repository="example/3d-product-suite")

    def records(self):
        return [json.loads(path.read_text()) for path in self.client.requests.glob("*.json")]

    def test_invalid_budget_preset_prompt_and_reference_url_never_submit(self):
        invalid = [
            {"budgetCredits": budget} for budget in (0, 5079, 6001, True, 5080.0, "6000")
        ] + [{"preset": "unknown"}, {"prompt": "x" * 4001}, {"prompt": None}, {"imageUrl": None}, {"imageUrl": []}]
        invalid += [{"forceNew": value} for value in (None, 0, 1, "false", "true", [], {})]
        invalid += [{"imageUrl": url} for url in ("http://example.com/image.jpg", "https://localhost/image.jpg",
                    "https://127.0.0.1/image.jpg", "https://169.254.169.254/image.jpg", "https://user:password@example.com/image.jpg",
                    "https://example.com:444/image.jpg", "https://example.com/image.jpg#fragment")]
        with patch.object(self.client, "api") as api:
            for data in invalid:
                with self.subTest(data=data), self.assertRaises(ValueError):
                    self.client.dispatch(data)
        api.assert_not_called()
        self.assertEqual(self.records(), [])

    def test_dispatch_sends_exact_workflow_inputs_and_persists_no_key_or_image_url(self):
        reference = "https://images.example.com/reference.jpg?signed=private-reference-token"
        secret = "worldlabs-key-never-read-by-local-dispatch"
        with patch.dict("os.environ", {"WORLDLABS_API_KEY": secret}), patch.object(self.client, "api", return_value={}) as api:
            result = self.client.dispatch({"preset": "warm-gallery", "prompt": "Empty stone studio", "imageUrl": reference, "budgetCredits": 5080})
        self.assertEqual(result["state"], "dispatched")
        self.assertEqual(result["budgetCredits"], 5080)
        self.assertTrue(result["imageProvided"])
        api.assert_called_once_with("actions/workflows/worldlabs-pair.yml/dispatches", method="POST", body={"ref": "main", "inputs": {
            "experiment_id": result["id"], "prompt": "Empty stone studio", "default_environment": "warm-gallery",
            "reference_image_url": reference, "model": "marble-1.1", "budget_credits": "5080",
            "cache_key": result["cacheKey"], "force_new": "false"}})
        self.assertEqual(self.records()[0]["id"], result["id"])
        persisted = json.dumps(result)
        self.assertNotIn(secret, persisted)
        self.assertNotIn(reference, persisted)
        self.assertNotIn("private-reference-token", persisted)
        self.assertNotIn("Empty stone studio", persisted)

    def test_uncertain_post_is_durable_and_never_automatically_resubmitted(self):
        with patch.object(self.client, "api", side_effect=subprocess.TimeoutExpired("gh", 40)) as api:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.client.dispatch({})
            saved = self.records()
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0]["state"], "unknown")
            for data in ({}, {"preset": "modern-loft", "prompt": "Different request"}):
                with self.assertRaisesRegex(RuntimeError, "uncertain"):
                    self.client.dispatch(data)
        self.assertEqual(api.call_count, 1)
        self.assertEqual(self.records(), saved)

    def test_dispatch_record_is_written_before_post_and_double_click_reuses_result(self):
        def post(*args, **kwargs):
            self.assertEqual(self.records()[0]["state"], "submitting")
            return {}
        with patch.object(self.client, "api", side_effect=post) as api:
            first = self.client.dispatch({})
            reused = self.client.dispatch({})
            self.assertEqual(reused["id"], first["id"])
            self.assertEqual(reused["cacheStatus"], "reused-request")
        self.assertEqual(api.call_count, 1)
        self.assertEqual(len(self.records()), 1)

    def test_concurrent_identical_dispatches_submit_only_once(self):
        entered, release = threading.Event(), threading.Event()
        def post(*args, **kwargs):
            entered.set()
            if not release.wait(timeout=3):
                raise RuntimeError("Test dispatch release timed out")
            return {}
        with patch.object(self.client, "api", side_effect=post) as api, ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(self.client.dispatch, {})
            self.assertTrue(entered.wait(timeout=3))
            second = executor.submit(self.client.dispatch, {})
            release.set()
            self.assertEqual(first.result(timeout=3)["id"], second.result(timeout=3)["id"])
        self.assertEqual(api.call_count, 1)
        self.assertEqual(len(self.records()), 1)

    def test_explicit_new_request_after_dedup_window_can_submit(self):
        with patch.object(self.client, "api", return_value={}) as api:
            first = self.client.dispatch({"forceNew": True})
            self.assertEqual(self.client.dispatch({"forceNew": True})["id"], first["id"])
            path = self.client.requests / f"{first['id']}.json"
            first["createdAt"] = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
            path.write_text(json.dumps(first))
            second = self.client.dispatch({"forceNew": True})
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(api.call_count, 2)
        self.assertEqual(api.call_args.kwargs["body"]["inputs"]["force_new"], "true")

    def test_request_reuse_survives_restart_and_ignores_elapsed_time_and_spending_cap(self):
        with patch.object(self.client, "api", return_value={}):
            first = self.client.dispatch({"budgetCredits": 5080})
        path = self.client.requests / f"{first['id']}.json"
        record = json.loads(path.read_text())
        record["createdAt"] = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
        path.write_text(json.dumps(record))
        restarted = github_worlds.GitHubWorlds(self.data, repository=self.client.repository)
        with patch.object(restarted, "api") as api:
            reused = restarted.dispatch({"budgetCredits": 6000})
        api.assert_not_called()
        self.assertEqual(reused["id"], first["id"])
        self.assertEqual(reused["cacheStatus"], "reused-request")
        self.assertTrue(reused["needsImport"])
        self.assertEqual(len(self.records()), 1)

    def test_effective_prompt_matches_regardless_of_preset_or_whitespace(self):
        with patch.object(self.client, "api", return_value={}) as api:
            first = self.client.dispatch({})
            reused = self.client.dispatch({"preset": "modern-loft",
                "prompt": "  " + DEFAULT_ENVIRONMENTS["botanical-studio"] + "  "})
        self.assertEqual(first["id"], reused["id"])
        self.assertEqual(api.call_count, 1)

    def test_different_provider_inputs_create_separate_requests(self):
        with patch.object(self.client, "api", return_value={}) as api:
            results = [self.client.dispatch(data) for data in ({}, {"preset": "warm-gallery"},
                {"prompt": "A private white room"}, {"imageUrl": "https://example.com/a.jpg"},
                {"imageUrl": "https://example.com/b.jpg"})]
        self.assertEqual(len({result["cacheKey"] for result in results}), 5)
        self.assertEqual(api.call_count, 5)

    def test_matching_legacy_record_is_adopted_even_when_budget_changes(self):
        request_id = "a" * 32
        record = {"id": request_id, "state": "dispatched", "repository": self.client.repository,
            "createdAt": "2024-01-01T00:00:00+00:00", "budgetCredits": 5080,
            "requestDigest": hashlib.sha256(json.dumps({"image": "", "preset": "warm-gallery",
                "budget": 5080, "prompt": "An empty room"}, sort_keys=True).encode()).hexdigest()}
        path = self.client.requests / f"{request_id}.json"
        path.write_text(json.dumps(record))
        with patch.object(self.client, "api") as api:
            reused = self.client.dispatch({"preset": "warm-gallery", "prompt": "An empty room", "budgetCredits": 6000})
        api.assert_not_called()
        self.assertEqual(reused["id"], request_id)
        self.assertEqual(json.loads(path.read_text())["cacheKey"], reused["cacheKey"])

    def test_known_failed_request_reuses_and_uncertain_request_blocks_fresh_variation(self):
        with patch.object(self.client, "api", return_value={}):
            known = self.client.dispatch({})
        path = self.client.requests / f"{known['id']}.json"
        record = json.loads(path.read_text())
        record["state"] = "failed"
        path.write_text(json.dumps(record))
        with patch.object(self.client, "api") as api:
            self.assertEqual(self.client.dispatch({})["id"], known["id"])
        api.assert_not_called()
        with patch.object(self.client, "api", side_effect=subprocess.TimeoutExpired("gh", 40)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.client.dispatch({"prompt": "Different room"})
        with patch.object(self.client, "api") as api:
            self.assertEqual(self.client.dispatch({})["id"], known["id"])
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                self.client.dispatch({"forceNew": True})
        api.assert_not_called()

    def test_concurrent_force_new_double_clicks_submit_once(self):
        with patch.object(self.client, "api", return_value={}) as api, ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(self.client.dispatch, [{"forceNew": True}] * 4))
        self.assertEqual(len({result["id"] for result in results}), 1)
        self.assertEqual(api.call_count, 1)

    def test_gh_transport_uses_stdin_json_and_never_secret_commands(self):
        secret = "local-worldlabs-secret"
        body = {"ref": "main", "inputs": {"budget_credits": "6000"}}
        with patch.dict("os.environ", {"WORLDLABS_API_KEY": secret}), patch.object(github_worlds.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 0, "", "")) as command:
            self.assertEqual(self.client.api("actions/workflows/worldlabs-pair.yml/dispatches", method="POST", body=body), {})
        args, kwargs = command.call_args
        self.assertEqual(args[0], ["gh", "api", "repos/example/3d-product-suite/actions/workflows/worldlabs-pair.yml/dispatches", "--method", "POST", "--input", "-"])
        self.assertEqual(json.loads(kwargs["input"]), body)
        self.assertNotIn(secret, repr(command.call_args))
        self.assertFalse(any("secret" in part for part in args[0]))

    def archive(self, *, extra=None):
        source = self.root / "artifact"
        library = source / "world-library"
        library.mkdir(parents=True)
        glb, ply = self.root / "room.glb", self.root / "room.ply"
        glb.write_bytes(glb_bytes())
        ply.write_bytes(ply_bytes())
        provenance = {"source": "Original synthetic GitHub artifact transport test", "owner": "3d-product-suite tests",
                      "reuseBasis": "Original test geometry", "allowedExternalDestinations": [],
                      "provider": "worldlabs", "providerWorldId": "test-world-1"}
        mesh = worlds.import_world(glb, library, name="Official mesh transport fixture", provenance=dict(provenance, representation="hq-visual-glb"), fixture=True)
        splat = worlds.import_world(ply, library, name="Gaussian transport fixture", provenance=dict(provenance, representation="gaussian-spz"), fixture=True)
        source_digest = splat["environment"]["asset"]["sha256"]
        lineage = dict(provenance, representation="gaussian-reconstructed-mesh", sourceSplatSha256=source_digest,
                       reconstruction={"sourceSha256": source_digest, "algorithm": "Synthetic transport fixture"})
        reconstructed = worlds.import_world(glb, library, name="Reconstructed transport fixture", provenance=lineage, fixture=True)
        pair = {"provider": "worldlabs", "worldId": "test-world-1", "mesh": mesh, "splat": splat, "gaussianMesh": reconstructed}
        (source / "world-pair.json").write_text(json.dumps(pair))
        (source / "comparison").mkdir()
        (source / "comparison" / "comparison.json").write_text(json.dumps({"pairing": {"worldId": "test-world-1"},
                "conditions": {"mesh": mesh["id"], "gaussianMesh": reconstructed["id"]}, "quality": "unreviewed"}))
        destination = io.BytesIO()
        with zipfile.ZipFile(destination, "w") as archive:
            for path in source.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(source).as_posix())
            if extra:
                for name, payload in extra:
                    archive.writestr(name, payload)
        return destination.getvalue(), pair

    def import_artifact(self, payload, *, run=None, artifacts=None):
        run = {"conclusion": "success", "path": ".github/workflows/worldlabs-pair.yml@main"} if run is None else run
        artifacts = [{"id": 123, "name": "worldlabs-pair-42-1", "expired": False, "size_in_bytes": len(payload)}] if artifacts is None else artifacts
        def download(command, **kwargs):
            self.assertEqual(command, ["gh", "api", "repos/example/3d-product-suite/actions/artifacts/123/zip"])
            kwargs["stdout"].write(payload)
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with patch.object(self.client, "api", side_effect=[run, {"artifacts": artifacts}]), patch.object(github_worlds.subprocess, "run", side_effect=download):
            return self.client.import_run(42)

    def test_successful_artifact_import_preserves_three_worlds_hashes_and_reconstruction_lineage(self):
        archive, pair = self.archive()
        result = self.import_artifact(archive)
        self.assertEqual(result["worldId"], "test-world-1")
        self.assertEqual(result["runId"], "42")
        self.assertEqual(len(result["worlds"]), 3)
        by_name = {entry["name"]: entry for entry in result["worlds"]}
        for kind in ("mesh", "splat", "gaussianMesh"):
            self.assertEqual(by_name[pair[kind]["name"]], pair[kind])
        self.assertEqual(pair["gaussianMesh"]["environment"]["provenance"]["sourceSplatSha256"], pair["splat"]["environment"]["asset"]["sha256"])
        self.assertTrue((self.data / "comparisons" / "42" / "comparison.json").is_file())
        self.assertEqual(len(worlds.list_worlds(self.data)), 3)
        self.assertEqual(list(self.data.glob("worldlabs-import-*")), [])

    def cacheable_artifact(self):
        identity = generation_identity()
        manifest = {"provider": "worldlabs", "worldId": "test-world-1", "model": identity["model"],
                    "promptSha256": identity["promptSha256"], "cacheKey": identity["key"], "seed": identity["seed"]}
        payload, pair = self.archive(extra=[("experiment.json", json.dumps(manifest))])
        return payload, pair, manifest

    def test_imported_result_reuses_verified_local_assets_after_restart_with_zero_github_calls(self):
        payload, pair, manifest = self.cacheable_artifact()
        imported = self.import_artifact(payload)
        self.assertEqual(imported["cacheKey"], manifest["cacheKey"])
        restarted = github_worlds.GitHubWorlds(self.data, repository=self.client.repository)
        with patch.object(restarted, "api") as api:
            cached = restarted.dispatch({"budgetCredits": 5080})
        api.assert_not_called()
        self.assertEqual(cached["cacheStatus"], "local-hit")
        self.assertFalse(cached["needsImport"])
        self.assertEqual(cached["runId"], "42")
        self.assertEqual(cached["worldId"], pair["worldId"])
        self.assertEqual(cached["worlds"], imported["worlds"])
        self.assertEqual(self.records(), [])

    def test_explicit_new_variation_skips_a_valid_local_result(self):
        payload, _, _ = self.cacheable_artifact()
        self.import_artifact(payload)
        with patch.object(self.client, "api", return_value={}) as api:
            fresh = self.client.dispatch({"forceNew": True})
        self.assertEqual(fresh["cacheStatus"], "dispatched")
        self.assertEqual(api.call_count, 1)

    def test_legacy_artifact_can_bind_to_matching_run_request_without_experiment_manifest(self):
        with patch.object(self.client, "api", return_value={}):
            request = self.client.dispatch({})
        payload, _ = self.archive()
        self.import_artifact(payload, run={"conclusion": "success", "path": ".github/workflows/worldlabs-pair.yml@main",
            "display_title": request["id"] + " · World Labs official and Gaussian reconstructed meshes",
            "html_url": "https://github.com/example/3d-product-suite/actions/runs/42"})
        self.assertEqual(self.records()[0]["state"], "imported")
        with patch.object(self.client, "api") as api:
            result = self.client.dispatch({})
        api.assert_not_called()
        self.assertEqual(result["cacheStatus"], "local-hit")

    def test_mismatched_experiment_world_or_fingerprint_rejects_before_library_mutation(self):
        payload, _, manifest = self.cacheable_artifact()
        with patch.object(self.client, "api", return_value={}):
            request = self.client.dispatch({"prompt": "A different room"})
        run = {"conclusion": "success", "path": ".github/workflows/worldlabs-pair.yml@main",
               "display_title": request["id"] + " · World Labs"}
        invalid_manifests = [dict(manifest, worldId="different-world"), dict(manifest, cacheKey="0" * 64)]
        for invalid in invalid_manifests:
            altered = self.rewrite_archive(payload, {"experiment.json": json.dumps(invalid).encode()})
            with self.subTest(manifest=invalid), patch.object(github_worlds, "import_world") as importer:
                with self.assertRaisesRegex(ValueError, "generation identity"):
                    self.import_artifact(altered)
            importer.assert_not_called()
        with patch.object(github_worlds, "import_world") as importer:
            with self.assertRaisesRegex(ValueError, "saved generation request"):
                self.import_artifact(payload, run=run)
        importer.assert_not_called()
        self.assertEqual(worlds.list_worlds(self.data), [])

    def test_corrupt_local_assets_block_paid_replacement_with_recovery_instructions(self):
        payload, pair, manifest = self.cacheable_artifact()
        self.import_artifact(payload)
        asset = self.data / pair["mesh"]["environment"]["asset"]["path"]
        asset.write_bytes(b"corrupt")
        with patch.object(self.client, "api") as api:
            with self.assertRaisesRegex(RuntimeError, "re-import the existing successful GitHub run"):
                self.client.dispatch({})
        api.assert_not_called()
        self.assertTrue((self.client.results / f"{manifest['cacheKey']}.json").exists())
        self.assertEqual(self.records(), [])

    def test_supported_legacy_models_import_using_manifest_fingerprints(self):
        payload, _, manifest = self.cacheable_artifact()
        model = "marble-1.0"
        identity = generation_identity(model=model)
        legacy_manifest = dict(manifest, model=model, cacheKey=identity["key"])
        payload = self.rewrite_archive(payload, {"experiment.json": json.dumps(legacy_manifest).encode()})
        imported = self.import_artifact(payload, run={"conclusion": "success",
            "path": ".github/workflows/worldlabs-pair.yml@main", "display_title": "5d613c8b-recover-existing-mesh"})
        self.assertEqual(imported["cacheKey"], identity["key"])
        self.assertTrue((self.client.results / f"{identity['key']}.json").exists())

    def test_corrupt_local_index_blocks_paid_replacement(self):
        payload, _, manifest = self.cacheable_artifact()
        self.import_artifact(payload)
        index = self.client.results / f"{manifest['cacheKey']}.json"
        for value in ("{", "[]", json.dumps({"cacheKey": manifest["cacheKey"], "schemaVersion": 1})):
            index.write_text(value)
            with self.subTest(value=value), patch.object(self.client, "api") as api:
                with self.assertRaisesRegex(RuntimeError, "incomplete or corrupt"):
                    self.client.dispatch({})
            api.assert_not_called()

    def test_local_hit_can_recover_an_uncertain_submission_without_new_api_calls(self):
        with patch.object(self.client, "api", side_effect=subprocess.TimeoutExpired("gh", 40)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.client.dispatch({})
        payload, _, _ = self.cacheable_artifact()
        self.import_artifact(payload)
        with patch.object(self.client, "api") as api:
            self.assertEqual(self.client.dispatch({})["cacheStatus"], "local-hit")
        api.assert_not_called()

    def test_failed_wrong_workflow_and_oversized_artifacts_do_not_import(self):
        for run in ({"conclusion": "failure", "path": ".github/workflows/worldlabs-pair.yml"},
                    {"conclusion": "success", "path": ".github/workflows/other.yml"}):
            with self.subTest(run=run), patch.object(self.client, "api", return_value=run), patch.object(github_worlds.subprocess, "run") as download:
                with self.assertRaisesRegex(ValueError, "successful"):
                    self.client.import_run(42)
                download.assert_not_called()
        with self.assertRaisesRegex(ValueError, "local import limit"):
            self.import_artifact(b"", artifacts=[{"id": 123, "name": "worldlabs-pair-42-1", "expired": False, "size_in_bytes": 385 * 1024 * 1024}])
        self.assertEqual(worlds.list_worlds(self.data), [])

    def test_zip_traversal_absolute_backslash_and_symlink_members_are_rejected(self):
        symlink = zipfile.ZipInfo("world-library/assets/link.glb")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for member in ("../escaped.txt", "/tmp/escaped.txt", "world-library\\escaped.txt", symlink):
            with self.subTest(member=member):
                destination = io.BytesIO()
                with zipfile.ZipFile(destination, "w") as archive:
                    archive.writestr(member, "unsafe")
                with self.assertRaisesRegex(ValueError, "Unsafe artifact member"):
                    self.import_artifact(destination.getvalue())
        self.assertEqual(worlds.list_worlds(self.data), [])
        self.assertFalse((self.root / "escaped.txt").exists())

    def test_invalid_run_identifiers_never_call_github(self):
        with patch.object(self.client, "api") as api:
            for run_id in ("../secret", "42/other", -1, "1" * 21):
                with self.subTest(run_id=run_id), self.assertRaises(ValueError):
                    self.client.import_run(run_id)
        api.assert_not_called()

    def rewrite_archive(self, payload, changes):
        result = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(payload)) as source, zipfile.ZipFile(result, "w") as output:
            for info in source.infolist():
                value = changes.get(info.filename, source.read(info))
                if value is not None:
                    output.writestr(info, value)
        return result.getvalue()

    def test_missing_malformed_partial_and_wrong_world_pairs_import_nothing(self):
        payload, pair = self.archive()
        wrong = json.loads(json.dumps(pair))
        wrong["worldId"] = "different-provider-world"
        partial = json.loads(json.dumps(pair))
        del partial["gaussianMesh"]
        for value in (None, b"{", json.dumps(partial).encode(), json.dumps(wrong).encode()):
            with self.subTest(value=value):
                archive = self.rewrite_archive(payload, {"world-pair.json": value})
                with self.assertRaises(ValueError), patch.object(github_worlds, "import_world") as import_world:
                    self.import_artifact(archive)
                import_world.assert_not_called()
                self.assertEqual(worlds.list_worlds(self.data), [])
                self.assertFalse((self.data / "comparisons" / "42").exists())

    def test_wrong_reconstruction_digest_rejects_before_importing_any_representation(self):
        payload, pair = self.archive()
        reconstructed = pair["gaussianMesh"]
        reconstructed["environment"]["provenance"]["sourceSplatSha256"] = "0" * 64
        archive = self.rewrite_archive(payload, {
            "world-pair.json": json.dumps(pair).encode(),
            f"world-library/worlds/{reconstructed['id']}.json": json.dumps(reconstructed).encode(),
        })
        with patch.object(github_worlds, "import_world") as import_world:
            with self.assertRaisesRegex(ValueError, "lineage"):
                self.import_artifact(archive)
        import_world.assert_not_called()
        self.assertEqual(worlds.list_worlds(self.data), [])

    def test_wrong_comparison_pairing_rejects_before_importing_any_representation(self):
        payload, pair = self.archive()
        comparison = {"pairing": {"worldId": "other-world"}, "conditions": {"mesh": pair["mesh"]["id"], "gaussianMesh": pair["gaussianMesh"]["id"]}}
        archive = self.rewrite_archive(payload, {"comparison/comparison.json": json.dumps(comparison).encode()})
        with patch.object(github_worlds, "import_world") as import_world:
            with self.assertRaisesRegex(ValueError, "Comparison manifest"):
                self.import_artifact(archive)
        import_world.assert_not_called()


if __name__ == "__main__":
    unittest.main()
