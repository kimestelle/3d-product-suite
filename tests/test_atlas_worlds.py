"""Atlas world jobs preserve reviewed frames and keep paid stages explicit."""

import gzip
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from film.atlas_client import AtlasError
from film.atlas_worlds import AtlasWorlds, GUIDE_ID
from film.store import ConflictError
from film.worlds import list_worlds


def pending(operation_id):
    return {"id": operation_id, "done": False}


def completed(operation_id, response):
    return {"id": operation_id, "done": True, "response": response}


def spz(flag):
    return struct.pack("<III4B", 0x5053474E, 2, 1, 0, 12, flag, 0) + bytes(range(19))


def asset(asset_id, destination, *, kind, **_):
    if kind == "splat":
        Path(destination).write_bytes(gzip.compress(spz(0x40), mtime=0))
        return ".spz"
    Image.new("RGB", (4, 4), (21, 22, 23)).save(destination, format="PNG")
    return ".png"


class AtlasWorldsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        env = patch.dict(os.environ, {"WLT_API_KEY": "local-test-key", "WLT_API_KEY_FILE": ""})
        env.start()
        self.addCleanup(env.stop)
        self.client = Mock()
        self.client.read_asset.side_effect = asset
        self.client.submit_task.return_value = pending("op_views")
        self.service = self.open()

    def open(self):
        return AtlasWorlds(self.root, client_factory=lambda _: self.client)

    def submit(self, **overrides):
        return self.service.submit({"guideId": GUIDE_ID, **overrides})

    def finish_views(self):
        run = self.submit(prompt="Keep the water channel visible.")
        task, request, key = self.client.submit_task.call_args.args
        self.assertEqual(task, "atlasChisel")
        self.assertTrue(key.endswith("-views"))
        self.assertEqual([f["camera"] for f in request["contextFrames"]], request["targetCameras"])
        self.assertTrue(all(set(frame) == {"camera", "depth"} for frame in request["contextFrames"]))
        self.assertGreater(len(request["sourceFrames"]), 0)
        self.assertTrue(request["returnDepth"])
        self.assertIn("Keep the water channel visible.", request["prompt"])
        frames = [{
            "camera": camera,
            "imageAsset": {"assetId": f"asset_image_{i}", "url": "https://example.com/signed-image"},
            "depth": {"depthAsset": {"assetId": f"asset_depth_{i}", "url": "https://example.com/signed-depth"}},
        } for i, camera in enumerate(request["targetCameras"])]
        self.client.operation.return_value = completed("op_views", {"frames": frames})
        return self.open().refresh(run["id"])

    def finish_draft(self, run_id):
        self.client.submit_task.return_value = pending("op_draft")
        self.service.reconstruct(run_id, "draft")
        self.client.operation.return_value = completed("op_draft", {"draftSplat": {"assetId": "asset_draft"}})
        return self.open().refresh(run_id)

    def test_reopens_views_and_starts_draft_then_refine_only_when_requested(self):
        run = self.finish_views()
        self.assertEqual(run["state"], "succeeded")
        self.assertEqual(self.open().list(), {"runs": [run]})
        self.assertEqual(self.submit(prompt="Keep the water channel visible."), run)
        self.client.submit_task.assert_called_once()
        self.assertNotIn("signed-", json.dumps(run))
        first_view = self.service.view(run["id"], "0")
        self.assertEqual(self.open().view(run["id"], "0"), first_view)
        self.client.read_asset.assert_called_once()
        with self.assertRaises(ConflictError):
            self.service.reconstruct(run["id"], "refine")
        draft = self.finish_draft(run["id"])
        task, body, _ = self.client.submit_task.call_args.args
        self.assertEqual(task, "posedImages2Splats")
        self.assertIs(body["refine"], False)
        self.assertEqual(len(body["posedFrames"]), len(run["views"]))
        self.assertNotIn("https://", json.dumps(body))
        self.assertEqual(draft["stage"], "draft")
        self.assertEqual(draft["state"], "succeeded")
        self.assertEqual(draft["draftWorld"]["providerWorldId"], "op_views")
        self.client.submit_task.return_value = pending("op_refine")
        self.service.reconstruct(run["id"], "refine")
        self.assertNotIn("refine", self.client.submit_task.call_args.args[1])
        self.client.operation.return_value = completed("op_refine", {"refinedSplats": {
            "9": {"assetId": "asset_small"}, "100": {"assetId": "asset_large"}}})
        refined = self.open().refresh(run["id"])
        self.assertEqual(refined["state"], "succeeded")
        self.assertEqual(refined["draftWorld"], draft["draftWorld"])
        self.assertEqual(refined["refinedWorld"]["providerWorldId"], "op_views")
        self.assertEqual(self.client.read_asset.call_args.args[0], "asset_large")
        self.assertEqual(self.service.reconstruct(run["id"], "refine"), refined)
        self.assertEqual(self.client.submit_task.call_count, 3)

        worlds = {world["id"]: world for world in list_worlds(self.root)}
        self.assertEqual(len(worlds), 2)
        for stage, name in (("draft", "draftWorld"), ("refine", "refinedWorld")):
            original = self.root / "atlas-worlds" / run["id"] / f"{stage}-source.spz"
            self.assertEqual(gzip.decompress(original.read_bytes()), spz(0x40))
            world = worlds[refined[name]["id"]]["environment"]
            source = self.root / world["asset"]["path"]
            self.assertEqual(gzip.decompress(source.read_bytes()), spz(0))
            cleanup = refined[name]["interiorCleanup"]
            self.assertEqual(cleanup["status"], "full-source")
            self.assertFalse(cleanup["canApply"])
            self.assertEqual(cleanup["sourceSha256"], world["asset"]["sha256"])
            receipt = self.root / "atlas-worlds" / run["id"] / f"{stage}-interior-cleanup.json"
            self.assertEqual(json.loads(receipt.read_text()), cleanup)

    def test_ambiguous_submission_does_not_submit_duplicate(self):
        self.client.submit_task.side_effect = AtlasError("Lost response.")
        run = self.submit()
        self.assertEqual(run["state"], "uncertain")
        self.assertEqual(self.open().refresh(run["id"]), run)
        self.assertEqual(self.submit(), run)
        self.client.submit_task.assert_called_once()

    def test_missing_key_starts_no_paid_stage(self):
        with patch.dict(os.environ, {"WLT_API_KEY": ""}):
            with self.assertRaisesRegex(AtlasError, "private Atlas project key"):
                self.submit()
        self.client.submit_task.assert_not_called()
        self.assertEqual(self.service.list(), {"runs": []})

    def test_refinement_failure_preserves_the_draft(self):
        run = self.finish_views()
        draft = self.finish_draft(run["id"])
        self.client.submit_task.return_value = pending("op_refine")
        self.service.reconstruct(run["id"], "refine")
        self.client.operation.return_value = {"id": "op_refine", "done": True, "error": {"message": "private details"}}
        failed = self.open().refresh(run["id"])
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["draftWorld"], draft["draftWorld"])
        self.assertNotIn("private details", json.dumps(failed))

    def test_cleanup_receipt_failure_does_not_discard_an_imported_world(self):
        from film.worldlabs import _atomic_json

        parent = self.finish_views()

        def write(path, value):
            if str(path).endswith("-interior-cleanup.json"):
                raise OSError("Fixture full disk")
            return _atomic_json(path, value)

        with patch("film.atlas_worlds._atomic_json", side_effect=write):
            draft = self.finish_draft(parent["id"])
        self.assertEqual(draft["state"], "succeeded")
        self.assertEqual(draft["draftWorld"]["interiorCleanup"]["status"], "full-source")
        self.assertIn("could not be saved", draft["draftWorld"]["interiorCleanup"]["reason"])
        self.assertEqual(len(list_worlds(self.root)), 1)

    def test_new_opted_in_world_enters_private_review_without_publication(self):
        from film.marketplace import Marketplace

        parent = self.finish_views()
        self.assertTrue(self.service._read(parent["id"])["communityOptIn"])
        draft = self.finish_draft(parent["id"])
        submission = draft["draftWorld"]["communitySubmission"]
        self.assertEqual(submission["state"], "changes_needed")
        self.assertFalse(submission["audit"]["passed"])
        self.assertEqual(len(Marketplace(self.root).submissions()["submissions"]), 1)
        self.assertEqual(Marketplace(self.root).list()["listings"], [])

    def test_legacy_import_without_consent_does_not_submit_to_community(self):
        from film.marketplace import Marketplace

        parent = self.finish_views()
        legacy = self.service._read(parent["id"])
        legacy.pop("communityOptIn")
        self.service._save(legacy)
        draft = self.finish_draft(parent["id"])
        self.assertNotIn("communitySubmission", draft["draftWorld"])
        self.assertEqual(Marketplace(self.root).submissions()["submissions"], [])

    def test_reference_revision_preserves_parent_and_uses_its_posed_images(self):
        parent = self.finish_views()
        draft = self.finish_draft(parent["id"])
        parent_path = self.service._path(parent["id"])
        parent_bytes = parent_path.read_bytes()
        original_frames = self.service._read(parent["id"])["frames"]
        self.client.submit_task.return_value = pending("op_revision")
        revised = self.service.revise(parent["id"], {"instruction": "  Make the glass warmer.  "})
        self.assertEqual(revised["revision"], 2)
        self.assertEqual(revised["parentId"], parent["id"])
        self.assertEqual(revised["instruction"], "Make the glass warmer.")
        self.assertEqual(revised["stage"], "views")
        self.assertNotIn("draftWorld", revised)
        self.assertEqual(parent_path.read_bytes(), parent_bytes)
        task, request, key = self.client.submit_task.call_args.args
        self.assertEqual(task, "atlasChisel")
        self.assertEqual(request["sourceFrames"], [{"camera": frame["camera"], "imageAsset": frame["imageAsset"]}
                                                   for frame in original_frames])
        self.assertEqual(request["targetCameras"], [frame["camera"] for frame in original_frames])
        self.assertTrue(all(set(frame) == {"camera", "depth"} for frame in request["contextFrames"]))
        self.assertIn("Keep the water channel visible.", request["prompt"])
        self.assertIn("Make the glass warmer.", request["prompt"])
        self.assertIn("Preserve the existing appearance", request["prompt"])
        self.assertIn(revised["id"], key)
        submitted = self.client.submit_task.call_count
        self.assertEqual(self.open().revise(parent["id"], {"instruction": "Make the glass warmer."}), revised)
        self.assertEqual(self.client.submit_task.call_count, submitted)

        frames = [{**frame, "imageAsset": {"assetId": f"asset_revised_{index}"}}
                  for index, frame in enumerate(original_frames)]
        self.client.operation.return_value = completed("op_revision", {"frames": frames})
        result = self.open().refresh(revised["id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertNotEqual(result["views"][0]["url"], parent["views"][0]["url"])
        self.assertEqual(parent_path.read_bytes(), parent_bytes)
        self.assertEqual(self.open()._public(self.service._read(parent["id"])), draft)
        self.client.submit_task.return_value = pending("op_revision_2")
        second = self.open().revise(result["id"], {"instruction": "Keep the warmer glass and soften the light."})
        self.assertEqual(second["revision"], 3)
        self.assertEqual(second["parentId"], result["id"])
        self.assertIn("Make the glass warmer.", self.client.submit_task.call_args.args[1]["prompt"])

    def test_reference_edits_validate_input_and_wait_for_completed_views(self):
        pending_run = self.submit()
        for body in (None, [], {}, {"instruction": " "}, {"instruction": 5}, {"instruction": "x" * 1001}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.service.revise(pending_run["id"], body)
        with self.assertRaisesRegex(ConflictError, "Complete.*reference views"):
            self.service.revise(pending_run["id"], {"instruction": "Warmer glass."})
        self.client.submit_task.assert_called_once()

    def test_legacy_reference_revision_and_ambiguous_submission_are_recoverable(self):
        parent = self.finish_views()
        original = self.service._read(parent["id"])
        original.pop("revision")
        self.service._save(original)
        self.assertEqual(self.open().list()["runs"][0]["revision"], 1)
        self.client.submit_task.side_effect = AtlasError("Lost response.")
        child = self.service.revise(parent["id"], {"instruction": "Use limestone."})
        self.assertEqual(child["revision"], 2)
        self.assertEqual(child["state"], "uncertain")
        self.assertEqual(self.open().revise(parent["id"], {"instruction": "Use limestone."}), child)
        self.assertEqual(self.open().refresh(child["id"]), child)
        self.assertEqual(self.client.submit_task.call_count, 2)
        self.assertEqual(self.service._read(parent["id"]), original)

    def test_reference_revision_keeps_the_record_limit_and_layout(self):
        parent = self.finish_views()
        with patch("film.atlas_worlds.MAX_RUNS", 1):
            with self.assertRaisesRegex(ValueError, "record limit"):
                self.service.revise(parent["id"], {"instruction": "Warmer glass."})
        original = self.service._read(parent["id"])
        original["frames"][0]["camera"]["extrinsics"]["position"][0] += .1
        self.service._save(original)
        with self.assertRaisesRegex(ConflictError, "no longer match"):
            self.service.revise(parent["id"], {"instruction": "Warmer glass."})
        self.client.submit_task.assert_called_once()
