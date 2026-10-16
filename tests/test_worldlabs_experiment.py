"""The paid workflow is verified end-to-end using only fake HTTP responses."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film import worldlabs
from scripts import worldlabs_experiment as experiment
from tests.test_worldlabs import FakeOpener
import tests.test_worldlabs as provider_fixtures
from tests.test_worlds import glb_bytes


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "experiment"
        self.environment = patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "1", "GITHUB_STEP_SUMMARY": str(self.root / "summary.md")})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.args = experiment.parser().parse_args(["--output", str(self.output), "--model", "marble-1.1",
                                                  "--budget-credits", "6000", "--prompt", "Empty botanical studio"])
        helper = provider_fixtures.WorldLabsTests()
        self.world = helper.world_metadata()
        self.spz = helper.spz_bytes()
        self.without_mesh = copy.deepcopy(self.world)
        del self.without_mesh["assets"]["mesh"]["hq_mesh_url"]
        self.generation_done = {"operation_id": "generation-1", "done": True, "response": self.without_mesh,
                                "cost": {"total_credits": 1580}}
        self.mesh_done = {"operation_id": "mesh-1", "done": True, "cost": {"total_credits": 3500},
                          "response": {"asset_type": "mesh", "format": "glb", "mesh_variant": "textured",
                                       "url": "https://assets.worldlabs.ai/hq.glb"}}

    def client(self, *responses):
        self.api = FakeOpener(*responses)
        self.downloads = FakeOpener(glb_bytes(), self.spz)
        return worldlabs.WorldLabsClient("fake-key-do-not-persist", opener=self.api, download_opener=self.downloads)

    def run_quietly(self, client):
        with contextlib.redirect_stdout(io.StringIO()):
            return experiment.run_experiment(self.args, client=client, sleep=lambda _: self.fail("Unexpected sleep"),
                                             converter=self.convert_fake)

    def convert_fake(self, source, output, **kwargs):
        output.write_bytes(glb_bytes())
        return {"algorithm": "Synthetic conversion transport test", "sourceSha256": __import__("hashlib").sha256(source.read_bytes()).hexdigest(),
                "quality": "unreviewed", "parameters": kwargs}

    def test_one_world_one_mesh_export_and_fifteen_unreviewed_probe_scenes(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False}, self.generation_done,
                             self.without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        manifest = self.run_quietly(client)
        posts = [r for r in self.api.requests if r.method == "POST"]
        self.assertEqual(len(posts), 2)
        self.assertTrue(posts[0].full_url.endswith("/worlds:generate"))
        self.assertTrue(posts[1].full_url.endswith("/worlds/same-world-1:export"))
        self.assertEqual(manifest["documentedMaximumCredits"], 5080)
        self.assertEqual(manifest["qualityGate"], "unreviewed")
        self.assertFalse(manifest["rendersCompleted"])
        comparison = json.loads((self.output / "comparison" / "comparison.json").read_text())
        self.assertEqual(len(comparison["results"]), 15)
        self.assertEqual(comparison["pairing"]["worldId"], "same-world-1")
        self.assertEqual(comparison["gaussianFinalRepresentation"], "mesh")
        self.assertEqual(set(comparison["conditions"]), {"mesh", "gaussianMesh"})
        self.assertEqual(len(list((self.output / "world-library" / "worlds").glob("*.json"))), 3)
        pair = json.loads((self.output / "world-pair.json").read_text())
        self.assertEqual(pair["gaussianMesh"]["environment"]["kind"], "mesh")
        self.assertEqual(pair["gaussianMesh"]["environment"]["provenance"]["sourceSplatSha256"], pair["splat"]["environment"]["asset"]["sha256"])
        summary = (self.root / "summary.md").read_text()
        self.assertIn("generation-1", summary)
        self.assertIn("mesh-1", summary)
        for path in self.output.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"fake-key-do-not-persist", path.read_bytes())

    def test_existing_world_with_cached_hq_mesh_imports_without_any_paid_post(self):
        self.args.world_id = "same-world-1"
        client = self.client(self.world, {"remaining_credits": 0}, self.world)
        manifest = self.run_quietly(client)
        self.assertTrue(manifest["meshExportReusedExistingAsset"])
        self.assertFalse(any(r.method == "POST" for r in self.api.requests))

    def test_generation_operation_recovery_never_creates_a_new_world(self):
        self.args.generation_operation_id = "generation-1"
        client = self.client({"remaining_credits": 10000}, {"operation_id": "generation-1", "done": False},
                             self.generation_done, self.without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        self.run_quietly(client)
        posts = [r for r in self.api.requests if r.method == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0].full_url.endswith(":export"))

    def test_nullable_mesh_metadata_after_generation_still_requests_one_hq_export(self):
        without_mesh = copy.deepcopy(self.without_mesh)
        without_mesh["assets"]["mesh"] = None
        generation = dict(self.generation_done, response=without_mesh)
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False}, generation,
                             without_mesh, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        manifest = self.run_quietly(client)
        self.assertEqual(manifest["state"], "prepared-for-review")
        posts = [request for request in self.api.requests if request.method == "POST"]
        self.assertEqual(len(posts), 2)
        self.assertTrue(posts[0].full_url.endswith("/worlds:generate"))
        self.assertTrue(posts[1].full_url.endswith("/worlds/same-world-1:export"))

    def test_nullable_mesh_metadata_on_existing_world_recovers_with_one_export(self):
        self.args.world_id = "same-world-1"
        without_mesh = copy.deepcopy(self.without_mesh)
        without_mesh["assets"]["mesh"] = None
        client = self.client(without_mesh, {"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "mesh-1", "done": False}, self.mesh_done, self.world)
        manifest = self.run_quietly(client)
        self.assertEqual(manifest["state"], "prepared-for-review")
        posts = [request for request in self.api.requests if request.method == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0].full_url.endswith("/worlds/same-world-1:export"))

    def test_plus_model_rejects_6000_cap_before_any_network_request(self):
        self.args.model = "marble-1.1-plus"
        client = self.client()
        with self.assertRaisesRegex(ValueError, "cap"):
            self.run_quietly(client)
        self.assertEqual(self.api.requests, [])

    def test_github_rerun_requires_existing_operation_or_world_before_paid_work(self):
        client = self.client()
        with patch.dict(os.environ, {"GITHUB_RUN_ATTEMPT": "2"}), self.assertRaisesRegex(ValueError, "rerun"):
            self.run_quietly(client)
        self.assertEqual(self.api.requests, [])

    def test_mesh_recovery_cannot_accidentally_generate_an_unrelated_new_world(self):
        self.args.mesh_operation_id = "mesh-1"
        client = self.client()
        with self.assertRaisesRegex(ValueError, "existing world"):
            self.run_quietly(client)
        self.assertEqual(self.api.requests, [])

    def test_poll_timeout_preserves_operation_and_marks_experiment_incomplete(self):
        client = self.client({"remaining_credits": 10000}, {"remaining_credits": 10000},
                             {"operation_id": "generation-1", "done": False})
        ticks = iter((0, 100000))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "time budget"):
            experiment.run_experiment(self.args, client=client, monotonic=lambda: next(ticks), converter=self.convert_fake)
        state = worldlabs.load_generation(self.output / "provider-state" / "generation")
        self.assertEqual(state["operationId"], "generation-1")
        manifest = json.loads((self.output / "experiment.json").read_text())
        self.assertEqual(manifest["state"], "incomplete")
        self.assertEqual(sum(r.method == "POST" for r in self.api.requests), 1)

    def test_missing_reconstruction_runtime_prevents_paid_work(self):
        client = self.client()
        with patch.object(experiment, "preflight_reconstruction", side_effect=ValueError("Install conversion dependencies")):
            with self.assertRaisesRegex(ValueError, "conversion dependencies"):
                experiment.run_experiment(self.args, client=client)
        self.assertEqual(self.api.requests, [])


if __name__ == "__main__":
    unittest.main()
