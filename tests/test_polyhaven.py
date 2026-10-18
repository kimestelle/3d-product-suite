"""Poly Haven imports preserve real assets while bounding every remote input."""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import time
import unittest

from film.materials import MaterialLibrary
from film.polyhaven import (PolyHavenClient, PolyHavenError, PolyHavenLibrary,
                            _relative_uri, _safe_url, pack_gltf, validate_hdri)
from film.products import inspect_product_glb
from tests.test_materials import png
from tests.test_products import product_glb


def file_record(payload, name):
    return {"url": "https://dl.polyhaven.org/file/ph-assets/" + name,
            "size": len(payload), "md5": hashlib.md5(payload, usedforsecurity=False).hexdigest()}


def hdr(width=8, height=2):
    header = f"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n".encode()
    row = b"\x02\x02" + width.to_bytes(2, "big")
    row += b"".join(bytes([128+width, value]) for value in (128, 128, 128, 128))
    return header + row * height


def gltf_fixture():
    packed = product_glb()
    size = struct.unpack_from("<I", packed, 12)[0]
    document = json.loads(packed[20:20+size])
    binary = packed[28+size:]
    document["buffers"][0]["uri"] = "object.bin"
    document["nodes"][0]["translation"] = [2, 3, 4]
    document["images"] = [{"uri": "textures/color.png"}]
    document["textures"] = [{"source": 0}]
    document["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    return document, {"object.bin": binary, "textures/color.png": png()}


class FakeClient:
    def __init__(self):
        self.catalogs = {"textures": {"test_texture": {"type": 1, "name": "Test Texture", "tags": ["wood"], "categories": ["natural"]}},
                         "models": {"Test_Model": {"type": 2, "name": "Test Model"}},
                         "hdris": {"test_light": {"type": 0, "name": "Test Light"}}}
        self.files, self.payloads, self.calls, self.downloads = {}, {}, [], []
        self.offline = False

    def add(self, payload, name):
        record = file_record(payload, name)
        self.payloads[record["url"]] = payload
        return record

    def metadata(self, path):
        self.calls.append(path)
        if self.offline:
            raise PolyHavenError("Offline")
        if path.startswith("/assets?t="):
            return copy.deepcopy(self.catalogs[path.split("=")[-1]])
        return copy.deepcopy(self.files[path.split("/")[-1]])

    def download(self, record, *, max_bytes, deadline):
        self.downloads.append(record["url"])
        payload = self.payloads[record["url"]]
        if len(payload) > max_bytes:
            raise PolyHavenError("Exceeded bytes")
        return payload


class PolyHavenTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.client = FakeClient()
        self.materials = MaterialLibrary(self.root, start_worker=False)
        self.library = PolyHavenLibrary(self.root, client=self.client, material_library=self.materials)

    def texture(self):
        self.client.files["test_texture"] = {name: {"1k": {"png": self.client.add(png((value, value, value)), name+".png")}}
            for value, name in enumerate(("Diffuse", "nor_gl", "Rough", "Metal", "Displacement"), start=128)}

    def test_catalog_search_pagination_and_disk_cache(self):
        self.client.catalogs["textures"].update({"other": {"type": 1, "name": "Other", "tags": ["wood"]},
                                                "wrong_kind": {"type": 2, "name": "Wrong", "tags": ["wood"]}})
        result = self.library.list_assets("textures", "wood", 0, 1)
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["assets"][0]["id"], "other")
        self.assertTrue(result["hasMore"])
        recreated = PolyHavenLibrary(self.root, client=self.client)
        self.assertEqual(recreated.list_assets("textures", "wood", 1, 1)["assets"][0]["id"], "test_texture")
        self.assertEqual(self.client.calls, ["/assets?t=textures"])
        self.assertEqual(self.library.list_assets("textures", "wood natural")["total"], 1)

    def test_stale_catalog_remains_available_offline_with_visible_state(self):
        self.library.list_assets("textures")
        self.client.offline = True
        stale = PolyHavenLibrary(self.root, client=self.client, cache_ttl=0).list_assets("textures")
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["total"], 1)

    def test_material_import_uses_all_named_maps_and_persists_once(self):
        self.texture()
        result = self.library.import_asset("textures", "test_texture")
        material = result["entry"]["material"]
        self.assertEqual(set(material["textures"]), {"basecolor", "normal", "roughness", "metalness", "height"})
        self.assertEqual(material["metallic"], 1)
        for asset in material["textures"].values():
            payload = (self.root / asset["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(payload).hexdigest(), asset["sha256"])
        self.assertEqual(self.materials.list()["materials"][0]["id"], result["entry"]["id"])
        count = len(self.client.downloads)
        self.assertEqual(self.library.import_asset("textures", "test_texture"), result)
        self.assertEqual(len(self.client.downloads), count)
        self.assertTrue(self.library.list_assets("textures")["assets"][0]["downloaded"])

    def test_missing_imported_asset_can_be_downloaded_again(self):
        self.texture()
        result = self.library.import_asset("textures", "test_texture")
        path = self.root / result["entry"]["material"]["textures"]["basecolor"]["path"]
        path.unlink()
        self.library.import_asset("textures", "test_texture")
        self.assertTrue(path.is_file())

    def test_failed_texture_set_does_not_publish_partial_material(self):
        self.texture()
        record = self.client.files["test_texture"]["nor_gl"]["1k"]["png"]
        self.client.payloads[record["url"]] = b"not PNG"
        with self.assertRaisesRegex(ValueError, "PNG"):
            self.library.import_asset("textures", "test_texture")
        self.assertEqual(self.materials.list()["materials"], [])
        self.assertEqual(list(self.library.entries.glob("*.json")), [])

    def test_packed_prop_preserves_materials_and_bytes_with_centered_bounds(self):
        document, dependencies = gltf_fixture()
        result, measured = pack_gltf(json.dumps(document).encode(), dependencies)
        verified = inspect_product_glb(result)
        self.assertEqual(measured, verified)
        for low, high in zip(measured["boundsM"][0], measured["boundsM"][1]):
            self.assertAlmostEqual(low + high, 0, places=7)
        size = struct.unpack_from("<I", result, 12)[0]
        packed_document = json.loads(result[20:20+size])
        self.assertEqual(packed_document["materials"], document["materials"])
        self.assertEqual(packed_document["nodes"][0]["translation"], [2, 3, 4])
        self.assertNotIn("uri", packed_document["images"][0])
        self.assertIn(dependencies["textures/color.png"], result)
        self.assertIn(dependencies["object.bin"], result)

    def test_model_import_downloads_only_declared_referenced_dependencies(self):
        document, dependencies = gltf_fixture()
        record = self.client.add(json.dumps(document).encode(), "Test_Model.gltf")
        record["include"] = {name: self.client.add(payload, name) for name, payload in dependencies.items()}
        record["include"]["unused.bin"] = self.client.add(b"unused", "unused.bin")
        self.client.files["Test_Model"] = {"gltf": {"1k": {"gltf": record}}}
        entry = self.library.import_asset("models", "Test_Model")["entry"]
        self.assertEqual(entry["sizeM"], entry["asset"]["sourceDimensionsM"])
        self.assertEqual(entry["asset"]["sourceUp"], "Y")
        self.assertEqual(len(self.client.downloads), 3)
        self.assertTrue((self.root / entry["asset"]["path"]).is_file())

    def test_prop_rejects_external_or_undeclared_resource_references(self):
        document, dependencies = gltf_fixture()
        for uri in ("../outside.bin", "https://evil.example/file", "%2e%2e/outside.bin", "textures/%2froot.bin"):
            with self.subTest(uri=uri), self.assertRaises(PolyHavenError):
                _relative_uri(uri)
        document["buffers"][0]["uri"] = "missing.bin"
        with self.assertRaisesRegex(PolyHavenError, "undeclared"):
            pack_gltf(json.dumps(document).encode(), dependencies)

    def test_prop_rejects_source_buffer_escape_before_merging(self):
        document, dependencies = gltf_fixture()
        document["bufferViews"][0]["byteOffset"] = -4
        with self.assertRaisesRegex(PolyHavenError, "source buffer"):
            pack_gltf(json.dumps(document).encode(), dependencies)

    def test_hdr_import_pins_validated_image(self):
        self.client.files["test_light"] = {"hdri": {"1k": {"hdr": self.client.add(hdr(), "test.hdr")}}}
        entry = self.library.import_asset("hdris", "test_light")["entry"]
        self.assertEqual(entry["dimensionsPx"], [8, 2])
        self.assertEqual(entry["asset"]["format"], "hdr")
        self.assertEqual((self.root / entry["asset"]["path"]).read_bytes(), hdr())

    def test_hdr_rejects_truncation_run_overflow_dimensions_and_trailing_pixels(self):
        self.assertEqual(validate_hdri(hdr()), {"width": 8, "height": 2})
        invalid = [hdr()[:-1], hdr()+b"x", hdr().replace(b"-Y 2 +X 8", b"-Y 2 +X 9000"),
                   hdr().replace(bytes([136, 128]), bytes([137, 128]), 1)]
        for payload in invalid:
            with self.subTest(payload=payload[-10:]), self.assertRaises(PolyHavenError):
                validate_hdri(payload)

    def test_invalid_query_and_identity_are_rejected_before_network(self):
        for kind in ("lighting", [], None):
            with self.assertRaises(PolyHavenError):
                self.library.list_assets(kind)
        with self.assertRaises(PolyHavenError):
            self.library.import_asset("models", "../other")
        with self.assertRaises(PolyHavenError):
            self.library.list_assets("textures", offset=-1)
        self.assertEqual(self.client.calls, [])


class Response(io.BytesIO):
    def __init__(self, payload, url):
        super().__init__(payload)
        self.url = url
        self.headers = {"Content-Length": str(len(payload))}

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return Response(self.payload, request.full_url)


class ProviderBoundaryTests(unittest.TestCase):
    def test_download_checks_declared_length_and_checksum(self):
        payload = b"content"
        opener = Opener(payload)
        client = PolyHavenClient(download_opener=opener)
        record = file_record(payload, "test.bin")
        self.assertEqual(client.download(record, max_bytes=1024, deadline=time.monotonic()+30), payload)
        self.assertEqual(opener.requests[0].get_header("User-agent"), "GessoStudio/0.1")
        record["md5"] = "0" * 32
        with self.assertRaisesRegex(PolyHavenError, "checksum"):
            client.download(record, max_bytes=1024, deadline=time.monotonic()+30)
        record["size"] = 9000
        with self.assertRaisesRegex(PolyHavenError, "size"):
            client.download(record, max_bytes=1024, deadline=time.monotonic()+30)

    def test_download_hosts_and_redirect_targets_are_restricted(self):
        for url in ("http://dl.polyhaven.org/file", "https://dl.polyhaven.org.evil.test/file", "https://127.0.0.1/file",
                    "https://user:secret@dl.polyhaven.org/file", "https://dl.polyhaven.org:123/file"):
            with self.subTest(url=url), self.assertRaises(PolyHavenError):
                _safe_url(url)
        self.assertEqual(_safe_url("https://dl.polyhaven.org/file"), "https://dl.polyhaven.org/file")
