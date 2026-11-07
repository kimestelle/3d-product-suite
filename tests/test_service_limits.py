"""Admission and worker-failure checks using real sockets and saved job snapshots."""

import http.client
from http.server import BaseHTTPRequestHandler
import io
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from film import jobs, server
from film.hosting import HostedAccess
from film.scene import load_scene
from film.service_limits import ServiceBusyError, ServiceLimits, workspace_server_lock
from film.store import ProjectStore, ROOT


class ServiceLimitTests(unittest.TestCase):
    def start(self, handler, limits):
        http = server.BoundedHTTPServer(("127.0.0.1", 0), handler, limits=limits)
        thread = threading.Thread(target=lambda: http.serve_forever(poll_interval=.01), daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        return http

    def test_environment_limits_are_bounded_and_fail_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ServiceLimits.from_environment(), ServiceLimits())
        for name, value in (("GESSO_HTTP_MAX_CONNECTIONS", "0"), ("GESSO_HTTP_MAX_CONNECTIONS", "129"),
                            ("GESSO_HTTP_TIMEOUT_SECONDS", "121"), ("GESSO_HEAVY_REQUESTS", "five"),
                            ("GESSO_RENDER_QUEUE_LIMIT", "65"), ("GESSO_RENDER_QUEUE_LIMIT", "-1"),
                            ("GESSO_MAX_SAMPLED_FRAMES", "9007199254740991"), ("GESSO_MAX_SAMPLED_PART_FRAMES", "999999999")):
            with self.subTest(name=name,value=value), patch.dict(os.environ, {name:value}, clear=True), self.assertRaisesRegex(ValueError, name):
                ServiceLimits.from_environment()

    def test_workspace_lease_rejects_another_server_before_starting_paid_workers(self):
        with tempfile.TemporaryDirectory() as folder:
            with workspace_server_lock(folder), patch.object(server, "Application") as application:
                with self.assertRaisesRegex(RuntimeError, "Another server owns"):
                    server.serve(data_dir=folder)
                application.assert_not_called()
            with workspace_server_lock(folder):
                pass

    def test_connection_pool_rejects_excess_then_releases_its_lease(self):
        entered, release = threading.Event(), threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/wait":
                    entered.set()
                    release.wait(2)
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()
            def log_message(self, *args):
                pass
        http = self.start(Handler, ServiceLimits(connections=1))
        first = http_client(http)
        self.addCleanup(first.close)
        first.request("GET", "/wait")
        self.assertTrue(entered.wait(1))
        second = http_client(http)
        self.addCleanup(second.close)
        second.request("GET", "/")
        response = second.getresponse()
        self.assertEqual(response.status, 503)
        self.assertEqual(response.getheader("Retry-After"), "2")
        response.read()
        release.set()
        self.assertEqual(first.getresponse().status, 200)
        deadline = time.monotonic()+1
        while not http._connections.acquire(blocking=False):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        http._connections.release()
        third = http_client(http)
        self.addCleanup(third.close)
        third.request("GET", "/")
        self.assertEqual(third.getresponse().status, 200)

    def test_stalled_body_times_out_and_releases_heavy_admission(self):
        app = SimpleNamespace(access=HostedAccess(), limits=ServiceLimits(socket_timeout=.1),
                              heavy_requests=threading.BoundedSemaphore(1), port=0)
        handler = server.make_handler(app)
        handler.log_message = lambda *args: None
        http = self.start(handler, app.limits)
        app.port = http.server_port
        connection = http_client(http)
        self.addCleanup(connection.close)
        connection.putrequest("POST", "/api/worlds/import")
        connection.putheader("X-Product-Suite", "1")
        connection.putheader("Content-Type", "application/octet-stream")
        connection.putheader("Content-Length", "128")
        connection.endheaders()
        started = time.monotonic()
        response = connection.getresponse()
        self.assertEqual(response.status, 408)
        self.assertLess(time.monotonic()-started, 1.5)
        response.read()
        self.assertTrue(app.heavy_requests.acquire(timeout=1))
        app.heavy_requests.release()


def http_client(instance):
    return http.client.HTTPConnection("127.0.0.1", instance.server_port, timeout=3)


class RenderAdmissionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = ProjectStore(Path(temporary.name)/"data")
        with patch.object(server.RenderQueue, "_worker", return_value=None):
            self.queue = server.RenderQueue(self.store, base_url="http://127.0.0.1:8787", limit=1)
            self.queue.thread.join(1)
        self.data = {"scene":load_scene(ROOT/"examples/bottle.scene.json"),"kind":"still","frame":1,"width":4,"height":6,"samples":1}

    def test_full_queue_cannot_copy_more_assets_or_clear_an_interrupted_cancel(self):
        first = self.queue.create(self.data)
        before = sorted(path.name for path in self.queue.root.iterdir())
        with patch.object(self.store, "scene_source", side_effect=AssertionError("No extra snapshots")), self.assertRaises(ServiceBusyError):
            self.queue.create(self.data)
        self.assertEqual(sorted(path.name for path in self.queue.root.iterdir()), before)
        self.queue.cancel(first["id"])
        self.queue.active.discard(first["id"])
        self.queue.create(self.data)
        with self.assertRaises(ServiceBusyError):
            self.queue.enqueue(first["id"], resume=True)
        self.assertTrue((self.queue.directory(first["id"])/"cancel.requested").exists())

    def test_unbounded_movie_is_rejected_before_preparing_any_snapshot(self):
        self.data["scene"]["render"]["durationFrames"] = 9007199254740991
        with patch.object(self.store, "scene_source", side_effect=AssertionError("No eager timeline")), self.assertRaisesRegex(ValueError, "3600 frames"):
            self.queue.create(self.data)
        self.assertEqual(list(self.queue.root.iterdir()), [])
        self.assertEqual(self.queue.active, set())

    def test_part_frame_work_is_bounded_without_reducing_export_quality(self):
        self.queue.limits = ServiceLimits(sampled_part_frames=100)
        with patch.object(self.store, "scene_source", side_effect=AssertionError("No eager timeline")), self.assertRaisesRegex(ValueError, "sampled part budget"):
            self.queue.create(self.data)
        self.assertEqual(list(self.queue.root.iterdir()), [])

    def test_corrupt_queued_record_cannot_kill_the_worker_or_discard_the_next_job(self):
        self.queue.limit = 2
        first, second = self.queue.create(self.data), self.queue.create(self.data)
        first_path = self.queue.directory(first["id"])/"request.json"
        first_path.write_text("[]")
        original = first_path.read_bytes()
        class Finished(Exception):
            pass
        with (patch.object(self.queue.pending, "get", side_effect=[first["id"],second["id"],Finished()]),
              patch.object(server, "run_still_job", return_value={"state":"succeeded"}) as render,
              patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(Finished)):
            self.queue._worker()
        render.assert_called_once()
        self.assertEqual(render.call_args.args[0], self.queue.directory(second["id"]))
        self.assertEqual(self.queue._request(second["id"])["stage"], "complete")
        self.assertEqual(first_path.read_bytes(), original)
        self.assertEqual(self.queue.pending.unfinished_tasks, 0)
        self.assertEqual(self.queue.active, set())
        self.assertEqual([job["id"] for job in self.queue.list()], [second["id"]])
