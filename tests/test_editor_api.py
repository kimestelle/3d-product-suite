"""Exercise the real loopback HTTP boundary without launching render tools."""

import copy
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from film import jobs, server
from film.scene import scene_digest
from tests.test_products import product_glb
from tests.test_worlds import glb_bytes, glb_document


class EditorApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # The queue still persists actual jobs. Only tool execution is disabled.
        with patch.object(server.RenderQueue, "_worker", return_value=None):
            self.app = server.Application(self.root / "data", port=0)
            self.app.renders.thread.join(timeout=2)
        handler = server.make_handler(self.app)
        handler.log_message = lambda *args: None
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.app.port = self.http.server_port
        self.app.renders.base_url = f"http://127.0.0.1:{self.http.server_port}"
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, data=None, *, headers=None, raw=None, mutate=True):
        selected = dict(headers or {})
        if method in ("POST", "PUT") and mutate:
            selected.setdefault("X-Product-Suite", "1")
        body = raw
        if data is not None:
            body = json.dumps(data).encode()
            selected.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=selected)
            response = connection.getresponse()
            payload = response.read()
            value = json.loads(payload) if response.getheader("Content-Type", "").startswith("application/json") else payload
            return response.status, value, dict(response.getheaders())
        finally:
            connection.close()

    def bootstrap(self):
        status, value, _ = self.request("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        return value

    def test_bootstrap_seeds_labeled_mesh_and_gaussian_worlds_and_reopens_project(self):
        first = self.bootstrap()
        self.assertEqual({world["environment"]["kind"] for world in first["worlds"]}, {"mesh", "splat"})
        for world in first["worlds"]:
            self.assertTrue(world["environment"]["fixture"])
            self.assertEqual(world["environment"]["reviewStatus"], "unreviewed")
            source = world["environment"]["provenance"]["source"]
            self.assertIn("Original authored offline" if world["name"].startswith("Default ·") else "synthetic", source)
            asset = world["environment"]["asset"]
            self.assertEqual(jobs._sha256(self.app.store.root / asset["path"]), asset["sha256"])
        self.assertEqual(first["project"]["approvedRevisionId"], None)
        self.assertEqual(self.bootstrap()["project"], first["project"])
        self.assertEqual(first["jobs"], [])
        self.assertTrue({"Default · Gallery", "Default · Botanical room"}.issubset({w["name"] for w in first["worlds"]}))
        status, reopened, _ = self.request("GET", f"/api/projects/{first['project']['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(reopened, first["project"])

    def test_stale_save_returns_conflict_without_replacing_newer_revision(self):
        project = self.bootstrap()["project"]
        edited = copy.deepcopy(project["scene"])
        edited["product"]["label"]["text"] = "SAVED REVISION"
        route = f"/api/projects/{project['id']}"
        status, saved, _ = self.request("PUT", route, {"scene": edited, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200)
        self.assertEqual(saved["revisionId"], scene_digest(edited))
        self.assertNotEqual(saved["revisionId"], project["revisionId"])
        stale = copy.deepcopy(project["scene"])
        stale["product"]["label"]["text"] = "STALE TAB"
        status, conflict, _ = self.request("PUT", route, {"scene": stale, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 409)
        self.assertIsInstance(conflict["error"], str)
        status, current, _ = self.request("GET", route)
        self.assertEqual(status, 200)
        self.assertEqual(current["scene"], edited)
        self.assertEqual(current["revisionId"], saved["revisionId"])
        self.assertFalse((self.app.store.projects / project["id"] / "revisions" / f"{scene_digest(stale)}.json").exists())

    def test_approved_revision_is_immutable_after_experimental_edit(self):
        project = self.bootstrap()["project"]
        route = f"/api/projects/{project['id']}"
        status, approved, _ = self.request("POST", route + "/approve", {"expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200)
        self.assertEqual(approved["approvedRevisionId"], project["revisionId"])
        revision_path = self.app.store.projects / project["id"] / "revisions" / f"{project['revisionId']}.json"
        revision_bytes = revision_path.read_bytes()
        edited = copy.deepcopy(project["scene"])
        edited["product"]["label"]["text"] = "EXPERIMENT"
        status, draft, _ = self.request("PUT", route, {"scene": edited, "expectedRevisionId": approved["revisionId"]})
        self.assertEqual(status, 200)
        self.assertEqual(draft["approvedRevisionId"], project["revisionId"])
        self.assertNotEqual(draft["revisionId"], draft["approvedRevisionId"])
        status, historical, _ = self.request("GET", route + f"/revisions/{project['revisionId']}")
        self.assertEqual(status, 200)
        self.assertEqual(historical["scene"], project["scene"])
        self.assertEqual(historical["revisionId"], project["revisionId"])
        self.assertEqual(historical["headRevisionId"], draft["revisionId"])
        self.assertEqual(revision_path.read_bytes(), revision_bytes)
        status, error, _ = self.request("POST", route + "/approve", {"expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 409)
        self.assertIn("error", error)

    def test_mutations_require_local_header_and_block_foreign_origin_or_host(self):
        baseline = self.bootstrap()
        attempts = [
            ({}, False),
            ({"X-Product-Suite": "0"}, True),
            ({"Origin": "https://attacker.invalid"}, True),
            ({"Host": "attacker.invalid"}, True),
            ({"Origin": "http://localhost:9999"}, True),
        ]
        for headers, mutate in attempts:
            with self.subTest(headers=headers):
                status, error, _ = self.request("POST", "/api/projects", {"name": "Blocked"}, headers=headers, mutate=mutate)
                self.assertEqual(status, 403)
                self.assertIn("error", error)
        self.assertEqual(self.bootstrap()["projects"], baseline["projects"])
        for headers in ({"Origin": "https://attacker.invalid"}, {"Host": "attacker.invalid"}):
            status, error, _ = self.request("GET", "/api/bootstrap", headers=headers)
            self.assertEqual(status, 403)
            self.assertIn("error", error)
        status, _, _ = self.request("POST", "/api/projects", {"name": "Vite session"}, headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 201)

    def test_evaluation_matches_shared_scene_digest_and_exact_sampled_camera(self):
        project = self.bootstrap()["project"]
        status, value, _ = self.request("POST", "/api/evaluate", {"scene": project["scene"]})
        self.assertEqual(status, 200)
        self.assertEqual(value["digest"], scene_digest(project["scene"]))
        self.assertEqual(len(value["frames"]), 360)
        self.assertEqual(value["frames"][0]["frame"], 1)
        pose = project["scene"]["shots"][0]["camera"]["from"]
        self.assertEqual({key: value["frames"][0]["camera"][key] for key in pose}, pose)
        self.assertFalse(value["frames"][0]["camera"]["depthOfField"]["enabled"])
        self.assertEqual(value["frames"][-1]["frame"], 360)

    def test_world_import_validates_bytes_and_exposes_only_hash_named_assets(self):
        query = urlencode({"name": "Manual visual room", "sourceUp": "Y", "owner": "Test owner", "reuseBasis": "Original test geometry"})
        route = "/api/worlds/import?" + query
        headers = {"X-Asset-Filename": "room.glb", "Content-Type": "application/octet-stream"}
        payload = glb_bytes()
        status, entry, _ = self.request("POST", route, raw=payload, headers=headers)
        self.assertEqual(status, 201)
        self.assertEqual(entry["name"], "Manual visual room")
        self.assertEqual(entry["environment"]["kind"], "mesh")
        self.assertEqual(entry["environment"]["reviewStatus"], "unreviewed")
        asset = entry["environment"]["asset"]
        status, served, response_headers = self.request("GET", "/api/" + asset["path"])
        self.assertEqual(status, 200)
        self.assertEqual(served, payload)
        self.assertEqual(response_headers["Content-Type"], "model/gltf-binary")
        self.assertIn("immutable", response_headers["Cache-Control"])
        status, worlds, _ = self.request("GET", "/api/worlds")
        self.assertEqual(status, 200)
        self.assertIn(entry, worlds)
        previous = copy.deepcopy(worlds)
        external = glb_document()
        external["buffers"][0]["uri"] = "https://attacker.invalid/asset.bin"
        for content, selected_headers in ((b"not a GLB", headers), (glb_bytes(external), headers),
                                          (payload, {**headers, "X-Asset-Filename": "room.txt"})):
            status, error, _ = self.request("POST", route, raw=content, headers=selected_headers)
            self.assertEqual(status, 400)
            self.assertIn("error", error)
        self.assertEqual(self.request("GET", "/api/worlds")[1], previous)
        self.assertEqual(list(self.app.store.root.glob("import-*")), [])

    def test_product_upload_creates_reopenable_project_and_preserves_original_hash_named_glb(self):
        baseline = self.bootstrap()["project"]
        provenance = {"source": "Approved product model revision 3", "owner": "Product owner",
                      "reuseBasis": "Owner supplied model for this campaign"}
        query = urlencode({"name": "Actual product campaign", **provenance})
        payload = product_glb()
        headers = {"X-Asset-Filename": "approved-product.glb", "Content-Type": "application/octet-stream"}
        status, project, _ = self.request("POST", "/api/products/import?" + query, raw=payload, headers=headers)
        self.assertEqual(status, 201)
        self.assertNotEqual(project["id"], baseline["id"])
        self.assertEqual(project["name"], "Actual product campaign")
        self.assertIsNone(project["approvedRevisionId"])
        scene = project["scene"]
        self.assertEqual(project["revisionId"], scene_digest(scene))
        self.assertEqual(scene["product"]["provenance"], {**provenance, "allowedExternalDestinations": []})
        self.assertNotIn("label", scene["product"])
        self.assertEqual(scene["actions"], [])
        self.assertEqual(scene["evidence"], [])
        component, = scene["product"]["components"]
        self.assertEqual(component["shape"], "mesh")
        self.assertFalse(component["materialOverride"])
        for actual, expected in zip(component["sizeM"], [.06, .12, .04]):
            self.assertAlmostEqual(actual, expected, places=7)
        digest = hashlib.sha256(payload).hexdigest()
        self.assertEqual(component["asset"], {"format": "glb", "sourceUp": "Y",
                                             "path": f"assets/{digest}.glb", "sha256": digest})
        status, served, response_headers = self.request("GET", f"/api/assets/{digest}.glb")
        self.assertEqual(status, 200)
        self.assertEqual(served, payload)
        self.assertEqual(response_headers["Content-Type"], "model/gltf-binary")
        self.assertIn("immutable", response_headers["Cache-Control"])
        self.assertEqual(self.request("GET", f"/api/projects/{project['id']}")[1], project)
        self.assertEqual(self.request("GET", f"/api/projects/{baseline['id']}")[1], baseline)
        self.assertEqual(len(self.request("GET", "/api/projects")[1]), 2)
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": scene})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(sampled["frames"][0]["components"]["product"]["translationM"][1], .16, places=7)
        self.assertEqual(list(self.app.store.root.glob("product-import-*")), [])

    def test_invalid_product_uploads_and_missing_provenance_create_no_projects_or_assets(self):
        baseline = self.bootstrap()
        original_assets = {path.name: path.read_bytes() for path in (self.app.store.root / "assets").iterdir()}
        query = {"name": "Rejected product", "owner": "Model owner", "reuseBasis": "Original model",
                 "source": "Approved product model"}
        headers = {"X-Asset-Filename": "product.glb", "Content-Type": "application/octet-stream"}
        valid = product_glb()
        uncentered = product_glb(change=lambda document: document["nodes"][0].update(translation=[.5, 0, 0]))
        external = product_glb(change=lambda document: document["buffers"][0].update(uri="https://attacker.invalid/product.bin"))
        attempts = [
            (b"not a product GLB", query, headers),
            (uncentered, query, headers),
            (external, query, headers),
            (valid, {key: value for key, value in query.items() if key != "owner"}, headers),
            (valid, {key: value for key, value in query.items() if key != "reuseBasis"}, headers),
            (valid, {"name": "Missing provenance"}, headers),
            (valid, query, {**headers, "X-Asset-Filename": "product.obj"}),
        ]
        for payload, selected_query, selected_headers in attempts:
            with self.subTest(query=selected_query, filename=selected_headers["X-Asset-Filename"], payload_size=len(payload)):
                status, error, _ = self.request("POST", "/api/products/import?" + urlencode(selected_query),
                                                raw=payload, headers=selected_headers)
                self.assertEqual(status, 400)
                self.assertIn("error", error)
                self.assertEqual(self.request("GET", "/api/projects")[1], baseline["projects"])
                self.assertEqual({path.name: path.read_bytes() for path in (self.app.store.root / "assets").iterdir()}, original_assets)
                self.assertEqual(list(self.app.store.root.glob("product-import-*")), [])

    def test_blend_product_upload_converts_locally_with_configured_blender_and_reopens(self):
        baseline = self.bootstrap()["project"]
        self.app.renders.blender = "/configured/Blender"
        query = urlencode({"name": "Blender product", "owner": "Fixture author", "reuseBasis": "Original fixture",
                           "source": "Saved Blender product"})
        headers = {"X-Asset-Filename": "product.BLEND", "Content-Type": "application/octet-stream"}
        source_bytes = b"BLENDER-v403-test"
        payload = product_glb()
        report = {"sourceFormat": "blend", "sourceFrame": 7, "sourceSha256": hashlib.sha256(source_bytes).hexdigest()}
        conversion_paths = []

        def convert(source, destination, *, blender):
            self.assertEqual(source.read_bytes(), source_bytes)
            self.assertEqual(blender, "/configured/Blender")
            conversion_paths.extend([source, destination])
            destination.write_bytes(payload)
            return report

        with patch("film.blend_import.convert_blend_product", side_effect=convert) as conversion:
            status, project, _ = self.request("POST", "/api/products/import?" + query, raw=source_bytes, headers=headers)
        self.assertEqual(status, 201, project)
        conversion.assert_called_once()
        self.assertEqual(project["scene"]["product"]["metadata"]["blendImport"], report)
        asset = project["scene"]["product"]["components"][0]["asset"]
        self.assertEqual(self.request("GET", "/api/" + asset["path"])[1], payload)
        self.assertEqual(self.request("GET", f"/api/projects/{project['id']}")[1], project)
        self.assertEqual(self.request("GET", f"/api/projects/{baseline['id']}")[1], baseline)
        self.assertFalse(any(path.exists() for path in conversion_paths))
        self.assertEqual(list(self.app.store.root.glob("product-import-*")), [])

    def test_newer_import_blender_does_not_change_pinned_render_executable(self):
        self.bootstrap()
        self.app.import_blender = "/Blender-5.1"
        self.app.renders.blender = "/Blender-4.3.2"
        query = urlencode({"name": "New Blender file", "owner": "Fixture author", "reuseBasis": "Original fixture", "source": "Fixture"})
        def convert(source, destination, *, blender):
            self.assertEqual(blender, "/Blender-5.1")
            destination.write_bytes(product_glb())
            return {"sourceFormat": "blend"}
        with patch("film.blend_import.convert_blend_product", side_effect=convert):
            status, project, _ = self.request("POST", "/api/products/import?" + query, raw=b"BLENDER-v501-test",
                                             headers={"X-Asset-Filename": "product.blend", "Content-Type": "application/octet-stream"})
        self.assertEqual(status, 201, project)
        self.assertEqual(self.app.renders.blender, "/Blender-4.3.2")

    def test_cad_and_mesh_routes_keep_units_axes_and_original_campaign(self):
        baseline = self.bootstrap()["project"]
        common = {"name": "Imported part", "owner": "Fixture author", "reuseBasis": "Original fixture", "source": "Fixture"}
        cases = [("step", "convert_cad_product", "cadImport", {"sourceUp": "y"}),
                 ("igs", "convert_cad_product", "cadImport", {"sourceUp": "z"}),
                 ("obj", "convert_mesh_product", "meshImport", {"sourceUp": "y", "sourceUnits": "in"}),
                 ("stl", "convert_mesh_product", "meshImport", {"sourceUp": "z", "sourceUnits": "mm"})]
        for extension, converter, key, options in cases:
            with self.subTest(extension=extension):
                def convert(source, destination, **kwargs):
                    self.assertEqual(source.read_bytes(), b"fixture source")
                    self.assertEqual(kwargs["source_up"], options["sourceUp"])
                    if "sourceUnits" in options:
                        self.assertEqual(kwargs["source_units"], options["sourceUnits"])
                    destination.write_bytes(product_glb())
                    return {"sourceFormat": extension, "warnings": []}
                with patch("film.cad_import." + converter, side_effect=convert):
                    status, project, _ = self.request("POST", "/api/products/import?" + urlencode({**common, **options}),
                                                     raw=b"fixture source", headers={"X-Asset-Filename": "part." + extension, "Content-Type": "application/octet-stream"})
                self.assertEqual(status, 201, project)
                self.assertEqual(project["scene"]["product"]["metadata"][key]["sourceFormat"], extension)
                asset = project["scene"]["product"]["components"][0]["asset"]
                self.assertEqual(self.request("GET", "/api/" + asset["path"])[1], product_glb())
        self.assertEqual(self.request("GET", f"/api/projects/{baseline['id']}")[1], baseline)
        self.assertEqual(list(self.app.store.root.glob("product-import-*")), [])

    def test_failed_blend_conversion_leaves_existing_campaign_and_assets_unchanged(self):
        baseline = self.bootstrap()
        assets = {path.name: path.read_bytes() for path in (self.app.store.root / "assets").iterdir()}
        query = {"name": "Blender product", "owner": "Fixture author", "reuseBasis": "Original fixture", "source": "Fixture"}
        headers = {"X-Asset-Filename": "product.blend", "Content-Type": "application/octet-stream"}
        with patch("film.blend_import.convert_blend_product", side_effect=ValueError("Pack textures before saving")) as conversion:
            status, error, _ = self.request("POST", "/api/products/import?" + urlencode(query), raw=b"BLENDER-v403-test", headers=headers)
            self.assertEqual(status, 400)
            self.assertIn("Pack textures", error["error"])
            conversion.assert_called_once()
        with patch("film.blend_import.convert_blend_product") as conversion:
            status, _, _ = self.request("POST", "/api/products/import?name=Missing+provenance", raw=b"BLENDER-v403-test", headers=headers)
            self.assertEqual(status, 400)
            conversion.assert_not_called()
        self.assertEqual(self.request("GET", "/api/projects")[1], baseline["projects"])
        self.assertEqual({path.name: path.read_bytes() for path in (self.app.store.root / "assets").iterdir()}, assets)
        self.assertEqual(list(self.app.store.root.glob("product-import-*")), [])

    def test_unknown_routes_traversal_and_nonallowlisted_job_files_cannot_read_local_files(self):
        secret = b"LOCAL FILE MUST NOT BE SERVED"
        (self.root / "private.txt").write_bytes(secret)
        for route in ("/api/files/private.txt", "/api/assets/../../private.txt", "/api/assets/%2e%2e%2fprivate.txt",
                      "/api/assets/not-a-hash.glb", "/api/jobs/unknown/files/scene.json", "/%2e%2e/private.txt"):
            with self.subTest(route=route):
                status, body, _ = self.request("GET", route)
                self.assertIn(status, (400, 403, 404))
                self.assertNotIn(secret.decode(), json.dumps(body))
                self.assertIn("error", body)
        status, error, _ = self.request("GET", "/api/assets/" + "0" * 64 + ".glb")
        self.assertEqual(status, 404)
        self.assertIn("error", error)

    def test_provider_status_exposes_boolean_and_no_api_key(self):
        key = "worldlabs-key-that-must-never-reach-browser"
        with patch.dict("os.environ", {"WORLDLABS_API_KEY": key}):
            bootstrap = self.bootstrap()
            self.assertTrue(bootstrap["capabilities"]["worldlabsConfigured"])
            status, value, _ = self.request("GET", "/api/worldlabs/status")
            self.assertEqual(status, 200)
            self.assertEqual(value, {"configured": True})
            self.assertNotIn(key, json.dumps(bootstrap))
            self.assertNotIn(key, json.dumps(value))
        with patch.dict("os.environ", {"WORLDLABS_API_KEY": ""}):
            self.assertEqual(self.request("GET", "/api/worldlabs/status")[1], {"configured": False})

    def test_render_requests_pin_source_and_defaults_and_validate_frame(self):
        scene = self.bootstrap()["project"]["scene"]
        for kind, width, height, samples in (("still", 540, 960, 32), ("reel", 270, 480, 8)):
            status, summary, _ = self.request("POST", "/api/renders", {"scene": scene, "kind": kind, "frame": 42})
            self.assertEqual(status, 202)
            self.assertEqual(summary["kind"], kind)
            self.assertEqual(summary["sourceDigest"], scene_digest(scene))
            self.assertEqual((summary["width"], summary["height"]), (width, height))
            self.assertEqual(summary["totalFrames"], 1 if kind == "still" else 360)
            manifest = jobs._read_job(self.app.renders.directory(summary["id"]))
            self.assertEqual(manifest["renderProfile"]["samples"], samples)
            self.assertEqual(summary["artifacts"], [])
            self.assertEqual(self.request("GET", f"/api/jobs/{summary['id']}")[1], summary)
        for frame in (0, 361, True, 1.5):
            with self.subTest(frame=frame):
                status, error, _ = self.request("POST", "/api/renders", {"scene": scene, "kind": "still", "frame": frame})
                self.assertEqual(status, 400)
                self.assertIn("error", error)
        self.assertEqual(len(self.request("GET", "/api/jobs")[1]), 2)
        status, error, _ = self.request("POST", "/api/renders", {"scene": scene, "kind": "unknown"})
        self.assertEqual(status, 400)
        self.assertIn("error", error)

    def test_invalid_json_and_non_json_mutations_return_json_errors(self):
        for raw, content_type in ((b"{", "application/json"), (b"{}", "text/plain")):
            status, body, headers = self.request("POST", "/api/projects", raw=raw, headers={"Content-Type": content_type})
            self.assertEqual(status, 400)
            self.assertIn("error", body)
            self.assertTrue(headers["Content-Type"].startswith("application/json"))


if __name__ == "__main__":
    unittest.main()
