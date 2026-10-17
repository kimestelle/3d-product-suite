"""Real loopback texture upload/preview/save boundaries, without render tools."""
import copy
from unittest.mock import patch
import unittest

from film import server
from tests import test_editor_api
from tests.test_jobs import png_bytes
from tests.test_textures import JPEG, label


class TextureApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def upload(self, payload=None, filename="label.png", **kwargs):
        return self.request("POST", "/api/textures/import", raw=png_bytes() if payload is None else payload,
                            headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": filename,
                                     **kwargs.pop("headers", {})}, **kwargs)

    def test_uploads_serve_verified_immutable_png_and_normalized_jpeg_assets(self):
        for payload, filename, mime in ((png_bytes(), "label.png", "image/png"), (JPEG, "label.jpeg", "image/jpeg")):
            with self.subTest(filename=filename):
                status, imported, _ = self.upload(payload, filename)
                self.assertEqual(status, 201, imported)
                status, downloaded, headers = self.request("GET", f"/api/{imported['asset']['path']}")
                self.assertEqual(status, 200)
                self.assertEqual(downloaded, payload)
                self.assertEqual(headers["Content-Type"], mime)
                self.assertIn("immutable", headers["Cache-Control"])
                (self.app.store.root / imported["asset"]["path"]).write_bytes(b"modified")
                status, error, _ = self.request("GET", f"/api/{imported['asset']['path']}")
                self.assertEqual(status, 400)

    def test_upload_bounds_mime_and_security_fail_before_creating_assets(self):
        for filename in ("label.svg", "../../label.png", "label.jpg"):
            status, error, _ = self.upload(filename=filename)
            self.assertEqual(status, 400)
        status, error, _ = self.upload(headers={"Content-Type": "image/png"})
        self.assertEqual(status, 400)
        self.assertIn("application/octet-stream", error["error"])
        status, error, _ = self.upload(mutate=False)
        self.assertEqual(status, 403)
        status, error, _ = self.upload(headers={"Origin": "https://elsewhere.invalid"})
        self.assertEqual(status, 403)
        with patch.object(server, "MAX_TEXTURE_BYTES", 10):
            status, error, _ = self.upload()
        self.assertEqual(status, 400)
        self.assertIn("1–10", error["error"])

    def test_texture_edits_evaluate_save_and_reopen_and_reject_corrupt_persistence(self):
        project = self.bootstrap()["project"]
        status, uploaded, _ = self.upload()
        self.assertEqual(status, 201)
        scene = copy.deepcopy(project["scene"])
        scene["product"]["components"][0]["labelTexture"] = label(uploaded["asset"])
        status, preview, _ = self.request("POST", "/api/evaluate", {"scene": scene})
        self.assertEqual(status, 200, preview)
        status, saved, _ = self.request("PUT", f"/api/projects/{project['id']}",
                                         {"scene": scene, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        status, reopened, _ = self.request("GET", f"/api/projects/{project['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(reopened["scene"], scene)
        (self.app.store.root / uploaded["asset"]["path"]).write_bytes(png_bytes(value=21))
        # Timeline evaluation stays lightweight; persistence and asset loading
        # own the file integrity checks rather than rehashing on every edit.
        status, preview, _ = self.request("POST", "/api/evaluate", {"scene": scene})
        self.assertEqual(status, 200)
        status, error, _ = self.request("GET", f"/api/projects/{project['id']}")
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
