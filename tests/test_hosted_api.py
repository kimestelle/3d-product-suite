"""Exercise hosted authentication against real HTTP and durable local records.

Only render/material workers and tool discovery are disabled. Requests pass
through the production handler, including authentication before asset reads,
provider dispatch, request parsing and project mutation.
"""

import copy
import http.client
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from film import server
from film.hosting import COOKIE_NAME, SESSION_SECONDS, HostedAccess
from film.worlds import list_worlds


PUBLIC_URL = "https://gesso-studio-gold.vercel.app"
BACKEND_URL = "https://gesso-api.onrender.com"
ACCESS_KEY = "hosted-test-access-key-at-least-32-characters"


def hosted_access(**overrides):
    return HostedAccess(**{"public_url": PUBLIC_URL, "backend_url": BACKEND_URL,
                           "access_key": ACCESS_KEY, **overrides})


class HostedApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.access = hosted_access()
        with (patch.object(server.RenderQueue, "_worker", return_value=None),
              patch.object(server.MaterialLibrary, "_worker", return_value=None)):
            self.app = server.Application(self.root / "data", port=0, access=self.access)
            self.app.renders.thread.join(timeout=2)
        # These tests do not depend on the machine's Blender/FFmpeg installation.
        self.app._render_capabilities = {"blenderAvailable": False, "ffmpegAvailable": False,
                                         "blenderIssue": "Disabled in HTTP tests",
                                         "ffmpegIssue": "Disabled in HTTP tests"}
        handler = server.make_handler(self.app)
        handler.log_message = lambda *args: None
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.app.port = self.http.server_port
        self.app.renders.base_url = f"http://127.0.0.1:{self.app.port}"
        self.thread = threading.Thread(target=lambda: self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, data=None, *, raw=None, headers=None, cookie=None, local=False):
        selected = {"Host": f"127.0.0.1:{self.app.port}" if local else "gesso-api.onrender.com"}
        if cookie is not None:
            selected["Cookie"] = cookie
        if method in ("POST", "PUT"):
            selected["X-Product-Suite"] = "1"
        body = raw
        if data is not None:
            body = json.dumps(data).encode()
            selected["Content-Type"] = "application/json"
        selected.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.app.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=selected)
            response = connection.getresponse()
            payload = response.read()
            value = json.loads(payload) if response.getheader("Content-Type", "").startswith("application/json") else payload
            return response.status, value, dict(response.getheaders())
        finally:
            connection.close()

    def login(self, *, key=ACCESS_KEY, target="/", origin=PUBLIC_URL, headers=None):
        selected = {"Content-Type": "application/x-www-form-urlencoded"}
        if origin is not None:
            selected["Origin"] = origin
        selected.update(headers or {})
        return self.request("POST", "/api/login", raw=urlencode({"key": key, "return": target}).encode(), headers=selected)

    def session_cookie(self):
        return f"{COOKIE_NAME}={self.access.session()}"

    def test_every_workspace_boundary_requires_authentication_before_reading_or_dispatching(self):
        world = list_worlds(self.app.store.root)[0]
        routes = [("GET", "/api/bootstrap"), ("GET", "/api/projects"),
                  ("GET", "/api/worlds"), ("GET", "/api/jobs"),
                  ("GET", "/api/materials"), ("GET", "/api/github-worlds/runs"),
                  ("GET", "/api/" + world["environment"]["asset"]["path"]),
                  ("POST", "/api/projects"), ("PUT", "/api/projects/not-a-project"),
                  ("POST", "/api/renders"), ("POST", "/api/materials/generate"),
                  ("POST", "/api/products/import"), ("POST", "/api/textures/import"),
                  ("POST", "/api/github-worlds/generate")]
        with patch.object(self.app.github, "dispatch", side_effect=AssertionError("No paid dispatch")):
            for method, path in routes:
                for local in (False, True):
                    with self.subTest(method=method, path=path, local=local):
                        status, error, headers = self.request(method, path, data={} if method != "GET" else None, local=local)
                        self.assertEqual(status, 401)
                        self.assertEqual(error["loginUrl"], "/api/login")
                        self.assertIn("no-store", headers["Cache-Control"])
        self.assertEqual(self.app.store.list(), [])
        self.assertEqual(list(self.app.github.requests.glob("*.json")), [])

    def test_public_health_probe_reveals_only_liveness(self):
        status, value, headers = self.request("GET", "/api/health", headers={"Host": "health.internal"})
        self.assertEqual(status, 200)
        self.assertEqual(value, {"status": "ok"})
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.app.store.list(), [])

    def test_login_sets_browser_cookie_and_authenticated_project_edits_reopen(self):
        status, _, headers = self.login(target="/?mode=film")
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/?mode=film")
        self.assertIn("private", headers["Cache-Control"])
        self.assertIn("no-store", headers["Cache-Control"])
        cookies = SimpleCookie()
        cookies.load(headers["Set-Cookie"])
        session = cookies[COOKIE_NAME]
        self.assertTrue(session["httponly"])
        self.assertTrue(session["secure"])
        self.assertEqual(session["samesite"], "Strict")
        self.assertEqual(session["path"], "/api")
        self.assertEqual(session["max-age"], str(SESSION_SECONDS))
        self.assertEqual(session["domain"], "")
        self.assertNotIn(ACCESS_KEY, headers["Set-Cookie"])
        cookie = f"{COOKIE_NAME}={session.value}"
        status, bootstrap, _ = self.request("GET", "/api/bootstrap", cookie=cookie)
        self.assertEqual(status, 200)
        project = bootstrap["project"]
        scene = copy.deepcopy(project["scene"])
        scene["product"]["label"]["text"] = "HOSTED REVISION"
        route = f"/api/projects/{project['id']}"
        status, saved, _ = self.request("PUT", route, {"scene": scene, "expectedRevisionId": project["revisionId"]},
                                       cookie=cookie, headers={"Origin": PUBLIC_URL})
        self.assertEqual(status, 200)
        self.assertNotEqual(saved["revisionId"], project["revisionId"])
        status, reopened, _ = self.request("GET", route, cookie=cookie)
        self.assertEqual(status, 200)
        self.assertEqual(reopened["scene"], scene)
        self.assertTrue((self.app.store.projects / project["id"] / "revisions" / f"{saved['revisionId']}.json").is_file())

    def test_login_form_is_protected_and_does_not_echo_the_key(self):
        status, form, headers = self.request("GET", "/api/login?" + urlencode({"return": "/?name='><script>bad</script>"}))
        self.assertEqual(status, 200)
        self.assertIn(b"type=password", form)
        self.assertIn(b"&#x27;&gt;&lt;script&gt;", form)
        self.assertNotIn(b"<script>", form)
        self.assertIn("form-action 'self'", headers["Content-Security-Policy"])
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Referrer-Policy"], "same-origin")
        self.assertIn("private", headers["Cache-Control"])
        status, rejected, headers = self.login(key="incorrect-private-key")
        self.assertEqual(status, 401)
        self.assertIn(b"did not match", rejected)
        self.assertNotIn(b"incorrect-private-key", rejected)
        self.assertNotIn("Set-Cookie", headers)

    def test_login_rejects_foreign_missing_or_local_development_origins(self):
        for origin in (None, "https://gesso-studio-gold.vercel.app.attacker.test", "https://attacker.test", "null",
                       "http://localhost:5173"):
            with self.subTest(origin=origin):
                status, _, headers = self.login(origin=origin)
                self.assertEqual(status, 403)
                self.assertNotIn("Set-Cookie", headers)
        status, _, _ = self.login(origin=BACKEND_URL)
        self.assertEqual(status, 303)
        status, _, headers = self.login(headers={"Host": "gesso-api.onrender.com.attacker.test"})
        self.assertEqual(status, 403)
        self.assertNotIn("Set-Cookie", headers)

    def test_login_only_redirects_to_safe_editor_paths(self):
        for target in ("https://attacker.test/", "//attacker.test/", "/\\attacker.test/", "/api/projects", "/\r\nX-Injected: yes", ""):
            with self.subTest(target=target):
                status, _, headers = self.login(target=target)
                self.assertEqual(status, 303)
                self.assertEqual(headers["Location"], "/")
                self.assertNotIn("X-Injected", headers)
        status, _, headers = self.login(target="/?scene=one&tab=materials")
        self.assertEqual(status, 303)
        self.assertEqual(headers["Location"], "/?scene=one&tab=materials")

    def test_authenticated_mutations_still_require_exact_host_origin_and_request_marker(self):
        cookie = self.session_cookie()
        for selected in ({"Host": "attacker.test"}, {"Origin": "https://attacker.test"},
                         {"Origin": PUBLIC_URL + ".attacker.test"}, {"Origin": "http://localhost:5173"},
                         {"X-Product-Suite": "0"}):
            with self.subTest(headers=selected):
                status, _, _ = self.request("POST", "/api/projects", {"name": "Must not exist"}, cookie=cookie, headers=selected)
                self.assertEqual(status, 403)
        self.assertEqual(self.app.store.list(), [])
        for selected in ({"Host": "attacker.test"}, {"Origin": "https://attacker.test"}):
            status, _, _ = self.request("GET", "/api/bootstrap", cookie=cookie, headers=selected)
            self.assertEqual(status, 403)
        for host, origin in (("gesso-api.onrender.com", BACKEND_URL), ("gesso-studio-gold.vercel.app", PUBLIC_URL)):
            status, _, _ = self.request("POST", "/api/projects", {"name": "Authorized shared campaign"}, cookie=cookie,
                                       headers={"Host": host, "Origin": origin})
            self.assertEqual(status, 201)

    def test_expired_tampered_and_rotated_sessions_are_rejected_before_asset_delivery(self):
        asset = list_worlds(self.app.store.root)[0]["environment"]["asset"]
        issued = self.access.session()
        with patch("film.hosting.time.time", return_value=time.time() - SESSION_SECONDS - 1):
            expired = self.access.session()
        tampered = issued[:-1] + ("0" if issued[-1] != "0" else "1")
        other_key = hosted_access(access_key="a-different-hosted-test-key-long-enough").session()
        for token in (expired, tampered, other_key, "malformed", ""):
            for path in ("/api/bootstrap", "/api/" + asset["path"]):
                with self.subTest(token_kind=token.split(".")[0], path=path):
                    status, _, headers = self.request("GET", path, cookie=f"{COOKIE_NAME}={token}")
                    self.assertEqual(status, 401)
                    self.assertIn("no-store", headers["Cache-Control"])

    def test_authenticated_assets_are_private_and_local_mode_cache_behavior_is_unchanged(self):
        asset = list_worlds(self.app.store.root)[0]["environment"]["asset"]
        route = "/api/" + asset["path"]
        expected = (self.app.store.root / asset["path"]).read_bytes()
        status, payload, headers = self.request("GET", route, cookie=self.session_cookie())
        self.assertEqual(status, 200)
        self.assertEqual(payload, expected)
        self.assertEqual(headers["Cache-Control"], "private,no-store")
        self.app.access = HostedAccess()
        status, payload, headers = self.request("GET", route, local=True)
        self.assertEqual(status, 200)
        self.assertEqual(payload, expected)
        self.assertIn("public", headers["Cache-Control"])
        self.assertIn("immutable", headers["Cache-Control"])
        status, _, _ = self.request("POST", "/api/projects", {"name": "Local Vite session"}, local=True,
                                    headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 201)

    def test_internal_loopback_capture_can_send_a_signed_cookie_without_browser_cookie_flags(self):
        # Playwright sends Cookie explicitly for localhost; Secure/SameSite are
        # browser storage restrictions, not fields of the HTTP Cookie header.
        # This fixture was emitted by scripts/capture_splats.mjs's actual
        # captureAuthHeaders(ACCESS_KEY, 1700000000000), not Python's signer.
        # Keeping the wire value avoids making the Python CI job require Node.
        javascript_cookie = ("gesso_session=1700043200.236246bda3a49ad7536f1acb97e5dd0f."
                             "07252451f59a8b34fb5959665ae03578346d62c7385af9a4090b3d2f58d5bef8")
        asset = list_worlds(self.app.store.root)[0]["environment"]["asset"]
        route = "/api/" + asset["path"]
        status, _, _ = self.request("GET", route, local=True)
        self.assertEqual(status, 401)
        with patch("film.hosting.time.time", return_value=1700000000):
            status, payload, headers = self.request("GET", route, local=True, cookie=javascript_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(payload, (self.app.store.root / asset["path"]).read_bytes())
        self.assertEqual(headers["Cache-Control"], "private,no-store")


class HostedConfigurationTests(unittest.TestCase):
    def test_exact_https_origins_and_strong_key_are_required(self):
        access = hosted_access(public_url="https://GESSO-STUDIO-GOLD.vercel.app/")
        self.assertEqual(access.public_url, PUBLIC_URL)
        self.assertEqual(access.hosts, {"gesso-studio-gold.vercel.app", "gesso-api.onrender.com"})
        for url in ("http://example.test", "https://example.test/path", "https://user:password@example.test",
                    "https://*.vercel.app", "https://example.test?query=1", "https://example.test#fragment",
                    "https://example.test:0", "https://example.test:65536", "https://example.test:invalid"):
            for field in ("public_url", "backend_url"):
                with self.subTest(url=url, field=field), self.assertRaises(ValueError):
                    hosted_access(**{field: url})
        with self.assertRaisesRegex(ValueError, "at least 32"):
            hosted_access(access_key="short")
        for values in ({"access_key": ACCESS_KEY}, {"backend_url": BACKEND_URL}):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, "GESSO_PUBLIC_URL"):
                HostedAccess(**values)

    def test_environment_configuration_accepts_platform_backend_url_without_exposing_key(self):
        with patch.dict(os.environ, {"GESSO_PUBLIC_URL": PUBLIC_URL, "RENDER_EXTERNAL_URL": BACKEND_URL,
                                     "GESSO_ACCESS_KEY": ACCESS_KEY}, clear=True):
            access = HostedAccess.from_environment()
        self.assertEqual(access.origins, {PUBLIC_URL, BACKEND_URL})
        self.assertTrue(access.authorized(f"{COOKIE_NAME}={access.session()}"))
        self.assertNotIn(ACCESS_KEY, access.cookie())

    def test_public_binding_fails_before_opening_a_socket_without_hosted_access(self):
        with (patch.object(server, "Application", return_value=SimpleNamespace(access=HostedAccess())),
              patch.object(server, "ThreadingHTTPServer") as http_server):
            for host in ("0.0.0.0", "::", "192.0.2.1"):
                with self.subTest(host=host), self.assertRaisesRegex(ValueError, "Public binding requires"):
                    server.serve(host=host)
            http_server.assert_not_called()


if __name__ == "__main__":
    unittest.main()
