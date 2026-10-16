"""Provider contracts use fake transports; no test consumes World Labs credits."""
import gzip
import base64
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from film import worldlabs
from tests.test_worlds import glb_bytes


class Response(io.BytesIO):
    def __init__(self, payload, *, url="https://assets.worldlabs.ai/world.spz", headers=None):
        super().__init__(json.dumps(payload).encode() if isinstance(payload, dict) else payload)
        self.url = url
        self.headers = headers or {}

    def geturl(self):
        return self.url


class FakeOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, *, timeout):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return Response(response)


class WorldLabsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "generation"
        self.library = self.root / "library"
        self.key = "test-private-key-never-persist"

    def client(self, *responses, downloads=()):
        self.api = FakeOpener(*responses)
        self.downloads = FakeOpener(*downloads)
        return worldlabs.WorldLabsClient(self.key, opener=self.api, download_opener=self.downloads)

    def assert_no_key_on_disk(self):
        for path in self.root.rglob("*"):
            if path.is_file():
                self.assertNotIn(self.key.encode(), path.read_bytes(), str(path))

    def test_key_stays_server_side_and_repr_is_redacted(self):
        with patch.dict("os.environ", {"WORLDLABS_API_KEY": self.key}):
            client = worldlabs.WorldLabsClient.from_environment(opener=FakeOpener({"ok": True}))
        self.assertNotIn(self.key, repr(client))
        self.assertEqual(client._request("GET", "/credits"), {"ok": True})
        request = client._opener.requests[0]
        self.assertEqual(request.headers["Wlt-api-key"], self.key)
        self.assertNotIn(self.key, request.full_url)

    def test_http_errors_and_transport_errors_do_not_echo_secret_material(self):
        exceptions = [urllib.error.HTTPError("https://api.worldlabs.ai", 401, self.key, {}, None),
                      urllib.error.URLError(self.key), TimeoutError(self.key)]
        for error in exceptions:
            client = self.client(error)
            with self.subTest(error=type(error).__name__), self.assertRaises(worldlabs.WorldLabsError) as caught:
                client._request("GET", "/credits")
            self.assertNotIn(self.key, str(caught.exception))
            self.assertEqual(len(self.api.requests), 1)

    def test_asset_download_never_forwards_provider_auth_and_is_size_bounded(self):
        client = self.client(downloads=(b"asset",))
        target = self.root / "asset.spz"
        record = client._download("https://assets.worldlabs.ai/world.spz", target)
        self.assertEqual(target.read_bytes(), b"asset")
        self.assertEqual(record["bytes"], 5)
        self.assertNotIn("Wlt-api-key", self.downloads.requests[0].headers)
        client = self.client(downloads=(b"too big",))
        with patch.object(worldlabs.worlds, "MAX_ASSET_BYTES", 4), self.assertRaisesRegex(ValueError, "size limit"):
            client._download("https://assets.worldlabs.ai/world.spz", target)
        self.assertFalse(target.exists())

    def test_asset_urls_reject_insecure_private_and_credential_destinations(self):
        urls = ["http://assets.worldlabs.ai/world.spz", "https://user:pass@assets.worldlabs.ai/world.spz",
                "https://127.0.0.1/world.spz", "https://169.254.169.254/world.spz", "https://localhost/world.spz",
                "https://[::1]/world.spz", "https://assets.worldlabs.ai:8787/world.spz", "file:///etc/passwd"]
        client = self.client()
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                client._download(url, self.root / "asset.spz")
        self.assertEqual(self.downloads.requests, [])

    def test_invalid_key_is_rejected_before_network_use(self):
        for key in ("", "   ", "bad\rkey", "bad\nkey", None):
            with self.subTest(key=key), self.assertRaises(ValueError):
                worldlabs.WorldLabsClient(key)

    def test_concurrent_submission_lock_is_exclusive_and_released(self):
        with worldlabs._state_lock(self.state):
            with self.assertRaisesRegex(ValueError, "busy"):
                with worldlabs._state_lock(self.state):
                    self.fail("Second state lock succeeded")
        with worldlabs._state_lock(self.state):
            pass

    def test_submit_persists_operation_once_and_refuses_duplicate_charge(self):
        client = self.client({"operation_id": "operation-1", "done": False})
        state = client._submit(self.state, request={"display_name": "Atelier"}, max_credits=100,
                               expected_credits=50)
        self.assertEqual(state["operationId"], "operation-1")
        self.assertEqual(worldlabs.load_generation(self.state)["state"], "pending")
        with self.assertRaisesRegex(ValueError, "already exists"):
            client._submit(self.state, request={}, max_credits=100, expected_credits=50)
        self.assertEqual(len(self.api.requests), 1)
        self.assert_no_key_on_disk()

    def test_submit_uncertainty_blocks_retry_and_can_attach_existing_operation(self):
        client = self.client(TimeoutError(self.key), {"operation_id": "accepted-1", "done": False})
        with self.assertRaisesRegex(ValueError, "uncertain"):
            client._submit(self.state, request={}, max_credits=100, expected_credits=50)
        state = worldlabs.load_generation(self.state)
        self.assertEqual(state["state"], "submission_uncertain")
        with self.assertRaisesRegex(ValueError, "already exists"):
            client._submit(self.state, request={}, max_credits=100, expected_credits=50)
        state = client.attach_operation(self.state, "accepted-1")
        self.assertEqual(state["state"], "pending")
        self.assertEqual([request.method for request in self.api.requests], ["POST", "GET"])
        self.assert_no_key_on_disk()

    def test_credit_cap_prevents_submission_before_network_or_state_creation(self):
        client = self.client()
        for cap, expected in ((40, 50), (0, 50), (100, 0), (True, 1), (100, float("nan"))):
            with self.subTest(cap=cap, expected=expected), self.assertRaises(ValueError):
                client._submit(self.state, request={}, max_credits=cap, expected_credits=expected)
        self.assertEqual(self.api.requests, [])
        self.assertFalse((self.state / "generation.json").exists())

    def test_invalid_operation_and_world_ids_never_reach_network(self):
        client = self.client()
        for value in ("../escape", "a/b", "https://example.com", "", "bad?query", None):
            for method in (client.get_world, client.get_operation):
                with self.subTest(value=value, method=method.__name__), self.assertRaises(ValueError):
                    method(value)
        self.assertEqual(self.api.requests, [])

    def world_metadata(self, **changes):
        result = {"world_id": "same-world-1", "display_name": "Atelier", "model": "marble-1.1",
                  "world_marble_url": "https://marble.worldlabs.ai/world/same-world-1",
                  "assets": {"mesh": {"hq_mesh_url": "https://assets.worldlabs.ai/hq.glb",
                                      "collider_mesh_url": "https://assets.worldlabs.ai/collider.glb"},
                             "splats": {"spz_urls": {"500k": "https://assets.worldlabs.ai/world.spz"},
                                        "semantics_metadata": {"metric_scale_factor": 2.5, "ground_plane_offset": 0.4}}}}
        result.update(changes)
        return result

    def spz_bytes(self):
        return gzip.compress(struct.pack("<III4B", 0x5053474E, 2, 1, 0, 12, 0, 0) + b"\0" * 19)

    def test_current_model_estimates_cover_text_pano_and_visual_export(self):
        self.assertEqual(worldlabs.estimate_pair()["totalMaxCredits"], 5080)
        self.assertEqual(worldlabs.estimate_pair()["totalMaxUsd"], 4.064)
        self.assertEqual(worldlabs.estimate_pair("marble-1.0-draft")["totalMaxCredits"], 3730)
        self.assertEqual(worldlabs.estimate_pair("marble-1.1-plus")["totalMaxCredits"], 6580)
        with self.assertRaises(ValueError):
            worldlabs.estimate_pair("Marble 0.1-plus")

    def test_private_generation_uses_verified_request_and_explicit_model(self):
        client = self.client({"remaining_credits": 10000}, {"operation_id": "generation-1", "done": False})
        state = client.create_generation(self.state, name="Atelier", text_prompt="A quiet product studio", max_credits=1580)
        payload = json.loads(self.api.requests[1].data)
        self.assertEqual(payload["model"], "marble-1.1")
        self.assertEqual(payload["world_prompt"], {"type": "text", "text_prompt": "A quiet product studio"})
        self.assertFalse(payload["permission"]["public"])
        self.assertEqual(self.api.requests[1].full_url, worldlabs.API_ROOT + "/worlds:generate")
        self.assertEqual(state["expectedCredits"], 1580)
        self.assert_no_key_on_disk()

    def test_insufficient_balance_and_plus_budget_never_submit(self):
        client = self.client({"remaining_credits": 1579})
        with self.assertRaisesRegex(ValueError, "balance"):
            client.create_generation(self.state, name="Atelier", text_prompt="Studio", max_credits=1580)
        self.assertEqual([request.method for request in self.api.requests], ["GET"])
        client = self.client()
        with self.assertRaisesRegex(ValueError, "cap"):
            client.create_generation(self.state, name="Atelier", text_prompt="Studio", model="marble-1.1-plus", max_credits=1580)
        self.assertEqual(self.api.requests, [])

    def test_poll_generation_saves_world_and_settled_cost_without_posting(self):
        client = self.client({"operation_id": "generation-1", "done": False},
                             {"operation_id": "generation-1", "done": False},
                             {"operation_id": "generation-1", "done": True,
                              "response": self.world_metadata(), "cost": {"total_credits": 1580}})
        client._submit(self.state, request={}, max_credits=1580, expected_credits=1580)
        self.assertEqual(client.poll_generation(self.state)["state"], "pending")
        state = client.poll_generation(self.state)
        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["worldId"], "same-world-1")
        self.assertEqual(state["settledCredits"], 1580)
        self.assertEqual([r.method for r in self.api.requests], ["POST", "GET", "GET"])

    def test_hq_mesh_export_uses_visual_glb_contract_and_polls_result(self):
        client = self.client({"remaining_credits": 4000}, {"operation_id": "mesh-1", "done": False},
                             {"operation_id": "mesh-1", "done": True, "cost": {"total_credits": 3500},
                              "response": {"asset_type": "mesh", "format": "glb", "mesh_variant": "textured",
                                           "url": "https://assets.worldlabs.ai/hq.glb"}})
        state = client.create_mesh_export(self.state, "same-world-1", max_credits=3500)
        self.assertEqual(state["operationType"], "mesh-export")
        self.assertEqual(self.api.requests[1].full_url, worldlabs.API_ROOT + "/worlds/same-world-1:export")
        self.assertEqual(json.loads(self.api.requests[1].data), {"asset_type": "mesh", "format": "glb", "mesh_variant": "textured"})
        self.assertEqual(client.poll_generation(self.state)["state"], "completed")

    def test_pair_import_pins_same_world_and_correct_splat_metric_alignment(self):
        client = self.client(self.world_metadata(), downloads=(glb_bytes(), self.spz_bytes()))
        pair = client.import_world_pair("same-world-1", self.library, name="Atelier", owner="User", reuse_basis="Account-owned generation")
        mesh, splat = pair["mesh"]["environment"], pair["splat"]["environment"]
        self.assertEqual(mesh["provenance"]["providerWorldId"], splat["provenance"]["providerWorldId"])
        self.assertEqual(mesh["asset"]["scaleToMeters"], 1)
        self.assertEqual(mesh["asset"]["translationM"], [0, 0, 0])
        self.assertEqual(splat["asset"]["scaleToMeters"], 2.5)
        self.assertEqual(splat["asset"]["translationM"], [0, 0.4, 0])
        self.assertEqual(splat["asset"]["rotationXyzw"], [1, 0, 0, 0])
        self.assertEqual(len(worldlabs.worlds.list_worlds(self.library)), 2)
        self.assertTrue(all(r.method == "GET" for r in self.api.requests))
        self.assert_no_key_on_disk()

    def test_pair_import_never_substitutes_collider_or_silently_assumes_metric_scale(self):
        world = self.world_metadata()
        del world["assets"]["mesh"]["hq_mesh_url"]
        client = self.client(world)
        with self.assertRaisesRegex(ValueError, "collider"):
            client.import_world_pair("same-world-1", self.library, name="Atelier", owner="User", reuse_basis="Generated")
        self.assertEqual(self.downloads.requests, [])
        world = self.world_metadata()
        del world["assets"]["splats"]["semantics_metadata"]
        client = self.client(world)
        with self.assertRaisesRegex(ValueError, "metric scale"):
            client.import_world_pair("same-world-1", self.library, name="Atelier", owner="User", reuse_basis="Generated")
        self.assertEqual(self.downloads.requests, [])

    def test_invalid_pair_bytes_write_no_library_entries(self):
        client = self.client(self.world_metadata(), downloads=(glb_bytes(), b"bad-spz"))
        with self.assertRaisesRegex(ValueError, "SPZ"):
            client.import_world_pair("same-world-1", self.library, name="Atelier", owner="User", reuse_basis="Generated")
        self.assertFalse((self.library / "worlds").exists())

    def test_recovery_from_operation_id_on_fresh_runner_never_posts(self):
        client = self.client({"operation_id": "existing-1", "done": False})
        state = client.attach_operation(self.state, "existing-1", operation_type="generation", max_credits=1580)
        self.assertTrue(state["recoveredExistingOperation"])
        self.assertEqual([r.method for r in self.api.requests], ["GET"])

    def test_image_url_generation_pins_non_pano_input_and_same_cost(self):
        client = self.client({"remaining_credits": 10000}, {"operation_id": "image-1", "done": False})
        state = client.create_generation(self.state, name="Image studio", text_prompt="Empty foreground",
                                         image_url="https://images.example.com/studio.png", max_credits=1580)
        payload = json.loads(self.api.requests[1].data)
        self.assertEqual(payload["world_prompt"]["type"], "image")
        self.assertFalse(payload["world_prompt"]["is_pano"])
        self.assertEqual(payload["world_prompt"]["image_prompt"], {"source": "uri", "uri": "https://images.example.com/studio.png"})
        self.assertEqual(state["expectedCredits"], 1580)

    def test_local_private_image_is_uploaded_inline_but_never_persisted(self):
        image = self.root / "private.png"
        payload = b"\x89PNG\r\n\x1a\n" + b"private-image-content"
        image.write_bytes(payload)
        encoded = base64.b64encode(payload).decode()
        client = self.client({"remaining_credits": 10000},
                             {"operation_id": "image-1", "done": False, "metadata": {"input": {"data_base64": encoded}}})
        state = client.create_generation(self.state, name="Image studio", text_prompt="Empty foreground",
                                         image_path=image, max_credits=1580)
        sent = json.loads(self.api.requests[1].data)["world_prompt"]["image_prompt"]
        self.assertEqual(sent, {"source": "data_base64", "data_base64": encoded, "extension": "png"})
        saved = (self.state / "generation.json").read_text()
        self.assertNotIn(encoded, saved)
        self.assertNotIn("private-image-content", saved)
        self.assertTrue(state["request"]["world_prompt"]["image_prompt"]["data_base64"]["omitted"])

    def test_invalid_image_reference_is_rejected_before_network(self):
        client = self.client()
        image = self.root / "not-an-image.txt"
        image.write_text("Do not upload arbitrary local files")
        for kwargs in ({"image_url": "http://localhost/private.png"}, {"image_path": image},
                       {"image_url": "https://images.example.com/x.png", "image_path": image}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                client.create_generation(self.state, name="Image studio", text_prompt="Empty foreground", max_credits=1580, **kwargs)
        self.assertEqual(self.api.requests, [])

    def test_api_response_accepts_supported_inline_image_echo_but_remains_bounded(self):
        encoded = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"p" * (6 * 1024 * 1024 - 8)).decode()
        client = self.client({"world_id": "image-world", "world_prompt": {"image_prompt": {"data_base64": encoded}}})
        response = client.get_world("image-world")
        self.assertEqual(response["world_prompt"]["image_prompt"]["data_base64"], encoded)
        oversized = json.dumps({"payload": "p" * worldlabs.MAX_API_RESPONSE_BYTES}).encode()
        client = self.client(oversized)
        with self.assertRaisesRegex(ValueError, "too large"):
            client.get_world("image-world")


if __name__ == "__main__":
    unittest.main()
