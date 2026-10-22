"""Backfill real-output caches using mocked GitHub transport and no provider key."""
import io
import json
import os
import stat
import unittest
from unittest.mock import patch
import zipfile

from film import worldlabs
from film.github_worlds import GitHubWorlds
from film.world_cache import WorldCache
from film.world_requests import generation_identity
from scripts import seed_worldlabs_cache as seed
from scripts import worldlabs_experiment as experiment
from tests import test_github_worlds as fixtures


class SeedWorldCacheTests(unittest.TestCase):
    setUp = fixtures.GitHubWorldTests.setUp
    archive = fixtures.GitHubWorldTests.archive

    @staticmethod
    def rewrite(payload, changes):
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(payload)) as source, zipfile.ZipFile(output, "w") as destination:
            for member in source.infolist():
                destination.writestr(member, changes.pop(member.filename, source.read(member.filename)))
            for name, content in changes.items():
                destination.writestr(name, content)
        return output.getvalue()

    def completed_artifact(self):
        identity = generation_identity()
        payload, pair = self.archive()
        pair["reconstruction"] = pair["gaussianMesh"]["environment"]["provenance"]["reconstruction"]
        manifest = {"provider": "worldlabs", "worldId": pair["worldId"], "model": identity["model"],
                    "promptSha256": identity["promptSha256"], "state": "prepared-for-review"}
        payload = self.rewrite(payload, {"world-pair.json": json.dumps(pair), "experiment.json": json.dumps(manifest)})
        return payload, pair, manifest

    def import_payload(self, payload, *, run=None, artifact=None, identity=None):
        run = run or {"conclusion": "success", "path": ".github/workflows/worldlabs-pair.yml@main"}
        artifact = artifact or {"id": 123, "name": "worldlabs-pair-42-1", "expired": False, "size_in_bytes": len(payload)}

        def download(repository, artifact_id, destination):
            self.assertEqual(repository, "example/3d-product-suite")
            self.assertEqual(artifact_id, 123)
            destination.write_bytes(payload)

        with patch.object(GitHubWorlds, "api", side_effect=[run, {"artifacts": [artifact]}]) as api, \
                patch.object(worldlabs.WorldLabsClient, "from_environment", side_effect=AssertionError("No provider access")), \
                patch.dict(os.environ, {"WORLDLABS_API_KEY": ""}):
            result = seed.seed_from_run("42", self.root / "cache", repository="example/3d-product-suite",
                                        identity=identity or generation_identity(), downloader=download)
        self.assertEqual([call.args[0] for call in api.call_args_list], ["actions/runs/42", "actions/runs/42/artifacts"])
        self.assertTrue(all(not call.kwargs for call in api.call_args_list))
        return result

    def test_legacy_successful_artifact_seeds_complete_cache_and_credential_free_hit(self):
        payload, pair, _ = self.completed_artifact()
        result = self.import_payload(payload)
        self.assertEqual(result["additionalProviderCredits"], 0)
        cache = WorldCache(self.root / "cache", generation_identity())
        with cache.locked():
            self.assertEqual(cache.completed_pair(), pair)
            self.assertTrue(cache.record["backfilledExistingOutput"])
        args = experiment.parser().parse_args(["--output", str(self.root / "new-output"), "--cache-dir", str(self.root / "cache"),
                                                "--budget-credits", "1", "--experiment-id", "artifact-backfill"])
        with patch.dict(os.environ, {"WORLDLABS_API_KEY": ""}), \
                patch.object(worldlabs.WorldLabsClient, "from_environment", side_effect=AssertionError("No provider access")), \
                patch.object(experiment, "preflight_reconstruction", side_effect=AssertionError("No reconstruction needed")):
            manifest = experiment.run_experiment(args)
        self.assertTrue(manifest["cacheHit"])
        self.assertEqual(manifest["additionalProviderCredits"], 0)

    def test_seeding_identical_completed_cache_is_idempotent(self):
        payload, _, _ = self.completed_artifact()
        self.assertEqual(self.import_payload(payload), self.import_payload(payload))

    def test_different_request_and_incomplete_or_mismatched_manifest_fail_closed(self):
        payload, _, manifest = self.completed_artifact()
        with self.assertRaisesRegex(ValueError, "different provider request"):
            self.import_payload(payload, identity=generation_identity(prompt="A different room"))
        for invalid in (dict(manifest, state="incomplete"), dict(manifest, worldId="another-world")):
            changed = self.rewrite(payload, {"experiment.json": json.dumps(invalid)})
            with self.subTest(manifest=invalid), self.assertRaises(ValueError):
                self.import_payload(changed)
        self.assertFalse((self.root / "cache").exists())

    def test_failed_wrong_workflow_expired_and_oversized_artifacts_fail_closed(self):
        payload, _, _ = self.completed_artifact()
        for run in ({"conclusion": "failure", "path": ".github/workflows/worldlabs-pair.yml"},
                    {"conclusion": "success", "path": ".github/workflows/another.yml"}):
            with self.subTest(run=run), self.assertRaisesRegex(ValueError, "successful World Labs"):
                self.import_payload(payload, run=run)
        base = {"id": 123, "name": "worldlabs-pair-42-1", "expired": False, "size_in_bytes": len(payload)}
        for artifact in (dict(base, expired=True), dict(base, size_in_bytes=seed.MAX_ARCHIVE_BYTES + 1)):
            with self.subTest(artifact=artifact), self.assertRaises(ValueError):
                self.import_payload(payload, artifact=artifact)
        self.assertFalse((self.root / "cache").exists())

    def test_corrupt_asset_and_unsafe_archive_members_fail_closed(self):
        payload, pair, _ = self.completed_artifact()
        asset = "world-library/" + pair["mesh"]["environment"]["asset"]["path"]
        corrupt = self.rewrite(payload, {asset: b"corrupt asset"})
        with self.assertRaisesRegex(ValueError, "hash"):
            self.import_payload(corrupt)
        for name in ("../escape", "/absolute", "folder\\escape", "C:/escape"):
            changed = self.rewrite(payload, {name: "unsafe"})
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Unsafe"):
                self.import_payload(changed)
        link = zipfile.ZipInfo("linked")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            self.import_payload(self.rewrite(payload, {link: "target"}))

    def test_existing_partial_journal_is_preserved(self):
        payload, _, _ = self.completed_artifact()
        cache = WorldCache(self.root / "cache", generation_identity())
        with cache.locked():
            cache.save(status="incomplete", providerWorkStarted=True, worldId="accepted-existing-world")
        original = (cache.directory / "cache.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "already contains provider work"):
            self.import_payload(payload)
        self.assertEqual((cache.directory / "cache.json").read_bytes(), original)

    def test_invalid_run_and_force_new_never_access_github(self):
        with patch.object(GitHubWorlds, "api") as api:
            for invalid in ("../42", "1\n2", "", "1" * 21):
                with self.subTest(run_id=invalid), self.assertRaises(ValueError):
                    seed.seed_from_run(invalid, self.root / "cache")
            with patch.dict(os.environ, {"WORLDLABS_FORCE_NEW": "true"}), self.assertRaisesRegex(ValueError, "new variation"):
                seed.seed_from_run("42", self.root / "cache")
        api.assert_not_called()

    def test_environment_identity_matches_generation_defaults(self):
        with patch.dict(os.environ, {"WORLDLABS_FORCE_NEW": "false", "WORLDLABS_PROMPT": "", "WORLDLABS_MODEL": "",
                                    "WORLDLABS_DEFAULT_ENVIRONMENT": "", "WORLDLABS_REFERENCE_IMAGE_URL": ""}):
            self.assertEqual(seed.identity_from_environment(), generation_identity())

    def test_actual_download_is_bounded_and_uses_only_github_get(self):
        process = unittest.mock.MagicMock()
        process.__enter__.return_value = process
        process.poll.return_value = None
        with patch.object(seed.subprocess, "Popen", return_value=process) as command, \
                patch.object(seed.select, "select", return_value=([process.stdout], [], [])), \
                patch.object(seed.os, "read", return_value=b"too large"), patch.object(seed, "MAX_ARCHIVE_BYTES", 3):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                seed._download_archive("example/3d-product-suite", 123, self.root / "download.zip")
        self.assertEqual(command.call_args.args[0], ["gh", "api", "repos/example/3d-product-suite/actions/artifacts/123/zip"])
        process.kill.assert_called_once()
        self.assertEqual((self.root / "download.zip").stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
