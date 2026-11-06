"""Exercise Marble 2's request and download boundaries with fake transports."""

from email.message import Message
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request
from urllib.response import addinfourl

from PIL import Image

from film import atlas_client


class FakeOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, *, timeout):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        payload = json.dumps(response).encode() if isinstance(response, dict) else response
        return io.BytesIO(payload)


class FakeDownload(io.BytesIO):
    def __init__(self, payload, *, status=200, length=None):
        super().__init__(payload)
        self.status = status
        self.length = length

    def getheader(self, name):
        return self.length if name == "Content-Length" else None


def address(value):
    family = socket.AF_INET6 if ":" in value else socket.AF_INET
    return (family, socket.SOCK_STREAM, 6, "", (value, 443))


def png():
    output = io.BytesIO()
    Image.new("RGB", (2, 1), "white").save(output, format="PNG")
    return output.getvalue()


def depth_exr(width=2):
    def attribute(name, kind, data):
        return name + b"\0" + kind + b"\0" + struct.pack("<I", len(data)) + data

    header = struct.pack("<II", 20000630, 2)
    channels = b"Z\0" + struct.pack("<iB3xii", 2, 0, 1, 1) + b"\0"
    window = struct.pack("<4i", 0, 0, width - 1, 0)
    header += attribute(b"channels", b"chlist", channels)
    header += attribute(b"compression", b"compression", b"\0")
    header += attribute(b"dataWindow", b"box2i", window)
    header += attribute(b"displayWindow", b"box2i", window)
    header += attribute(b"lineOrder", b"lineOrder", b"\0")
    header += attribute(b"pixelAspectRatio", b"float", struct.pack("<f", 1))
    header += attribute(b"screenWindowCenter", b"v2f", struct.pack("<2f", 0, 0))
    header += attribute(b"screenWindowWidth", b"float", struct.pack("<f", 1)) + b"\0"
    return header + struct.pack("<Qii2f", len(header) + 8, 0, 8, 1, 2)


class AtlasClientTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.destination = Path(temporary.name) / "output"
        self.key = "fixture-project-key"
        environment = patch.dict(os.environ, {"WLT_API_BASE_URL": atlas_client.API_ROOT})
        environment.start()
        self.addCleanup(environment.stop)

    def client(self, *responses):
        self.opener = FakeOpener(*responses)
        return atlas_client.AtlasClient(self.key, opener=self.opener)

    def download(self, payload, *, kind="image", status=200, length=None):
        connection = Mock()
        connection.getresponse.return_value = FakeDownload(payload, status=status, length=length)
        client = self.client({"readUrl": "https://assets.example.com/media.png?sig=one%2Btwo&sig=a"})
        with (patch.object(atlas_client.socket, "getaddrinfo", return_value=[address("8.8.8.8")]),
              patch.object(atlas_client, "_AssetConnection", return_value=connection) as connection_type):
            suffix = client.read_asset("asset_example", self.destination, kind=kind)
        self.assertEqual(connection_type.call_args.args[:2], ("assets.example.com", ["8.8.8.8"]))
        connection.request.assert_called_once_with(
            "GET", "/media.png?sig=one%2Btwo&sig=a", headers={"Accept": "application/octet-stream"}
        )
        connection.close.assert_called_once()
        grant_request, = self.opener.requests
        self.assertEqual(grant_request.full_url, atlas_client.API_ROOT + "/assets/asset_example:createReadUrl")
        self.assertEqual(grant_request.get_method(), "POST")
        self.assertIsNone(grant_request.data)
        self.assertEqual(grant_request.get_header("Wlt-api-key"), self.key)
        self.assertNotIn(self.key, repr(client))
        return suffix

    def test_quickstart_submission_and_operation_read(self):
        body = {"frames": [{"imageAsset": {"url": "https://images.example.com/input.jpg"}}],
                "targetResolution": [1280, 720]}
        client = self.client({"id": "op_example", "done": False}, {"id": "op_example", "done": True})
        self.assertEqual(client.submit(body, "quickstart-123")["id"], "op_example")
        self.assertTrue(client.operation("op_example")["done"])
        submission, status = self.opener.requests
        self.assertEqual(submission.full_url, atlas_client.API_ROOT + "/tasks:images2PosedRGBD")
        self.assertEqual(submission.get_method(), "POST")
        self.assertEqual(submission.get_header("Wlt-api-key"), self.key)
        self.assertEqual(submission.get_header("Idempotency-key"), "quickstart-123")
        self.assertEqual(json.loads(submission.data), body)
        self.assertEqual(status.full_url, atlas_client.API_ROOT + "/operations/op_example")
        self.assertEqual(status.get_method(), "GET")
        self.assertIsNone(status.get_header("Idempotency-key"))

    def test_provider_failures_do_not_leak_messages_or_retry_submission(self):
        for response in (
            urllib.error.HTTPError(atlas_client.API_ROOT, 429, self.key, {"Retry-After": "8"},
                                   io.BytesIO(self.key.encode())),
            TimeoutError(self.key),
        ):
            with self.subTest(response=type(response).__name__):
                client = self.client(response)
                with self.assertRaises(atlas_client.AtlasError) as error:
                    client.submit({}, "quickstart-123")
                self.assertEqual(len(self.opener.requests), 1)
                self.assertNotIn(self.key, str(error.exception))
                self.assertEqual(error.exception.status, 429 if isinstance(response, urllib.error.HTTPError) else None)
                self.assertEqual(error.exception.retry_after, 8 if isinstance(response, urllib.error.HTTPError) else None)

    def test_invalid_api_root_and_resource_id_are_refused(self):
        with patch.dict(os.environ, {"WLT_API_BASE_URL": "https://evil.example/api/v2"}):
            with self.assertRaisesRegex(atlas_client.AtlasError, "official"):
                atlas_client.AtlasClient(self.key)
        client = self.client()
        with self.assertRaises(atlas_client.AtlasError):
            client.operation("../sensitive")
        with self.assertRaises(atlas_client.AtlasError):
            client.read_asset("asset_id?download=1", self.destination, kind="image")
        self.assertEqual(self.opener.requests, [])

    def test_authenticated_api_never_follows_redirects(self):
        class RedirectHandler(urllib.request.HTTPSHandler):
            def https_open(self, request):
                seen.append(request.full_url)
                headers = Message()
                headers["Location"] = "https://evil.example/collect"
                response = addinfourl(io.BytesIO(), headers, request.full_url, 302)
                response.msg = "Found"
                return response

        seen = []
        opener = urllib.request.build_opener(RedirectHandler(), atlas_client._NoRedirect())
        client = atlas_client.AtlasClient(self.key, opener=opener)
        with self.assertRaises(atlas_client.AtlasError) as error:
            client.operation("op_example")
        self.assertEqual(error.exception.status, 302)
        self.assertEqual(seen, [atlas_client.API_ROOT + "/operations/op_example"])

    def test_signed_image_and_depth_grants_are_downloaded_and_validated(self):
        image = png()
        self.assertEqual(self.download(image, length=str(len(image))), ".png")
        self.assertEqual(self.destination.read_bytes(), image)
        depth = depth_exr()
        self.assertEqual(self.download(depth, kind="depth"), ".exr")
        self.assertEqual(self.destination.read_bytes(), depth)

    def test_bad_storage_responses_preserve_the_previous_destination(self):
        self.destination.write_bytes(b"earlier validated file")
        for payload, kwargs in (
            (b"<html>private signed URL</html>", {}),
            (png(), {"status": 302}),
            (png(), {"length": "1000000000"}),
            (png(), {"length": str(len(png()) + 1)}),
            (depth_exr(width=4097), {"kind": "depth"}),
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(atlas_client.AtlasError) as error:
                self.download(payload, **kwargs)
            self.assertNotIn("private signed URL", str(error.exception))
            self.assertEqual(self.destination.read_bytes(), b"earlier validated file")
            self.assertEqual(list(self.destination.parent.glob(".atlas-*")), [])

    def test_streaming_asset_and_json_limits_apply_without_length_headers(self):
        with patch.object(atlas_client, "MAX_ASSET_BYTES", 8):
            with self.assertRaisesRegex(atlas_client.AtlasError, "download size"):
                self.download(png())
        self.assertFalse(self.destination.exists())
        client = self.client(b'{"id":"op_example","done":false}')
        with patch.object(atlas_client, "MAX_JSON_BYTES", 8):
            with self.assertRaisesRegex(atlas_client.AtlasError, "response exceeds"):
                client.operation("op_example")

    def test_non_https_credentials_and_mixed_public_private_dns_do_not_connect(self):
        for url, addresses in (
            ("http://assets.example.com/media.png", ["8.8.8.8"]),
            ("https://user:pass@assets.example.com/media.png", ["8.8.8.8"]),
            ("https://assets.example.com:8787/media.png", ["8.8.8.8"]),
            ("https://assets.example.com/media.png", ["8.8.8.8", "127.0.0.1"]),
            ("https://assets.example.com/media.png", ["64:ff9b::a9fe:a9fe"]),
        ):
            client = self.client({"readUrl": url})
            with (self.subTest(url=url, addresses=addresses),
                  patch.object(atlas_client.socket, "getaddrinfo", return_value=list(map(address, addresses))),
                  patch.object(atlas_client, "_AssetConnection") as connection,
                  self.assertRaises(atlas_client.AtlasError)):
                client.read_asset("asset_example", self.destination, kind="image")
            connection.assert_not_called()

    def test_connection_pins_vetted_ip_and_authenticates_the_asset_hostname(self):
        connection = atlas_client._AssetConnection("assets.example.com", ["8.8.8.8"], timeout=30)
        stream, tls = Mock(), Mock()
        with (patch.object(atlas_client.socket, "create_connection", return_value=stream) as connect,
              patch.object(connection._context, "wrap_socket", return_value=tls) as wrap):
            connection.connect()
        self.assertEqual(connect.call_args.args[0], ("8.8.8.8", 443))
        wrap.assert_called_once_with(stream, server_hostname="assets.example.com")
        self.assertIs(connection.sock, tls)
