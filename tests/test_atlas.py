"""The Atlas quickstart keeps one logical task and resumes its operation."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from film.atlas import AtlasQuickstart, SAMPLE_IMAGE
from film.atlas_client import AtlasError
from film.store import ConflictError


def completed(operation_id="op_test", *, confidence=True):
    depth = {"depthAsset": {"assetId": "asset_depth", "url": "https://example.com/signed-depth"}}
    if confidence:
        depth["confidenceAsset"] = {"assetId": "asset_confidence"}
    return {"id": operation_id, "done": True, "error": None, "response": {"frames": [{
        "imageAsset": {"assetId": "asset_image", "url": "https://example.com/signed-image"},
        "camera": {"extrinsics": {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "coordinateSystem": "rub"},
                   "intrinsics": {"fx": 800, "fy": 800, "cx": 640, "cy": 360, "width": 1280, "height": 720}},
        "depth": depth,
    }]}}


def raster_asset(asset_id, destination, *, kind):
    Image.new("RGB", (4, 4), (21, 22, 23)).save(destination, format="PNG")
    return ".png"


class AtlasQuickstartTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        env = patch.dict(os.environ, {"WLT_API_KEY": "local-test-key", "WLT_API_KEY_FILE": ""})
        env.start()
        self.addCleanup(env.stop)
        self.client = Mock()
        self.client.submit.return_value = {"id": "op_test", "done": False}
        self.service = self.open()

    def open(self):
        return AtlasQuickstart(self.root, client_factory=lambda _: self.client)

    def test_submits_documented_payload_once_and_checks_same_operation_after_reopen(self):
        first = self.service.submit(SAMPLE_IMAGE)
        body, key = self.client.submit.call_args.args
        self.assertEqual(body, {"frames": [{"imageAsset": {"url": SAMPLE_IMAGE}}], "targetResolution": [1280, 720]})
        self.assertTrue(key)
        reopened = self.open()
        self.assertEqual(reopened.submit(SAMPLE_IMAGE), first)
        self.client.submit.assert_called_once()
        self.client.operation.side_effect = [AtlasError("not visible", status=404), completed(confidence=False)]
        checking = reopened.refresh(first["id"])
        self.assertEqual(checking["state"], "pending")
        self.assertEqual(checking["operationId"], "op_test")
        result = reopened.refresh(first["id"])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual([asset["kind"] for asset in result["result"]["assets"]], ["image", "depth"])
        self.assertNotIn("signed-", json.dumps(result))
        self.assertNotIn("idempotencyKey", result)
        self.assertEqual(reopened.refresh(first["id"]), result)
        self.assertEqual(self.client.operation.call_count, 2)

    def test_lost_post_and_crashed_submission_cannot_start_duplicate_work(self):
        self.client.submit.side_effect = AtlasError("Transport ended early.")
        run = self.service.submit(SAMPLE_IMAGE)
        self.assertEqual(run["state"], "uncertain")
        self.assertEqual(self.open().submit(SAMPLE_IMAGE), run)
        self.client.submit.assert_called_once()
        record = self.service._read(run["id"])
        record["state"] = "submitting"
        self.service._save(record)
        self.assertEqual(self.open().refresh(run["id"])["state"], "uncertain")
        self.client.operation.assert_not_called()
        self.client.submit.assert_called_once()

    def test_explicit_rate_limit_replay_keeps_key_and_observes_retry_delay(self):
        self.client.submit.side_effect = [AtlasError("Rate limit", status=429, retry_after=30), completed()]
        limited = self.service.submit(SAMPLE_IMAGE)
        self.assertEqual(limited["state"], "failed")
        self.assertEqual(self.service.submit(SAMPLE_IMAGE), limited)
        self.client.submit.assert_called_once()
        record = self.service._read(limited["id"])
        record["retryAt"] = "2000-01-01T00:00:00+00:00"
        self.service._save(record)
        self.assertEqual(self.service.submit(SAMPLE_IMAGE)["state"], "succeeded")
        self.assertEqual(self.client.submit.call_args_list[0], self.client.submit.call_args_list[1])

    def test_pending_run_blocks_second_input_and_failed_read_keeps_identity(self):
        run = self.service.submit(SAMPLE_IMAGE)
        with self.assertRaises(ConflictError):
            self.service.submit("https://example.com/other.jpg")
        self.client.operation.return_value = completed("op_other")
        state = self.service.refresh(run["id"])
        self.assertEqual(state["state"], "pending")
        self.assertEqual(state["operationId"], "op_test")

    def test_requires_private_key_file_and_reuses_cached_asset_without_key(self):
        key_file = self.root / "secrets" / "atlas-api-key"
        key_file.parent.mkdir()
        key_file.write_text("example-private-key\n")
        with patch.dict(os.environ, {"WLT_API_KEY": ""}):
            key_file.chmod(0o644)
            self.assertEqual(self.service.status(), {"configured": False})
            key_file.chmod(0o600)
            self.assertEqual(self.service.status(), {"configured": True})
            self.client.submit.return_value = completed()
            run = self.service.submit(SAMPLE_IMAGE)
            self.client.read_asset.side_effect = raster_asset
            path = self.service.asset(run["id"], "image")
            key_file.unlink()
            self.assertEqual(self.open().asset(run["id"], "image"), path)
            self.client.read_asset.assert_called_once()
            with self.assertRaises(FileNotFoundError):
                self.service.asset(run["id"], "run.json")
