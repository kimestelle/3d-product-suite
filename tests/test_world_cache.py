"""Persistent provider reuse is tested without credentials or paid network calls."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import threading
import unittest
from unittest.mock import patch

from film import worldlabs
from film.world_cache import WorldCache, verify_pair
from film.world_requests import generation_identity, identity_from_fingerprint
from scripts import worldlabs_experiment as experiment
from tests import test_worldlabs_experiment as fixtures


class IdentityTests(unittest.TestCase):
    def test_only_effective_provider_inputs_identify_a_world(self):
        identity = generation_identity(prompt="  studio  ", image_url=" https://example.org/ref.png ")
        expected = hashlib.sha256(json.dumps({"prompt": "studio", "image": "https://example.org/ref.png"}, sort_keys=True).encode()).hexdigest()
        self.assertEqual(identity["promptSha256"], expected)
        self.assertEqual(identity["key"], identity_from_fingerprint(expected, "marble-1.1"))
        self.assertEqual(generation_identity(), generation_identity(prompt=experiment.DEFAULT_PROMPT))
        for change in ({"prompt": "other"}, {"model": "marble-1.0"}, {"image_sha256": "a" * 64}, {"seed": 43}):
            self.assertNotEqual(generation_identity()["key"], generation_identity(**change)["key"])


class WorldCacheTests(unittest.TestCase):
    setUp = fixtures.ExperimentTests.setUp
    client = fixtures.ExperimentTests.client
    run_quietly = fixtures.ExperimentTests.run_quietly
    convert_fake = fixtures.ExperimentTests.convert_fake

    def complete(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False}, self.generation_done,
                             self.without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        return self.run_quietly(client)

    def key(self):
        return generation_identity(prompt=self.args.prompt, model=self.args.model, image_url=self.args.reference_image_url,
                                   seed=self.args.seed)["key"]

    def cache(self):
        return self.root / ".worldlabs-cache" / self.key()

    def test_new_output_reuses_assets_without_client_credentials_gets_or_conversion(self):
        first = self.complete()
        self.assertFalse(first["cacheHit"])
        self.args.output = self.root / "second-product"
        self.args.experiment_id = "second-product"
        self.args.budget_credits = 1
        with patch.object(worldlabs.WorldLabsClient, "from_environment", side_effect=AssertionError("No credentials needed")), \
                patch.object(experiment, "preflight_reconstruction", side_effect=AssertionError("No conversion needed")), \
                contextlib.redirect_stdout(io.StringIO()):
            manifest = experiment.run_experiment(self.args)
        self.assertTrue(manifest["cacheHit"])
        self.assertEqual(manifest["cacheStatus"], "hit")
        self.assertEqual(manifest["additionalProviderCredits"], 0)
        self.assertEqual(manifest["experimentId"], "second-product")
        self.assertEqual(manifest["cacheKey"], first["cacheKey"])
        self.assertTrue((self.args.output / "provider-state/generation/generation.json").is_file())
        self.assertEqual(len(json.loads((self.args.output / "comparison/comparison.json").read_text())["results"]), 15)

    def test_same_output_reuses_without_any_network(self):
        self.complete()
        client = self.client()
        result = self.run_quietly(client)
        self.assertTrue(result["cacheHit"])
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.downloads.requests, [])

    def test_changed_scene_rebuilds_local_probes_only(self):
        self.complete()
        path = self.output / "comparison/comparison.json"
        old = json.loads(path.read_text())
        scene = json.loads(self.args.scene.read_text())
        scene["sceneId"] += "-edited"
        scene["shots"][0]["camera"]["from"]["positionM"][0] += 0.2
        self.args.scene = self.root / "edited.scene.json"
        self.args.scene.write_text(json.dumps(scene))
        client = self.client()
        result = self.run_quietly(client)
        new = json.loads(path.read_text())
        self.assertTrue(result["cacheHit"])
        self.assertNotEqual(old["sourceDigest"], new["sourceDigest"])
        self.assertEqual(old["conditions"], new["conditions"])
        self.assertEqual(self.api.requests, [])

    def test_corrupt_asset_fails_closed_without_new_paid_generation(self):
        self.complete()
        pair = verify_pair(self.cache())
        asset = self.cache() / "world-library" / pair["mesh"]["environment"]["asset"]["path"]
        asset.write_bytes(b"corrupt")
        self.args.output = self.root / "new-output"
        client = self.client()
        with self.assertRaisesRegex(ValueError, "hash"):
            self.run_quietly(client)
        self.assertEqual(self.api.requests, [])

    def test_missing_pair_fails_closed(self):
        self.complete()
        (self.cache() / "world-pair.json").unlink()
        client = self.client()
        with self.assertRaisesRegex(ValueError, "cached"):
            self.run_quietly(client)
        self.assertEqual(self.api.requests, [])

    def test_partial_timeout_resumes_saved_generation_from_a_new_output(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False})
        ticks = iter((0, 100000))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "time budget"):
            experiment.run_experiment(self.args, client=client, monotonic=lambda: next(ticks), converter=self.convert_fake)
        self.args.output = self.root / "recovered-output"
        self.args.experiment_id = "recovered-output"
        client = self.client({"remaining_credits": 10000}, self.generation_done, self.without_mesh,
                             {"remaining_credits": 10000}, {"operation_id": "mesh-1", "done": False},
                             self.mesh_done, self.world)
        result = self.run_quietly(client)
        self.assertEqual(result["cacheStatus"], "resumed")
        posts = [request for request in self.api.requests if request.method == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0].full_url.endswith(":export"))

    def test_uncertain_submission_never_retries(self):
        import urllib.error
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             urllib.error.URLError("network interruption"))
        with self.assertRaisesRegex(ValueError, "uncertain"):
            self.run_quietly(client)
        self.args.output = self.root / "uncertain-recovery"
        client = self.client({"remaining_credits": 10000})
        with self.assertRaisesRegex(ValueError, "No operation ID"):
            self.run_quietly(client)
        self.assertFalse(any(request.method == "POST" for request in self.api.requests))
        self.assertEqual(worldlabs.load_generation(self.cache() / "provider-state/generation")["state"], "submission_uncertain")

    def test_missing_uncertain_mesh_journal_never_submits_another_export(self):
        import urllib.error
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False}, self.generation_done,
                             self.without_mesh, {"remaining_credits": 10000},
                             urllib.error.URLError("accepted mesh POST response lost"))
        with self.assertRaisesRegex(ValueError, "uncertain"):
            self.run_quietly(client)
        journal = self.cache() / "provider-state/mesh-export/generation.json"
        self.assertEqual(json.loads(journal.read_text())["state"], "submission_uncertain")
        journal.unlink()
        self.args.output = self.root / "mesh-journal-recovery"
        self.args.experiment_id = "mesh-journal-recovery"
        client = self.client({"remaining_credits": 0}, self.without_mesh)
        with self.assertRaisesRegex(ValueError, "mesh export journal is missing"):
            self.run_quietly(client)
        self.assertFalse(any(request.method == "POST" for request in self.api.requests))

    def test_missing_mesh_journal_reattaches_known_manifest_operation_read_only(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             self.generation_done,
                             self.without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False})
        with patch.object(experiment, "_wait", side_effect=ValueError("mesh polling interrupted")), \
                self.assertRaisesRegex(ValueError, "polling interrupted"):
            self.run_quietly(client)
        (self.cache() / "provider-state/mesh-export/generation.json").unlink()
        self.args.output = self.root / "known-mesh-recovery"
        self.args.experiment_id = "known-mesh-recovery"
        client = self.client({"remaining_credits": 0}, self.without_mesh, self.mesh_done, self.world)
        result = self.run_quietly(client)
        self.assertEqual(result["cacheStatus"], "resumed")
        self.assertEqual(result["meshOperationId"], "mesh-1")
        self.assertFalse(any(request.method == "POST" for request in self.api.requests))

    def test_missing_partial_journal_fails_closed(self):
        identity = generation_identity(prompt=self.args.prompt)
        cache = WorldCache(self.root / ".worldlabs-cache", identity)
        with cache.locked():
            cache.save(status="incomplete", providerWorkStarted=True)
        client = self.client()
        with self.assertRaisesRegex(ValueError, "journal is missing"):
            self.run_quietly(client)
        self.assertEqual(self.api.requests, [])

    def test_missing_credentials_do_not_poison_an_unused_cache(self):
        with patch.object(worldlabs.WorldLabsClient, "from_environment", side_effect=ValueError("Missing local key")), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "local key"):
            experiment.run_experiment(self.args, converter=self.convert_fake)
        result = self.complete()
        self.assertFalse(result["cacheHit"])
        self.assertEqual(result["cacheStatus"], "miss")

    def test_completed_legacy_output_backfills_without_network(self):
        self.complete()
        shutil.rmtree(self.root / ".worldlabs-cache")
        manifest_path = self.output / "experiment.json"
        legacy = json.loads(manifest_path.read_text())
        for name in ("cacheKey", "cacheHit", "cacheStatus", "seed"):
            legacy.pop(name, None)
        manifest_path.write_text(json.dumps(legacy))
        client = self.client()
        result = self.run_quietly(client)
        self.assertTrue(result["cacheHit"])
        self.assertTrue(json.loads((self.cache() / "cache.json").read_text())["backfilledExistingOutput"])
        self.assertEqual(self.api.requests, [])

    def test_interrupted_legacy_cache_copy_cannot_authorize_a_fresh_generation(self):
        self.complete()
        shutil.rmtree(self.root / ".worldlabs-cache")
        from film import world_cache
        def partial_copy(source, destination, **kwargs):
            # Simulate interruption after only some provider files arrived.
            target = destination / "provider-state/generation"
            target.mkdir(parents=True)
            shutil.copyfile(source / "provider-state/generation/generation.json", target / "generation.json")
            raise OSError("cache copy interrupted")
        with patch.object(world_cache, "copy_payload", side_effect=partial_copy), \
                self.assertRaisesRegex(OSError, "copy interrupted"):
            self.run_quietly(self.client())
        record = json.loads((self.cache() / "cache.json").read_text())
        self.assertEqual(record["worldId"], "same-world-1")
        self.assertTrue(record["providerWorkStarted"])
        self.args.output = self.root / "after-interrupted-seed"
        self.args.experiment_id = "after-interrupted-seed"
        with patch.object(worldlabs.WorldLabsClient, "from_environment", side_effect=AssertionError("No provider access")), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "copy was interrupted"):
            experiment.run_experiment(self.args, converter=self.convert_fake)

    def test_new_output_label_after_conversion_failure_keeps_exactly_three_worlds(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False}, self.generation_done,
                             self.without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        with patch.object(experiment, "prepare_reconstructed_mesh", side_effect=RuntimeError("conversion failed")), \
                self.assertRaisesRegex(RuntimeError, "conversion failed"):
            self.run_quietly(client)
        self.args.output = self.root / "renamed-recovery"
        self.args.experiment_id = "renamed-recovery"
        self.args.name = "New scene label"
        self.args.owner = "Different display owner"
        client = self.client({"remaining_credits": 0}, self.without_mesh)
        result = self.run_quietly(client)
        self.assertEqual(result["cacheStatus"], "resumed")
        self.assertEqual(len(list((self.args.output / "world-library/worlds").glob("*.json"))), 3)
        self.assertEqual(self.downloads.requests, [])
        self.assertFalse(any(request.method == "POST" for request in self.api.requests))
        from film.github_worlds import GitHubWorlds
        GitHubWorlds._validated_pair(self.args.output)

    def test_force_variation_is_explicit_and_stable_for_reruns(self):
        self.complete()
        original = (self.cache() / "cache.json").read_bytes()
        self.args.output = self.root / "variation-output"
        self.args.experiment_id = "variation"
        self.args.force_new = True
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "run-123"}):
            first = self.complete()
            self.assertFalse(first["cacheHit"])
            self.assertEqual(first["cacheVariation"], "run-123")
            client = self.client()
            second = self.run_quietly(client)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(self.api.requests, [])
        self.assertEqual((self.cache() / "cache.json").read_bytes(), original)

    def test_changed_inputs_have_a_separate_cache_entry(self):
        self.complete()
        original_key = self.key()
        self.args.output = self.root / "changed-input"
        self.args.experiment_id = "changed-input"
        self.args.prompt = "A different empty gallery"
        self.complete()
        self.assertNotEqual(self.key(), original_key)
        self.assertEqual(sum(request.method == "POST" for request in self.api.requests), 2)

    def test_cache_index_has_no_prompt_or_reference_url(self):
        self.args.reference_image_url = "https://example.org/private-reference.png?signature=private"
        self.complete()
        record = (self.cache() / "cache.json").read_text()
        self.assertNotIn(self.args.prompt, record)
        self.assertNotIn(self.args.reference_image_url, record)
        self.assertNotIn("fake-key", record)

    def test_interrupt_preserves_cache_and_output_operation_journals(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False})
        with patch.object(experiment, "_wait", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.run_quietly(client)
        for root in (self.output, self.cache()):
            self.assertEqual(worldlabs.load_generation(root / "provider-state/generation")["operationId"], "generation-1")

    def test_concurrent_identical_output_requests_create_only_one_provider_pair(self):
        # A blocked fake transport lets the other caller contend on the actual
        # cross-process flock before the first result has been published.
        entered, release = threading.Event(), threading.Event()
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False}, self.generation_done,
                             self.without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        original = client.create_generation
        def blocked(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Concurrent cache test timed out")
            return original(*args, **kwargs)
        client.create_generation = blocked
        first_args, second_args = copy.copy(self.args), copy.copy(self.args)
        second_args.output = self.root / "concurrent-output"
        second_args.experiment_id = "concurrent-output"
        errors, results = [], []
        def run(args):
            try:
                results.append(experiment.run_experiment(args, client=client, converter=self.convert_fake,
                                                         sleep=lambda _: self.fail("Unexpected sleep")))
            except BaseException as error:
                errors.append(error)
        with contextlib.redirect_stdout(io.StringIO()):
            first = threading.Thread(target=run, args=(first_args,))
            second = threading.Thread(target=run, args=(second_args,))
            first.start()
            self.assertTrue(entered.wait(5))
            second.start()
            release.set()
            first.join(5)
            second.join(5)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(sorted(result["cacheHit"] for result in results), [False, True])
        self.assertEqual(sum(request.method == "POST" for request in self.api.requests), 2)


if __name__ == "__main__":
    unittest.main()
