"""GitHub dispatch and artifact import with every external call mocked."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
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
            "reference_image_url": reference, "model": "marble-1.1", "budget_credits": "5080"}})
        self.assertEqual(self.records(), [result])
        persisted = json.dumps(result)
        self.assertNotIn(secret, persisted)
        self.assertNotIn(reference, persisted)
        self.assertNotIn("private-reference-token", persisted)

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
            self.assertEqual(self.client.dispatch({}), first)
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
            self.assertEqual(first.result(timeout=3), second.result(timeout=3))
        self.assertEqual(api.call_count, 1)
        self.assertEqual(len(self.records()), 1)

    def test_explicit_new_request_after_dedup_window_can_submit(self):
        with patch.object(self.client, "api", return_value={}) as api:
            first = self.client.dispatch({})
            path = self.client.requests / f"{first['id']}.json"
            first["createdAt"] = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
            path.write_text(json.dumps(first))
            second = self.client.dispatch({})
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(api.call_count, 2)

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
