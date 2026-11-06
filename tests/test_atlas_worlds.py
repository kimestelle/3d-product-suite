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
