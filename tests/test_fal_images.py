"""Fal submissions are resumable, and uncalibrated references never become posed frames."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from film.atlas_client import AtlasError
from film.atlas_worlds import AtlasWorlds, GUIDE_ID
from film.fal_images import FalClient, MODEL, BASE_MODEL, QUEUE_ROOT, _image_suffix
from tests.test_atlas_client import FakeDownload, FakeOpener, png


class FalTransportTests(unittest.TestCase):
    def test_full_fal_2k_frame_is_allowed_without_changing_atlas_depth_limits(self):
        output = io.BytesIO()
        Image.new("RGB", (2816, 1536), "white").save(output, format="PNG")
        self.assertEqual(_image_suffix(output), ".png")
        oversized = io.BytesIO()
        Image.new("RGB", (4097, 2), "white").save(oversized, format="PNG")
        with self.assertRaisesRegex(AtlasError, "pixel budget"):
            _image_suffix(oversized)

    def test_queue_uses_official_routes_and_keeps_the_key_out_of_result_urls(self):
        opener = FakeOpener({"request_id": "req_one"}, {"status": "COMPLETED"}, {"images": []})
        client = FalClient("fixture-key", opener=opener)
        self.assertEqual(client.submit({"prompt": "A consistent room"}), "req_one")
        client.status("req_one")
        client.result("req_one")
        self.assertEqual([request.full_url for request in opener.requests], [
            QUEUE_ROOT + BASE_MODEL,
            QUEUE_ROOT + "fal-ai/nano-banana-pro/requests/req_one/status",
            QUEUE_ROOT + "fal-ai/nano-banana-pro/requests/req_one",
        ])
        self.assertTrue(all(request.get_header("Authorization") == "Key fixture-key" for request in opener.requests))
        self.assertEqual(opener.requests[0].get_header("X-fal-no-retry"), "1")
        self.assertNotIn("image_urls", json.loads(opener.requests[0].data))
        with self.assertRaises(AtlasError):
            client.status("../another-account")

    def test_visual_references_use_the_edit_endpoint(self):
        opener = FakeOpener({"request_id": "req_edit"})
        client = FalClient("fixture-key", opener=opener)
        body = {"prompt": "Warmer stone", "image_urls": ["data:image/png;base64,fixture"]}
        client.submit(body)
        self.assertEqual(opener.requests[0].full_url, QUEUE_ROOT + MODEL)
        self.assertEqual(json.loads(opener.requests[0].data), body)

    def test_download_uses_vetted_addresses_without_account_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "image"
            connection = Mock()
            connection.getresponse.return_value = FakeDownload(png())
            with (patch("film.fal_images._public_addresses", return_value=["8.8.8.8"]),
                  patch("film.fal_images._AssetConnection", return_value=connection)):
                self.assertEqual(FalClient("fixture-key").download_image("https://fal.media/image.png?signature=one", destination), ".png")
            connection.request.assert_called_once_with("GET", "/image.png?signature=one",
                                                      headers={"Accept": "image/png,image/jpeg,image/webp"})
            self.assertEqual(destination.read_bytes(), png())


class FalReferenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        env = patch.dict(os.environ, {"FAL_KEY": "fal-fixture-key", "WLT_API_KEY": "atlas-fixture-key"})
        env.start()
        self.addCleanup(env.stop)
        self.fal = Mock()
        self.fal.submit.side_effect = [f"req_{index}" for index in range(20)]
        self.fal.status.return_value = {"status": "COMPLETED"}
        self.fal.result.return_value = {"images": [{"url": "https://fal.media/signed-image.png"}]}
        def download(url, destination):
            Image.new("RGB", (8, 4), "white").save(destination, format="PNG")
            return ".png"
        self.fal.download_image.side_effect = download
        self.atlas = Mock()
        self.atlas.submit_task.return_value = {"id": "op_pose", "done": False}

    def service(self):
        return AtlasWorlds(self.root, client_factory=lambda _: self.atlas, fal_factory=lambda _: self.fal)

    def submit(self, **kwargs):
        return self.service().submit({"guideId": GUIDE_ID, "imageProvider": "fal", "communityOptIn": False, **kwargs})

    def finish_concepts(self):
        run = self.submit()
        return self.service().refresh(run["id"])

    def finish_references(self):
        concepts = self.finish_concepts()
        references = self.service().select_concept(concepts["id"], {"conceptIndex": 0})
        return self.service().refresh(references["id"])

    def test_three_concepts_then_four_references_pose_only_after_explicit_build(self):
        concepts = self.submit(prompt="A cozy designer desk with warm orange lighting")
        self.assertEqual(concepts["stage"], "concepts")
        self.assertEqual(self.fal.submit.call_count, 3)
        self.assertEqual(self.submit(prompt="A cozy designer desk with warm orange lighting"), concepts)
        self.assertEqual(self.fal.submit.call_count, 3)
        for call in self.fal.submit.call_args_list:
            self.assertEqual(call.args[0]["image_urls"], [])
            self.assertIn("cozy designer desk", call.args[0]["prompt"])
            self.assertNotIn("ribbed-glass wall", call.args[0]["prompt"])
        concepts = self.service().refresh(concepts["id"])
        self.assertEqual(len(concepts["concepts"]), 3)
        self.assertTrue(self.service().concept(concepts["id"], "2").is_file())
        self.atlas.submit_task.assert_not_called()
        run = self.service().select_concept(concepts["id"], {"conceptIndex": 1})
        self.assertEqual(run["selectedConcept"], 1)
        self.assertEqual(run["parentId"], concepts["id"])
        self.assertEqual(self.fal.submit.call_count, 7)
        self.assertTrue(all(len(call.args[0]["image_urls"]) == 1 for call in self.fal.submit.call_args_list[-4:]))
        self.assertEqual(self.service().select_concept(concepts["id"], {"conceptIndex": 1}), run)
        run = self.service().refresh(run["id"])
        self.assertEqual(run["state"], "succeeded")
        self.assertEqual(len(run["views"]), 4)
        self.assertTrue(all("camera" not in view for view in run["views"]))
        self.assertNotIn("signed-image", json.dumps(run))
        self.assertNotIn("frames", self.service()._read(run["id"]))
        self.assertTrue(self.service().view(run["id"], "0").is_file())
        self.atlas.submit_task.assert_not_called()

        posed = self.service().reconstruct(run["id"], "draft")
        self.assertEqual(posed["stage"], "pose")
        task, body, key = self.atlas.submit_task.call_args.args
        self.assertEqual(task, "images2PosedRGBD")
        self.assertEqual(len(body["frames"]), 4)
        self.assertTrue(all(set(frame) == {"imageAsset"} for frame in body["frames"]))
        self.assertTrue(all(frame["imageAsset"]["base64"].startswith("data:image/png;base64,") for frame in body["frames"]))
        self.assertEqual(body["targetResolution"], [1280, 720])
        self.assertTrue(body["refinePoses"])

        camera = {"extrinsics": {"position": [0, 1, 0], "quaternion": [0, 0, 0, 1]},
                  "intrinsics": {"width": 1280, "height": 720, "fx": 900, "fy": 900, "cx": 640, "cy": 360}}
        frames = [{"camera": camera, "imageAsset": {"assetId": f"image_{index}"},
                   "depth": {"depthAsset": {"assetId": f"depth_{index}"}}} for index in range(4)]
        self.atlas.operation.return_value = {"id": "op_pose", "done": True, "response": {"frames": frames}}
        self.atlas.submit_task.return_value = {"id": "op_draft", "done": False}
        draft = self.service().refresh(run["id"])
        self.assertEqual(draft["stage"], "draft")
        self.assertEqual(self.atlas.submit_task.call_args.args[0], "posedImages2Splats")
        self.assertEqual(self.atlas.submit_task.call_args.args[1]["posedFrames"], self.service()._read(run["id"])["frames"])

    def test_revision_uses_parent_images_and_preserves_parent_bytes(self):
        parent = self.finish_references()
        original = self.service()._path(parent["id"]).read_bytes()
        child = self.service().revise(parent["id"], {"instruction": "Warmer stone, same layout"})
        self.assertEqual(child["parentId"], parent["id"])
        self.assertEqual(child["revision"], parent["revision"] + 1)
        self.assertFalse(child["communityOptIn"])
        self.assertEqual(self.fal.submit.call_count, 11)
        for call in self.fal.submit.call_args_list[-4:]:
            self.assertEqual(len(call.args[0]["image_urls"]), 4)
            self.assertIn("Warmer stone", call.args[0]["prompt"])
        self.assertEqual(self.service()._path(parent["id"]).read_bytes(), original)
        self.atlas.submit_task.assert_not_called()

    def test_ambiguous_post_retains_known_receipts_and_never_retries(self):
        self.fal.submit.side_effect = ["req_first", AtlasError("Connection interrupted")]
        run = self.submit()
        self.assertEqual(run["state"], "uncertain")
        self.assertEqual(self.fal.submit.call_count, 2)
        self.assertEqual(self.submit(), run)
        self.assertEqual(self.service().refresh(run["id"]), run)
        self.assertEqual(self.fal.submit.call_count, 2)
        saved = self.service()._read(run["id"])
        self.assertEqual(saved["jobs"]["concepts"]["requests"][0]["requestId"], "req_first")

    def test_explicit_retry_after_rejection_keeps_the_previously_accepted_image(self):
        self.fal.submit.side_effect = ["req_first", AtlasError("Payment required", status=402)]
        run = self.submit()
        self.assertEqual(run["state"], "failed")
        self.assertTrue(run["canRetry"])
        self.fal.submit.side_effect = ["req_second", "req_third"]
        retried = self.submit()
        self.assertEqual(retried["id"], run["id"])
        self.assertEqual(self.fal.submit.call_count, 4)
        self.assertEqual([item["requestId"] for item in self.service()._read(run["id"])["jobs"]["concepts"]["requests"]],
                         ["req_first", "req_second", "req_third"])

    def test_interrupted_receipt_changes_to_uncertain_without_new_paid_submission(self):
        run = self.submit()
        saved = self.service()._read(run["id"])
        saved["jobs"]["concepts"]["requests"][1] = {"state": "submitting"}
        self.service()._save(saved)
        result = self.service().refresh(run["id"])
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(self.fal.submit.call_count, 3)
        self.fal.status.assert_not_called()

    def test_permanent_result_failure_releases_the_queue_and_preserves_completed_images(self):
        run = self.submit()
        self.fal.result.side_effect = [self.fal.result.return_value, AtlasError("Rejected result", status=422)]
        failed = self.service().refresh(run["id"])
        self.assertEqual(failed["state"], "failed")
        self.assertNotIn("retryAt", failed)
        self.assertNotIn("canRetry", failed)
        requests = self.service()._read(run["id"])["jobs"]["concepts"]["requests"]
        self.assertEqual(requests[0]["state"], "succeeded")
        self.assertTrue((self.service()._path(run["id"]).parent / requests[0]["file"]).is_file())
        self.assertEqual(requests[1]["requestId"], "req_1")
        self.assertEqual(requests[1]["state"], "failed")
        self.assertEqual(self.fal.submit.call_count, 3)
        self.assertNotEqual(self.submit(variationKey="intentional-reroll")["id"], run["id"])

    def test_transient_poll_failure_keeps_receipts_without_a_paid_retry(self):
        run = self.submit()
        self.fal.status.side_effect = AtlasError("Temporarily unavailable", status=503)
        pending = self.service().refresh(run["id"])
        self.assertEqual(pending["state"], "pending")
        self.assertIn("retryAt", pending)
        self.assertEqual(self.fal.submit.call_count, 3)
        self.assertEqual(self.service()._read(run["id"])["jobs"]["concepts"]["requests"][0]["requestId"], "req_0")

    def test_sharing_preference_changes_without_a_provider_request(self):
        run = self.submit(communityOptIn=True)
        jobs = self.service()._read(run["id"])["jobs"]
        self.fal.reset_mock()
        self.atlas.reset_mock()
        changed = self.service().set_sharing(run["id"], {"communityOptIn": False})
        self.assertEqual(changed["id"], run["id"])
        self.assertFalse(changed["communityOptIn"])
        self.assertEqual(self.service()._read(changed["id"])["jobs"], jobs)
        for value in (None, "false", 0):
            with self.assertRaises(ValueError):
                self.service().set_sharing(run["id"], {"communityOptIn": value})
        self.fal.submit.assert_not_called()
        self.atlas.submit_task.assert_not_called()

    def test_concept_revisions_and_intentional_variations_preserve_the_user_brief(self):
        parent = self.submit(prompt="A warm designer desk")
        parent = self.service().refresh(parent["id"])
        original = self.service()._path(parent["id"]).read_bytes()
        revised = self.service().revise(parent["id"], {"instruction": "Use walnut and a softer lamp"})
        self.assertEqual(revised["stage"], "concepts")
        self.assertEqual(self.fal.submit.call_count, 6)
        for call in self.fal.submit.call_args_list[-3:]:
            self.assertEqual(len(call.args[0]["image_urls"]), 3)
            self.assertIn("warm designer desk", call.args[0]["prompt"])
            self.assertIn("walnut", call.args[0]["prompt"])
        self.assertEqual(self.service()._path(parent["id"]).read_bytes(), original)
        self.service().refresh(revised["id"])
        variation = self.submit(prompt="A warm designer desk", variationKey="another-set-uuid")
        self.assertNotEqual(variation["id"], parent["id"])
        self.assertEqual(self.fal.submit.call_count, 9)

    def test_uncertain_concepts_block_a_fresh_variation_and_invalid_selection(self):
        self.fal.submit.side_effect = AtlasError("Response lost")
        run = self.submit(prompt="A warm designer desk")
        with self.assertRaisesRegex(ValueError, "unique identifier"):
            self.submit(prompt="A warm designer desk", variationKey="../x")
        with self.assertRaisesRegex(ValueError, "active image"):
            self.submit(prompt="A warm designer desk", variationKey="new-variation-uuid")
        for index in (-1, 3, True, "0"):
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, "three concept"):
                self.service().select_concept(run["id"], {"conceptIndex": index})
        self.assertEqual(self.fal.submit.call_count, 1)

    def test_legacy_four_reference_run_still_refreshes_without_new_submissions(self):
        from film.atlas_worlds import _guide
        _, guide = _guide(GUIDE_ID)
        run = self.service()._new_fal_run(GUIDE_ID, guide, "Legacy four-angle room", image_stage="references", community_opt_in=False)
        saved = self.service()._read(run["id"])
        saved.pop("imageStage")
        self.service()._save(saved)
        reopened = self.service().refresh(run["id"])
        self.assertEqual(reopened["state"], "succeeded")
        self.assertEqual(len(reopened["views"]), 4)
        self.assertEqual(self.fal.submit.call_count, 4)

    def test_missing_key_and_invalid_provider_start_no_jobs(self):
        with patch.dict(os.environ, {"FAL_KEY": "", "FAL_KEY_FILE": str(self.root / "missing")}):
            with self.assertRaisesRegex(AtlasError, "private fal key"):
                self.submit()
        with self.assertRaisesRegex(ValueError, "Unknown reference image provider"):
            self.service().submit({"guideId": GUIDE_ID, "imageProvider": "untrusted/model"})
        self.fal.submit.assert_not_called()
        self.assertEqual(self.service().list(), {"runs": []})

    def test_reusing_a_run_updates_consent_and_withdraws_pending_review_without_regenerating(self):
        run = self.submit(communityOptIn=True)
        saved = self.service()._read(run["id"])
        saved["jobs"]["draft"] = {"state": "succeeded", "world": {"id": "world-one", "communitySubmission": {"id": "listing-one", "state": "pending_review"}}}
        self.service()._save(saved)
        with patch("film.marketplace.Marketplace") as marketplace:
            marketplace.return_value.submission.return_value = {"id": "listing-one", "state": "pending_review"}
            marketplace.return_value.withdraw.return_value = {"id": "listing-one", "state": "withdrawn"}
            opted_out = self.submit(communityOptIn=False)
            marketplace.return_value.withdraw.assert_called_once_with("listing-one")
        self.assertFalse(opted_out["communityOptIn"])
        self.assertEqual(opted_out["communitySubmission"]["state"], "withdrawn")
        self.assertEqual(self.fal.submit.call_count, 3)

    def test_missing_review_record_cannot_restart_paid_generation_on_opt_out(self):
        run = self.submit(communityOptIn=True)
        saved = self.service()._read(run["id"])
        saved["jobs"]["draft"] = {"state": "succeeded", "world": {"id": "world-one", "communitySubmission": {"id": "listing-missing", "state": "pending_review"}}}
        self.service()._save(saved)
        with self.assertRaises(FileNotFoundError):
            self.submit(communityOptIn=False)
        self.assertEqual(self.fal.submit.call_count, 3)
