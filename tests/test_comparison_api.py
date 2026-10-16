"""Paired queue transactions, recovery, exports, and the real local HTTP boundary."""

import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from film import jobs, server
from film.comparison import comparison_payload, set_alternative
from film.comparison_jobs import ComparisonJobs
from film.scene import load_scene, scene_digest
from film.store import ConflictError, ProjectStore, ROOT
from film.worlds import list_worlds
from tests import test_editor_api as editor_api
from tests.test_jobs import png_bytes


def paired_scene(store):
    scene = load_scene(ROOT / "examples" / "bottle.scene.json")
    worlds = [entry["environment"] for entry in list_worlds(store.root) if entry["environment"]["kind"] == "mesh"]
    scene["environment"].update(copy.deepcopy(worlds[0]))
    return set_alternative(scene, worlds[1])


def complete_child(renders, child_id, *, value=70):
    directory = renders.directory(child_id)
    job = jobs._read_job(directory)
    name = "still.png" if job.get("kind") == "still" else "film.mp4"
    profile = job["renderProfile"]
    payload = png_bytes(profile["width"], profile["height"], value=value) if name.endswith(".png") else b"verified-worker-video-fixture"
    (directory / name).write_bytes(payload)
    job.update(state="succeeded", artifacts={name: {"sha256": jobs._sha256(directory / name), "bytes": len(payload)}})
    jobs._save_job(directory, job)
    renders.active.discard(child_id)
    return payload


class ComparisonQueueTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = ProjectStore(Path(temporary.name) / "data")
        self.store.seed_worlds()
        with patch.object(server.RenderQueue, "_worker", return_value=None):
            self.renders = server.RenderQueue(self.store, base_url="http://127.0.0.1:8787")
            self.renders.thread.join(timeout=2)
        self.pairs = ComparisonJobs(self.renders)
        self.scene = paired_scene(self.store)

    def create(self, **kwargs):
        return self.pairs.create({"scene": self.scene, "kind": "still", "frame": 60, "width": 4, "height": 6, "samples": 1, **kwargs})

    def test_both_children_and_immutable_parent_exist_before_first_enqueue(self):
        seen = []
        enqueue = self.renders.enqueue

        def observe(child_id, **kwargs):
            parents = list(self.pairs.root.glob("*/pair.json"))
            self.assertEqual(len(parents), 1)
            parent = json.loads(parents[0].read_text())
            self.assertEqual(len(parent["children"]), 2)
            for child in parent["children"].values():
                directory = self.renders.directory(child["id"])
                self.assertTrue((directory / "job.json").is_file())
                self.assertTrue((directory / "samples.json").is_file())
                self.assertTrue((directory / "request.json").is_file())
            seen.append(child_id)
            enqueue(child_id, **kwargs)

        with patch.object(self.renders, "enqueue", side_effect=observe):
            pair = self.create()
        self.assertEqual(seen, [pair["children"][side]["id"] for side in ("a", "b")])
        record = self.pairs._read(pair["id"])
        self.assertEqual(record["children"]["a"]["renderProfile"], record["children"]["b"]["renderProfile"])
        self.assertEqual(record["frameDigest"], scene_digest([60]))
        self.assertEqual(record["sourceDigest"], scene_digest(self.scene))
        self.assertEqual(record["sharedDigest"], comparison_payload(self.scene)["sharedDigest"])
        self.assertEqual(pair["state"], "queued")

    def test_second_child_setup_failure_leaves_no_jobs_parent_or_queue_items(self):
        create = self.renders.create
        count = 0

        def prepare(data, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise ValueError("Second world asset failed validation")
            return create(data, **kwargs)

        with patch.object(self.renders, "create", side_effect=prepare), patch.object(self.renders, "enqueue") as enqueue:
            with self.assertRaisesRegex(ValueError, "Second world"):
                self.create()
        enqueue.assert_not_called()
        self.assertEqual(list(self.renders.root.iterdir()), [])
        self.assertEqual(list(self.pairs.root.iterdir()), [])
        self.assertEqual(self.renders.pending.qsize(), 0)
        self.assertEqual(self.renders.active, set())
        self.assertEqual(self.renders.prepared, set())

    def test_mismatched_child_profile_is_rolled_back_before_enqueue(self):
        create = self.renders.create
        count = 0

        def prepare(data, **kwargs):
            nonlocal count
            count += 1
            return create({**data, "samples": 2} if count == 2 else data, **kwargs)

        with patch.object(self.renders, "create", side_effect=prepare), patch.object(self.renders, "enqueue") as enqueue:
            with self.assertRaisesRegex(ValueError, "identical profiles"):
                self.create()
        enqueue.assert_not_called()
        self.assertEqual(list(self.renders.root.iterdir()), [])
        self.assertEqual(list(self.pairs.root.iterdir()), [])

    def test_second_child_failure_after_directory_creation_rolls_back_both_jobs(self):
        create_still = server.create_still_job
        count = 0

        def fail_after_snapshot(source, output, **kwargs):
            nonlocal count
            count += 1
            result = create_still(source, output, **kwargs)
            if count == 2:
                self.assertTrue((output / "job.json").is_file())
                raise ValueError("Second child failed after snapshot creation")
            return result

        with patch.object(server, "create_still_job", side_effect=fail_after_snapshot), patch.object(self.renders, "enqueue") as enqueue:
            with self.assertRaisesRegex(ValueError, "after snapshot creation"):
                self.create()
        enqueue.assert_not_called()
        self.assertEqual(list(self.renders.root.iterdir()), [])
        self.assertEqual(list(self.pairs.root.iterdir()), [])
        self.assertEqual(self.renders.pending.qsize(), 0)
        self.assertEqual(self.renders.prepared, set())

    def test_different_child_renderer_snapshots_are_rejected_before_enqueue(self):
        create = self.renders.create
        count = 0

        def prepare(data, **kwargs):
            nonlocal count
            count += 1
            child = create(data, **kwargs)
            if count == 2:
                directory = self.renders.directory(child["id"])
                renderer = directory / "renderer.py"
                renderer.write_bytes(renderer.read_bytes() + b"\n# changed renderer during pair preparation\n")
                job = jobs._read_job(directory)
                job["rendererDigest"] = jobs._sha256(renderer)
                jobs._save_job(directory, job)
            return child

        with patch.object(self.renders, "create", side_effect=prepare), patch.object(self.renders, "enqueue") as enqueue:
            with self.assertRaisesRegex(ValueError, "same renderer"):
                self.create()
        enqueue.assert_not_called()
        self.assertEqual(list(self.renders.root.iterdir()), [])
        self.assertEqual(list(self.pairs.root.iterdir()), [])

    def test_prepared_single_job_is_not_enqueued_until_explicitly_scheduled(self):
        child = self.renders.create({"scene": comparison_payload(self.scene)["a"], "width": 4, "height": 6, "samples": 1}, enqueue=False)
        self.assertEqual(child["state"], "queued")
        self.assertEqual(self.renders.pending.qsize(), 0)
        self.assertEqual(self.renders.active, set())
        self.renders.enqueue(child["id"])
        self.assertEqual(self.renders.pending.qsize(), 1)
        self.assertEqual(self.renders.active, {child["id"]})

    def test_invalid_frame_rolls_back_without_preparing_any_child(self):
        with self.assertRaises(ValueError):
            self.create(frame=361)
        self.assertEqual(list(self.renders.root.iterdir()), [])
        self.assertEqual(list(self.pairs.root.iterdir()), [])
        self.assertEqual(self.renders.pending.qsize(), 0)

    def test_crash_before_enqueue_reports_prepared_child_as_interrupted_after_restart(self):
        child = self.renders.create({"scene": comparison_payload(self.scene)["a"], "width": 4, "height": 6, "samples": 1}, enqueue=False)
        self.assertEqual(child["state"], "queued")
        with patch.object(server.RenderQueue, "_worker", return_value=None):
            restarted = server.RenderQueue(self.store, base_url="http://127.0.0.1:8787")
            restarted.thread.join(timeout=2)
        self.assertEqual(restarted.summary(child["id"])["state"], "interrupted")

    def test_parent_state_reconciles_durably_after_restart(self):
        pair = self.create()
        with patch.object(server.RenderQueue, "_worker", return_value=None):
            restarted = server.RenderQueue(self.store, base_url="http://127.0.0.1:8787")
            restarted.thread.join(timeout=2)
        recovered = ComparisonJobs(restarted).summary(pair["id"])
        self.assertEqual(recovered["state"], "interrupted")
        self.assertEqual({child["state"] for child in recovered["children"].values()}, {"interrupted"})
        self.assertEqual(recovered["sourceDigest"], pair["sourceDigest"])
        self.assertEqual(restarted.pending.qsize(), 0)

    def test_resume_and_cancel_preserve_successful_child_and_source_bytes(self):
        pair = self.create()
        first, second = (pair["children"][side]["id"] for side in ("a", "b"))
        complete_child(self.renders, first)
        source_path = self.renders.directory(first) / "scene.json"
        source_bytes = source_path.read_bytes()
        cancelled = self.pairs.cancel(pair["id"])
        self.assertEqual(cancelled["children"]["a"]["state"], "succeeded")
        self.assertFalse((self.renders.directory(first) / "cancel.requested").exists())
        self.assertTrue((self.renders.directory(second) / "cancel.requested").exists())
        self.renders.active.discard(second)
        with patch.object(self.renders, "enqueue", wraps=self.renders.enqueue) as enqueue:
            resumed = self.pairs.resume(pair["id"])
        enqueue.assert_called_once_with(second, resume=True)
        self.assertEqual(resumed["state"], "queued")
        self.assertEqual(resumed["children"]["b"]["state"], "queued")
        self.assertEqual(resumed["children"]["a"]["state"], "succeeded")
        self.assertEqual(source_path.read_bytes(), source_bytes)
        self.assertFalse((self.renders.directory(second) / "cancel.requested").exists())

    def test_single_resume_rejects_cancellation_still_stopping_and_retains_cancel_flag(self):
        child = self.renders.create({"scene": comparison_payload(self.scene)["a"], "width": 4, "height": 6, "samples": 1})
        count = self.renders.pending.qsize()
        self.renders.enqueue(child["id"], resume=True)
        self.assertEqual(self.renders.pending.qsize(), count)
        self.renders.cancel(child["id"])
        with self.assertRaisesRegex(ConflictError, "Cancellation still stopping"):
            self.renders.enqueue(child["id"], resume=True)
        self.assertTrue((self.renders.directory(child["id"]) / "cancel.requested").exists())
        self.assertEqual(self.renders.pending.qsize(), count)
        self.assertEqual(self.renders.summary(child["id"])["state"], "cancelled")

    def test_pair_resume_preflights_active_cancelled_child_before_resuming_stopped_sibling(self):
        pair = self.create()
        self.pairs.cancel(pair["id"])
        first, second = (pair["children"][side]["id"] for side in ("a", "b"))
        self.renders.active.discard(first)
        request_path = self.renders.directory(first) / "request.json"
        before = request_path.read_bytes()
        count = self.renders.pending.qsize()
        with patch.object(self.renders, "enqueue", wraps=self.renders.enqueue) as enqueue:
            with self.assertRaisesRegex(ConflictError, "Cancellation still stopping"):
                self.pairs.resume(pair["id"])
        enqueue.assert_not_called()
        self.assertEqual(request_path.read_bytes(), before)
        self.assertEqual(self.renders.pending.qsize(), count)
        for child_id in (first, second):
            self.assertTrue((self.renders.directory(child_id) / "cancel.requested").exists())
        self.renders.active.discard(second)
        self.assertEqual(self.pairs.resume(pair["id"])["state"], "queued")

    def test_both_immutable_children_are_verified_before_resume_schedules_either(self):
        pair = self.create()
        b = self.renders.directory(pair["children"]["b"]["id"])
        (b / "samples.json").write_text("{}")
        with patch.object(self.renders, "enqueue") as enqueue:
            with self.assertRaisesRegex(ValueError, "snapshots changed"):
                self.pairs.resume(pair["id"])
        enqueue.assert_not_called()
        self.assertEqual(self.pairs.summary(pair["id"])["state"], "failed")

    def test_cancel_stops_both_children_even_when_one_snapshot_fails_validation(self):
        pair = self.create()
        b = self.renders.directory(pair["children"]["b"]["id"])
        (b / "samples.json").write_text("{}")
        self.pairs.cancel(pair["id"])
        for child in pair["children"].values():
            self.assertTrue((self.renders.directory(child["id"]) / "cancel.requested").exists())

    def test_modified_parent_source_and_profile_are_rejected(self):
        pair = self.create()
        directory = self.pairs.directory(pair["id"])
        source_path = directory / "scene.json"
        source = json.loads(source_path.read_text())
        source["product"]["label"]["text"] = "MODIFIED AFTER CREATION"
        jobs._atomic_json(source_path, source)
        with self.assertRaisesRegex(ValueError, "source revision"):
            self.pairs.summary(pair["id"])
        jobs._atomic_json(source_path, self.scene)
        parent = json.loads((directory / "pair.json").read_text())
        parent["frame"] = 61
        jobs._atomic_json(directory / "pair.json", parent)
        with self.assertRaisesRegex(ValueError, "settings were modified"):
            self.pairs.summary(pair["id"])

    def test_success_exports_exact_two_images_and_pinned_manifest(self):
        pair = self.create()
        expected = {side: complete_child(self.renders, pair["children"][side]["id"], value=value)
                    for side, value in (("a", 30), ("b", 180))}
        succeeded = self.pairs.summary(pair["id"])
        self.assertEqual(succeeded["state"], "succeeded")
        self.assertEqual({artifact["name"] for artifact in succeeded["artifacts"]}, {"comparison.json", "pair.zip"})
        with zipfile.ZipFile(self.pairs.artifact(pair["id"], "pair.zip")) as archive:
            self.assertEqual(set(archive.namelist()), {"comparison.json", "a/still.png", "b/still.png"})
            for side in ("a", "b"):
                self.assertEqual(archive.read(f"{side}/still.png"), expected[side])
            manifest = json.loads(archive.read("comparison.json"))
        self.assertEqual(manifest["sharedDigest"], pair["sharedDigest"])
        self.assertEqual(manifest["sourceDigest"], pair["sourceDigest"])
        self.assertEqual(manifest["frame"], 60)
        self.assertEqual(manifest["alignmentStatus"], "draft")
        self.assertEqual(manifest, json.loads(self.pairs.artifact(pair["id"], "comparison.json").read_text()))
        with self.assertRaises(ValueError):
            self.pairs.artifact(pair["id"], "../scene.json")

    def test_reel_export_uses_two_videos_and_preserves_matching_complete_profile(self):
        pair = self.create(kind="reel")
        for child in pair["children"].values():
            complete_child(self.renders, child["id"])
        with zipfile.ZipFile(self.pairs.artifact(pair["id"], "pair.zip")) as archive:
            self.assertEqual(set(archive.namelist()), {"comparison.json", "a/film.mp4", "b/film.mp4"})
            manifest = json.loads(archive.read("comparison.json"))
        self.assertIsNone(manifest["frame"])
        self.assertEqual(manifest["frameDigest"], scene_digest(list(range(1, 361))))
        self.assertEqual(manifest["children"]["a"]["renderProfile"], manifest["children"]["b"]["renderProfile"])

    def test_corrupted_success_output_hides_pair_and_only_that_child_resumes(self):
        pair = self.create()
        for child in pair["children"].values():
            complete_child(self.renders, child["id"])
        self.assertEqual(self.pairs.summary(pair["id"])["state"], "succeeded")
        b = pair["children"]["b"]["id"]
        (self.renders.directory(b) / "still.png").write_bytes(b"edited after success")
        summary = self.pairs.summary(pair["id"])
        self.assertEqual(summary["state"], "failed")
        self.assertEqual(summary["artifacts"], [])
        with self.assertRaises(ValueError):
            self.pairs.artifact(pair["id"], "pair.zip")
        with patch.object(self.renders, "enqueue", wraps=self.renders.enqueue) as enqueue:
            self.pairs.resume(pair["id"])
        enqueue.assert_called_once_with(b, resume=True)


class ComparisonApiTests(unittest.TestCase):
    setUp = editor_api.EditorApiTests.setUp
    stop_server = editor_api.EditorApiTests.stop_server
    request = editor_api.EditorApiTests.request
    bootstrap = editor_api.EditorApiTests.bootstrap

    def scene(self):
        return paired_scene(self.app.store)

    def test_evaluate_exposes_both_worlds_with_original_source_and_shared_samples(self):
        scene = self.scene()
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": scene})
        self.assertEqual(status, 200)
        self.assertEqual(sampled["scene"], scene)
        self.assertEqual(sampled["digest"], scene_digest(scene))
        self.assertEqual(len(sampled["frames"]), 360)
        self.assertEqual(sampled["comparison"], comparison_payload(scene))
        self.assertNotIn("comparison", sampled["comparison"]["a"])
        self.assertNotIn("comparison", sampled["comparison"]["b"])
        plain = self.bootstrap()["project"]["scene"]
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": plain})
        self.assertEqual(status, 200)
        self.assertNotIn("comparison", sampled)

    def test_calibration_and_review_routes_preserve_product_and_invalidate_changed_alignment(self):
        scene = self.scene()
        status, result, _ = self.request("POST", "/api/comparison/calibrate", {"scene": scene, "side": "b", "calibration": {
            "sourceFloorPoint": [0, 2, 0], "measurement": {"sourcePoints": [[0, 0, 0], [2, 0, 0]], "realDistanceM": 1},
            "yawDeltaDegrees": 30}})
        self.assertEqual(status, 200)
        calibrated = result["scene"]
        self.assertEqual(calibrated["product"], scene["product"])
        self.assertEqual(calibrated["shots"], scene["shots"])
        self.assertEqual(calibrated["comparison"]["alternative"]["asset"]["scaleToMeters"], .5)
        status, reviewed, _ = self.request("POST", "/api/comparison/review", {"scene": calibrated})
        self.assertEqual(status, 200)
        self.assertEqual(comparison_payload(reviewed["scene"])["alignmentStatus"], "reviewed")
        status, changed, _ = self.request("POST", "/api/comparison/calibrate", {"scene": reviewed["scene"], "side": "a",
            "calibration": {"yawDeltaDegrees": 10}})
        self.assertEqual(status, 200)
        self.assertEqual(comparison_payload(changed["scene"])["alignmentStatus"], "draft")
        status, error, _ = self.request("POST", "/api/comparison/calibrate", {"scene": scene, "side": "other", "calibration": {"yawDeltaDegrees": 10}})
        self.assertEqual(status, 400)
        self.assertIn("error", error)

    def test_paired_routes_create_list_resume_cancel_and_gate_artifacts(self):
        scene = self.scene()
        status, pair, _ = self.request("POST", "/api/comparison-renders", {"scene": scene, "kind": "still", "frame": 42,
            "width": 4, "height": 6, "samples": 1})
        self.assertEqual(status, 202)
        route = f"/api/comparison-renders/{pair['id']}"
        self.assertEqual(self.request("GET", route)[1], pair)
        self.assertEqual(self.request("GET", "/api/comparison-renders")[1], [pair])
        self.assertEqual(self.request("GET", route + "/files/pair.zip")[0], 400)
        status, cancelled, _ = self.request("POST", route + "/cancel", {})
        self.assertEqual(status, 200)
        self.assertEqual(cancelled["state"], "cancelled")
        status, conflict, _ = self.request("POST", route + "/resume", {})
        self.assertEqual(status, 409)
        self.assertIn("Cancellation still stopping", conflict["error"])
        for child in pair["children"].values():
            self.app.renders.active.discard(child["id"])
        status, resumed, _ = self.request("POST", route + "/resume", {})
        self.assertEqual(status, 202)
        self.assertEqual(resumed["state"], "queued")
        for child in pair["children"].values():
            complete_child(self.app.renders, child["id"])
        status, manifest, _ = self.request("GET", route + "/files/comparison.json")
        self.assertEqual(status, 200)
        self.assertEqual(manifest["sourceDigest"], scene_digest(scene))
        status, payload, headers = self.request("GET", route + "/files/pair.zip")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/zip")
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertEqual(set(archive.namelist()), {"comparison.json", "a/still.png", "b/still.png"})
        self.assertEqual(self.request("GET", route + "/files/scene.json")[0], 400)

    def test_invalid_pair_and_foreign_origin_leave_no_child_jobs(self):
        plain = self.bootstrap()["project"]["scene"]
        status, error, _ = self.request("POST", "/api/comparison-renders", {"scene": plain})
        self.assertEqual(status, 400)
        self.assertIn("error", error)
        status, _, _ = self.request("POST", "/api/comparison-renders", {"scene": self.scene()}, headers={"Origin": "https://foreign.invalid"})
        self.assertEqual(status, 403)
        self.assertEqual(self.request("GET", "/api/jobs")[1], [])
        self.assertEqual(self.request("GET", "/api/comparison-renders")[1], [])


if __name__ == "__main__":
    unittest.main()
