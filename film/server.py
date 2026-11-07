"""Single-workspace editor server and a serial persistent render queue."""

import argparse
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import queue
import re
import shutil
import socket
import threading
import time
import traceback
import uuid
from urllib.parse import parse_qs, unquote, urlparse

from . import jobs
from .export_formats import FORMATS, job_format, primary_artifact, validate_format
from .export_execution import execution_summary
from .scene import evaluate, sample_scene, scene_digest, validate_scene
from .scene_objects import resolve_scene_objects
from .stills import create_still_job, run_still_job
from .store import ConflictError, ProjectStore, ROOT, identifier, now
from .worlds import MAX_ASSET_BYTES, import_world, list_worlds, safe_asset_path
from .textures import MAX_TEXTURE_BYTES, import_texture, inspect_texture, read_texture_bytes
from .github_worlds import GitHubWorlds
from .products import PRODUCT_SUFFIX_ERROR, PRODUCT_SUFFIXES, create_product_scene
from .comparison import calibrate_scene, comparison_payload, review_alignment
from .comparison_jobs import ComparisonJobs
from .materials import MaterialLibrary
from .polyhaven import PolyHavenLibrary
from .film_images import import_film_image, MAX_IMAGE_BYTES
from .audio import MAX_AUDIO_BYTES, MIME_TYPES as AUDIO_MIME_TYPES, ffprobe_command, import_audio
from .artwork import import_artwork
from .hosting import HostedAccess, LoginRequired, return_path
from .presets import PresetLibrary
from .world_cleanup import WorldCleanup
from .atlas import AtlasQuickstart
from .atlas_worlds import AtlasWorlds
from .marketplace import Marketplace
from .proofs import NativeProofService
from .capture_schedule import run_scheduled_capture
from .service_limits import ServiceBusyError, ServiceLimits, workspace_server_lock

ARTIFACTS = {"scene.blend", "contact-sheet.png", "still-01.png", "still-02.png", "still-03.png"} | {item[1] for item in FORMATS.values()}
ASSET_NAME = re.compile(r"[0-9a-f]{64}\.(?:glb|spz|ply|png|jpg|jpeg|webp|hdr|mp3|wav|m4a)\Z")


class BoundedHTTPServer(ThreadingHTTPServer):
    """Cap connection threads before reading headers or allocating upload bytes."""

    request_queue_size = 64

    def __init__(self, address, handler, *, limits=None):
        self.limits = limits or ServiceLimits.from_environment()
        self._connections = threading.BoundedSemaphore(self.limits.connections)
        super().__init__(address, handler)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(self.limits.socket_timeout)
        return request, address

    def process_request(self, request, address):
        if not self._connections.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n"
                                b"Retry-After: 2\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self._connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self._connections.release()


def export_filename(value):
    """A filename stem, never a path or a response-header fragment."""
    if not isinstance(value, str):
        raise ValueError("Export filename must be text")
    value = re.sub(r"\.(?:png|jpe?g|webp|mp4|mov|zip|blend)$", "", value.strip(), flags=re.I)
    value = re.sub(r"[^a-zA-Z0-9 _.-]+", "-", value).strip(" .-")[:80].strip(" .-")
    return value or "gesso"


def artifact_download_name(request, name, job):
    stem = export_filename(request.get("filename", "gesso"))
    if name == primary_artifact(job):
        return stem + Path(name).suffix
    if name == "scene.blend":
        return stem + ".blend"
    return stem + "-" + name


class RenderQueue:
    def __init__(self, store, *, base_url, blender="blender", ffmpeg="ffmpeg", limit=8, limits=None):
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError("Render queue limit must be 1–64")
        self.limit = limit
        self.limits = limits or ServiceLimits.from_environment()
        self.store = store
        self.root = store.root / "renders"
        self.root.mkdir(exist_ok=True)
        self.base_url = base_url
        self.blender, self.ffmpeg = blender, ffmpeg
        self.pending = queue.Queue()
        self.lock = threading.RLock()
        self.active = set()
        self.prepared = set()
        self.thread = threading.Thread(target=self._worker, name="render-queue", daemon=True)
        self.thread.start()

    def directory(self, job_id):
        return self.root / identifier(job_id)

    def _request(self, job_id):
        request = json.loads((self.directory(job_id) / "request.json").read_text())
        if (not isinstance(request, dict) or request.get("id") != job_id or request.get("kind") not in ("still", "reel")
                or not isinstance(request.get("createdAt"), str)):
            raise ValueError("Render queue request metadata is invalid")
        return request

    def summary(self, job_id):
        output = self.directory(job_id)
        request = self._request(job_id)
        job = jobs._read_job(output)
        state = job["state"]
        if request.get("pipelineState") in ("failed", "cancelled"):
            state = request["pipelineState"]
        elif job_id in self.active and request.get("stage") == "capturing":
            state = "running"
        elif job_id in self.active and request.get("stage") == "queued":
            # A resumed core manifest retains its previous terminal state until
            # the worker starts. The accepted queue request owns this interval.
            state = "queued"
        elif state in ("running", "queued") and job_id not in self.active and job_id not in self.prepared:
            # A process can still hold the inherited lock. Explicit resume reconciles it.
            state = "interrupted"
        count = sum(end - start + 1 for start, end in job.get("completedRanges", []))
        still = request["kind"] == "still"
        artifacts = []
        if state == "succeeded":
            artifacts = [{"name": name, "url": f"/api/jobs/{job_id}/files/{name}",
                          "downloadName": artifact_download_name(request, name, job),
                          "bytes": record.get("bytes", 0)}
                         for name, record in job.get("artifacts", {}).items() if name in ARTIFACTS]
        errors = job.get("errors", [])
        return {"id": job_id, "kind": request["kind"], "state": state, "stage": request.get("stage"),
                "frame": request.get("frame"), "sourceDigest": job["sceneDigest"],
                "format": job_format(job), "filename": request.get("filename", "gesso"),
                "fps": job["renderProfile"]["fps"], "samples": job["renderProfile"]["samples"],
                "width": job["renderProfile"]["width"], "height": job["renderProfile"]["height"],
                "completedFrames": min(count, 1) if still else count,
                "totalFrames": 1 if still else job["renderProfile"]["frameCount"],
                "error": request.get("error") or (errors[-1]["message"] if errors and state == "failed" else None),
                "artifacts": artifacts, "createdAt": request["createdAt"], "execution": execution_summary(output)}

    def list(self):
        summaries = []
        for path in self.root.glob("*/request.json"):
            try:
                summaries.append(self.summary(path.parent.name))
            except (OSError, ValueError, KeyError):
                continue
        return sorted(summaries, key=lambda item: item["createdAt"], reverse=True)

    def _admit(self, job_id=None):
        if job_id not in self.active | self.prepared and len(self.active | self.prepared) >= self.limit:
            raise ServiceBusyError("The render queue is full. Wait for an export to finish or cancel one.")

    def check_capacity(self, job_ids):
        with self.lock:
            if len(self.active | self.prepared | set(job_ids)) > self.limit:
                raise ServiceBusyError("The render queue is full. Wait for an export to finish or cancel one.")

    def create(self, data, *, enqueue=True):
        # Reserve by holding the same lock through snapshot creation and enqueue.
        # Paired jobs use this reentrant lock and roll both children back on failure.
        with self.lock:
            self._admit()
            return self._create(data, enqueue=enqueue)

    def _create(self, data, *, enqueue=True):
        scene = validate_scene(data["scene"])
        self.limits.check_sampling(scene)
        kind = data.get("kind", "still")
        if kind not in ("still", "reel"):
            raise ValueError("Render kind must be still or reel")
        export_format = validate_format(kind, data.get("format"))
        filename = export_filename(data.get("filename", "gesso"))
        job_id = uuid.uuid4().hex
        output = self.directory(job_id)
        source = self.store.scene_source(scene)
        profile = {"width": data.get("width", 540 if kind == "still" else 270),
                   "height": data.get("height", 960 if kind == "still" else 480),
                   "samples": data.get("samples", 32 if kind == "still" else 8)}
        frame = data.get("frame", 1)
        try:
            if kind == "still":
                create_still_job(source, output, frame=frame, export_format=export_format, **profile)
            else:
                jobs.create_job(source, output, export_format=export_format, **profile)
            jobs._atomic_json(output / "request.json", {"id": job_id, "kind": kind, "frame": frame if kind == "still" else None,
                              "createdAt": now(), "pipelineState": "queued", "stage": "queued", "prepared": not enqueue,
                              "format": export_format, "filename": filename})
        except BaseException:
            shutil.rmtree(output, ignore_errors=True)
            raise
        if not enqueue:
            with self.lock:
                self.prepared.add(job_id)
        if enqueue:
            self.enqueue(job_id)
        return self.summary(job_id)

    def check_resume(self, job_id):
        """Reject a resume while its current worker is still honoring cancellation."""
        with self.lock:
            if job_id in self.active:
                request = self._request(job_id)
                if request.get("pipelineState") == "cancelled" or (self.directory(job_id) / "cancel.requested").exists():
                    raise ConflictError("Cancellation still stopping; resume when stopped")

    def enqueue(self, job_id, *, resume=False):
        with self.lock:
            if resume:
                self.check_resume(job_id)
            if job_id in self.active:
                return
            self._admit(job_id)
            output = self.directory(job_id)
            request = self._request(job_id)
            if resume:
                with jobs._lock(output, ".manifest.lock"):
                    (output / "cancel.requested").unlink(missing_ok=True)
                request.pop("error", None)
            request.update(pipelineState="queued", stage="queued", prepared=False)
            jobs._atomic_json(output / "request.json", request)
            self.prepared.discard(job_id)
            self.active.add(job_id)
            self.pending.put(job_id)

    def cancel(self, job_id):
        with self.lock:
            output = self.directory(job_id)
            jobs.cancel_job(output)
            request = self._request(job_id)
            if jobs._read_job(output)["state"] != "succeeded":
                request.update(pipelineState="cancelled")
                jobs._atomic_json(output / "request.json", request)
            return self.summary(job_id)

    def _worker(self):
        while True:
            job_id = self.pending.get()
            output, request = None, None
            try:
                output = self.directory(job_id)
                request = self._request(job_id)
                with jobs._lock(output, ".pipeline.lock", blocking=False) as pipeline_lock:
                    jobs._check_cancel(output)
                    job = jobs._read_job(output)
                    scene = jobs._verify_snapshots(output, job)
                    selected_frames = ([request["frame"]] if request["kind"] == "still"
                                       else range(1, job["renderProfile"]["frameCount"] + 1))
                    scene_frames = [frame for frame in selected_frames
                                    if any(shot.get("kind", "scene") == "scene" and shot["startFrame"] <= frame <= shot["endFrame"]
                                           for shot in scene["shots"])]
                    if scene["environment"]["kind"] == "splat" and scene_frames:
                        request.update(pipelineState="running", stage="capturing")
                        jobs._atomic_json(output / "request.json", request)
                        asset = scene["environment"]["asset"]
                        profile = job["renderProfile"]
                        command = ["node", str(ROOT / "scripts" / "capture_splats.mjs"), "--url", self.base_url,
                                   "--samples", str(output / "samples.json"), "--output", str(output / "plate"),
                                   "--asset-url", f"/api/assets/{Path(asset['path']).name}",
                                   "--width", str(profile["width"]), "--height", str(profile["height"]),
                                   "--device", profile.get("executionPolicy", {}).get("capture", "software"),
                                   "--source-digest", job["sceneDigest"]]
                        command += ["--frames", ",".join(map(str, scene_frames))]
                        run_scheduled_capture(command, output, "splat-capture.log", worker_fd=pipeline_lock.fileno())
                    jobs._check_cancel(output)
                    request.update(pipelineState="running", stage="rendering")
                    jobs._atomic_json(output / "request.json", request)
                    runner = run_still_job if request["kind"] == "still" else jobs.run_job
                    result = runner(output, blender=self.blender, ffmpeg=self.ffmpeg, reset_cancellation=False)
                    request.update(pipelineState=result["state"], stage="complete" if result["state"] == "succeeded" else result["state"])
            except jobs._Cancelled:
                if isinstance(request, dict):
                    request.update(pipelineState="cancelled", stage="cancelled")
            except BaseException as error:
                message = str(error)
                if isinstance(request, dict):
                    capture_log = output / "splat-capture.log"
                    if request.get("stage") == "capturing" and capture_log.exists():
                        try:
                            with capture_log.open("rb") as handle:
                                handle.seek(max(0, capture_log.stat().st_size - 2000))
                                message += "\n" + handle.read(2000).decode(errors="replace")
                        except OSError:
                            pass
                    request.update(pipelineState="failed", stage="failed", error=message)
                else:
                    # Preserve an unreadable record for repair; never fabricate a
                    # resumable request or stop processing the following job.
                    traceback.print_exc()
            finally:
                if isinstance(request, dict):
                    try:
                        jobs._atomic_json(output / "request.json", request)
                    except (OSError, ValueError, TypeError):
                        traceback.print_exc()
                with self.lock:
                    self.active.discard(job_id)
                self.pending.task_done()


class Application:
    def __init__(self, data_dir, *, port=8787, blender="blender", ffmpeg="ffmpeg", import_blender=None, access=None, limits=None):
        self.limits = limits or ServiceLimits.from_environment()
        self.heavy_requests = threading.BoundedSemaphore(self.limits.heavy_requests)
        self.access = access if access is not None else HostedAccess.from_environment()
        self.store = ProjectStore(data_dir)
        self.store.seed_worlds()
        self.port = port
        self.import_blender = import_blender or os.environ.get("GESSO_IMPORT_BLENDER")
        self.github = GitHubWorlds(self.store.root)
        self.materials = MaterialLibrary(self.store.root)
        self.presets = PresetLibrary(self.store.root)
        self.world_cleanup = WorldCleanup(self.store.root)
        self.atlas = AtlasQuickstart(self.store.root)
        self.atlas_worlds = AtlasWorlds(self.store.root)
        self.marketplace = Marketplace(self.store.root)
        self.polyhaven = PolyHavenLibrary(self.store.root, material_library=self.materials)
        self.renders = RenderQueue(self.store, base_url=f"http://127.0.0.1:{port}", blender=blender, ffmpeg=ffmpeg,
                                   limit=self.limits.render_jobs, limits=self.limits)
        self.comparison_renders = ComparisonJobs(self.renders)
        self._proofs = None
        self._proofs_lock = threading.Lock()
        self._render_capabilities = None
        self._capabilities_lock = threading.Lock()

    @property
    def proofs(self):
        # Bootstrap and ordinary editing never start a native process or create
        # proof storage. The renderer belongs to the first explicit request.
        with self._proofs_lock:
            if self._proofs is None:
                self._proofs = NativeProofService(self.store.root, base_url=lambda: self.renders.base_url,
                                                 blender=self.renders.blender)
            return self._proofs

    def _render_tool_capabilities(self):
        # Match the worker's pinned-version check, once per running application.
        # The lock also avoids duplicate probes from concurrent bootstrap calls.
        with self._capabilities_lock:
            if self._render_capabilities is None:
                result = {}
                for tool, command, version, label in (
                    ("blender", self.renders.blender, jobs.BLENDER_VERSION, "Blender"),
                    ("ffmpeg", self.renders.ffmpeg, jobs.FFMPEG_VERSION, "FFmpeg"),
                ):
                    issue = None
                    if shutil.which(command) is None:
                        issue = f"{label} {version} required; not found."
                    else:
                        try:
                            jobs._check_tool(command, tool, version)
                        except RuntimeError as error:
                            detail = str(error)
                            if detail.startswith("Expected ") and "; found " in detail:
                                found = detail.split("; found ", 1)[1].splitlines()[0][:120]
                                issue = f"{label} {version} required; found {found}."
                            else:
                                issue = f"{label} {version} required; the installed command could not run."
                    result[tool + "Available"] = issue is None
                    result[tool + "Issue"] = issue
                self._render_capabilities = result
            return dict(self._render_capabilities)

    def capabilities(self):
        import os
        tools = self._render_tool_capabilities()
        return {"worldlabsConfigured": bool(os.environ.get("WORLDLABS_API_KEY")),
                "worldCleanupAvailable": True,
                "nativeProofAvailable": tools["blenderAvailable"],
                "githubWorldsAvailable": shutil.which("gh") is not None and (not self.access.enabled or bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))),
                "githubWorkflowUrl": self.github.url,
                "productMeshImportAvailable": shutil.which(self.renders.blender) is not None,
                "productMeshFormats": [suffix[1:] for suffix in PRODUCT_SUFFIXES],
                **tools}


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ProductSuite/0.2"

        def _security(self, mutate=False):
            local_hosts = {f"127.0.0.1:{app.port}", f"localhost:{app.port}"}
            hosts = local_hosts | app.access.hosts
            if self.headers.get("Host") not in hosts:
                raise PermissionError("Use a configured editor address")
            origin = self.headers.get("Origin")
            allowed = {f"http://{host}" for host in local_hosts} | app.access.origins
            if not app.access.enabled:
                allowed |= {"http://localhost:5173", "http://127.0.0.1:5173"}
            if origin and origin not in allowed:
                raise PermissionError("Cross-origin requests are not allowed")
            if mutate and self.headers.get("X-Product-Suite") != "1":
                raise PermissionError("Missing local editor request header")

        def _read_body(self, limit):
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or self.headers.get("Transfer-Encoding") is not None:
                raise ValueError("Provide one Content-Length and no Transfer-Encoding")
            if re.fullmatch(r"[0-9]{1,10}", lengths[0].strip()) is None:
                raise ValueError("Content-Length must contain only decimal digits")
            length = int(lengths[0])
            if length < 1 or length > limit:
                raise ValueError(f"Request body must contain 1–{limit} bytes")
            deadline = time.monotonic() + app.limits.socket_timeout
            chunks, remaining = [], length
            try:
                while remaining:
                    budget = deadline - time.monotonic()
                    if budget <= 0:
                        raise TimeoutError()
                    self.connection.settimeout(budget)
                    chunk = self.rfile.read1(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ValueError("Incomplete request body")
                    chunks.append(chunk)
                    remaining -= len(chunk)
            finally:
                self.connection.settimeout(app.limits.socket_timeout)
            return b"".join(chunks)

        def _body(self, *, binary=False, limit=None):
            limit = limit if limit is not None else (MAX_ASSET_BYTES if binary else 4 * 1024 * 1024)
            expected = "application/octet-stream" if binary else "application/json"
            if self.headers.get("Content-Type", "").split(";")[0] != expected:
                raise ValueError(f"Content-Type must be {expected}")
            payload = self._read_body(limit)
            return payload if binary else json.loads(payload)

        def _json(self, value, status=200, *, retry_after=None):
            payload = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "private,no-store" if app.access.enabled else "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            self.end_headers()
            self.wfile.write(payload)

        def _heavy_admission(self):
            if self._heavy_slot:
                return
            self._heavy_slot = app.heavy_requests.acquire(blocking=False)
            if not self._heavy_slot:
                raise ServiceBusyError("The workspace is preparing other assets. Try again shortly.")

        def _file(self, path, *, immutable=False, download_name=None):
            if not path.is_file():
                raise FileNotFoundError("File not found")
            self.send_response(200)
            mime = {".glb": "model/gltf-binary", ".spz": "application/octet-stream", ".ply": "application/octet-stream",
                    ".blend": "application/octet-stream",
                    **{f".{suffix}": mime for suffix, mime in AUDIO_MIME_TYPES.items()}
                    }.get(path.suffix, mimetypes.guess_type(str(path))[0] or "application/octet-stream")
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Cache-Control", "private,no-store" if app.access.enabled else
                             ("public,max-age=31536000,immutable" if immutable else "no-store"))
            self.send_header("X-Content-Type-Options", "nosniff")
            if download_name or path.suffix == ".blend":
                self.send_header("Content-Disposition", f'attachment; filename="{download_name or "scene.blend"}"')
            self.end_headers()
            with path.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile)

        def _login(self, parsed):
            target = return_path(parse_qs(parsed.query).get("return", ["/"])[0])
            error = ""
            if self.command == "POST":
                if self.headers.get("Origin") not in app.access.origins:
                    raise PermissionError("Open the sign-in page from the configured editor")
                if self.headers.get("Content-Type", "").split(";")[0] != "application/x-www-form-urlencoded":
                    raise ValueError("Expected a small sign-in form")
                fields = parse_qs(self._read_body(4096).decode("utf-8"))
                target = return_path(fields.get("return", ["/"])[0])
                if app.access.matches_key(fields.get("key", [""])[0]):
                    self.send_response(303)
                    self.send_header("Location", target)
                    self.send_header("Set-Cookie", app.access.cookie())
                    self.send_header("Cache-Control", "private,no-store")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                error = "That access key did not match."
            elif self.command != "GET":
                raise ValueError("Unsupported sign-in method")
            payload = ("<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                       "<title>gesso — Studio access</title><style>body{font:16px system-ui,sans-serif;max-width:24rem;margin:15vh auto;padding:1.5rem}"
                       "input,button{font:inherit;padding:.65rem;box-sizing:border-box;width:100%;margin:.6rem 0}p{line-height:1.5}</style>"
                       "<h1>Studio access</h1><p>Enter the workspace access key to open saved projects.</p>"
                       f"<p role=alert>{error}</p><form method=post action=/api/login>"
                       f"<input type=hidden name=return value='{escape(target, quote=True)}'>"
                       "<label>Access key<input type=password name=key required autocomplete=current-password autofocus></label>"
                       "<button>Continue</button></form></html>").encode("utf-8")
            self.send_response(401 if error else 200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "private,no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.send_header("X-Content-Type-Options", "nosniff")
            # Chromium sends Origin:null for a form POST under no-referrer.
            # Keep the same-origin form verifiable without disclosing cross-origin referrers.
            self.send_header("Referrer-Policy", "same-origin")
            self.end_headers()
            self.wfile.write(payload)

        def _dispatch(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            parts = path.strip("/").split("/")
            # Health probes reveal no workspace, provider or tool information.
            if self.command == "GET" and path == "/api/health":
                return self._json({"status": "ok"})
            mutate = self.command in ("POST", "PUT")
            login = app.access.enabled and path == "/api/login"
            self._security(mutate and not login)
            if login:
                return self._login(parsed)
            # Approved catalog metadata and covers are public. Submission,
            # moderation and downloads retain the workspace access boundary.
            if self.command == "GET":
                if path == "/api/marketplace":
                    return self._json(app.marketplace.list())
                if len(parts) in (3, 4) and parts[:2] == ["api", "marketplace"] and parts[2].startswith("listing-"):
                    if len(parts) == 3:
                        return self._json(app.marketplace.detail(parts[2]))
                    if parts[3] == "preview":
                        return self._file(app.marketplace.preview(parts[2]))
            if path.startswith("/api/") and not app.access.authorized(self.headers.get("Cookie")):
                raise LoginRequired()
            if self.command == "GET":
                if path == "/api/marketplace/submissions":
                    return self._json(app.marketplace.submissions())
                if len(parts) == 4 and parts[:2] == ["api", "marketplace"] and parts[3] == "download":
                    asset = app.marketplace.download(parts[2])
                    return self._file(asset, download_name=f"{identifier(parts[2])}{asset.suffix}")
                if path == "/api/bootstrap":
                    return self._json({"project": app.store.bootstrap(), "projects": app.store.list(),
                                       "worlds": list_worlds(app.store.root, include_archived=False), "capabilities": app.capabilities(), "jobs": app.renders.list()})
                if path == "/api/polyhaven/assets":
                    query = parse_qs(parsed.query)
                    return self._json(app.polyhaven.list_assets(query.get("kind", ["textures"])[0],
                        query=query.get("q", [""])[0], offset=int(query.get("offset", ["0"])[0]),
                        limit=int(query.get("limit", ["24"])[0])))
                if path == "/api/materials":
                    return self._json(app.materials.list())
                if path == "/api/presets":
                    return self._json(app.presets.list())
                if len(parts) == 5 and parts[:2] == ["api", "world-cleanup"] and parts[3] == "regions":
                    return self._json(app.world_cleanup.selection(parts[2], parts[4]))
                if len(parts) == 3 and parts[:2] == ["api", "presets"]:
                    return self._json(app.presets.get(parts[2]))
                if len(parts) == 4 and parts[:3] == ["api", "materials", "jobs"]:
                    return self._json(app.materials.get(parts[3]))
                if path == "/api/worldlabs/status":
                    return self._json({"configured": app.capabilities()["worldlabsConfigured"]})
                if path == "/api/atlas/status":
                    return self._json(app.atlas.status())
                if path == "/api/atlas/quickstart":
                    return self._json(app.atlas.list())
                if path == "/api/atlas/worlds":
                    return self._json(app.atlas_worlds.list())
                if len(parts) == 6 and parts[:3] == ["api", "atlas", "worlds"]:
                    if parts[3] == "guides" and parts[5] == "reference":
                        return self._file(app.atlas_worlds.guide_reference(parts[4]))
                    if parts[4] == "views":
                        return self._file(app.atlas_worlds.view(parts[3], parts[5]))
                    if parts[4] == "concepts":
                        return self._file(app.atlas_worlds.concept(parts[3], parts[5]))
                if len(parts) == 6 and parts[:3] == ["api", "atlas", "quickstart"] and parts[4] == "assets":
                    asset = app.atlas.asset(parts[3], parts[5])
                    return self._file(asset, download_name="atlas-depth.exr" if parts[5] == "depth" else None)
                if path == "/api/github-worlds/runs":
                    return self._json(app.github.runs())
                if path == "/api/worlds":
                    return self._json(list_worlds(app.store.root, include_archived=False))
                if path == "/api/projects":
                    return self._json(app.store.list())
                if path == "/api/jobs":
                    return self._json(app.renders.list())
                if path == "/api/comparison-renders":
                    return self._json(app.comparison_renders.list())
                if len(parts) == 3 and parts[:2] == ["api", "proofs"]:
                    return self._json(app.proofs.summary(parts[2]))
                if len(parts) == 4 and parts[:2] == ["api", "proofs"] and parts[3] == "image.png":
                    return self._file(app.proofs.artifact(parts[2]))
                if len(parts) == 3 and parts[:2] == ["api", "projects"]:
                    return self._json(app.store.get(parts[2]))
                if len(parts) == 5 and parts[:2] == ["api", "projects"] and parts[3] == "revisions":
                    return self._json(app.store.get(parts[2], parts[4]))
                if len(parts) == 3 and parts[:2] == ["api", "jobs"]:
                    return self._json(app.renders.summary(parts[2]))
                if len(parts) == 3 and parts[:2] == ["api", "comparison-renders"]:
                    return self._json(app.comparison_renders.summary(parts[2]))
                if len(parts) == 5 and parts[:2] == ["api", "comparison-renders"] and parts[3] == "files":
                    return self._file(app.comparison_renders.artifact(parts[2], parts[4]))
                if len(parts) == 5 and parts[:2] == ["api", "jobs"] and parts[3] == "files":
                    if parts[4] not in ARTIFACTS or app.renders.summary(parts[2])["state"] != "succeeded":
                        raise ValueError("Artifact is not available from a successful job")
                    directory = app.renders.directory(parts[2])
                    job = jobs._read_job(directory)
                    record = job.get("artifacts", {}).get(parts[4])
                    artifact = directory / parts[4]
                    if (not record or artifact.is_symlink() or not artifact.is_file()
                            or artifact.stat().st_size != record.get("bytes") or jobs._sha256(artifact) != record.get("sha256")):
                        raise ValueError("Artifact changed or is unavailable; resume the job to rebuild it")
                    request = app.renders._request(parts[2])
                    return self._file(artifact, download_name=artifact_download_name(request, parts[4], job)
                                      if parse_qs(parsed.query).get("download") == ["1"] else None)
                if len(parts) == 3 and parts[:2] == ["api", "assets"]:
                    if not ASSET_NAME.fullmatch(parts[2]):
                        raise ValueError("Invalid immutable asset name")
                    asset = safe_asset_path(app.store.root, f"assets/{parts[2]}")
                    if jobs._sha256(asset) != parts[2].split(".")[0]:
                        raise ValueError("World asset was modified")
                    if asset.suffix == ".jpg":
                        # Only label artwork uses .jpg. PNGs are shared with material
                        # maps and film images, whose larger limits were checked on import.
                        inspect_texture(read_texture_bytes(asset), "jpg")
                    return self._file(asset, immutable=True)
                if path.startswith("/api/"):
                    return self._json({"error": "Unknown API route"}, 404)
                dist = (ROOT / "web" / "dist").resolve()
                selected = (dist / path.lstrip("/")).resolve()
                if not selected.is_relative_to(dist):
                    raise PermissionError("Invalid static path")
                if not selected.is_file():
                    selected = dist / "index.html"
                if not selected.exists():
                    return self._json({"error": "Build the editor first: cd web && npm ci && npm run build"}, 503)
                return self._file(selected)
            if self.command == "POST" and path == "/api/artwork/import":
                return self._json(import_artwork(self._body(binary=True, limit=MAX_IMAGE_BYTES),
                                  self.headers.get("X-Asset-Filename", ""), app.store.root), 201)
            if self.command == "POST" and path == "/api/film/images/import":
                return self._json(import_film_image(self._body(binary=True, limit=MAX_IMAGE_BYTES),
                                  self.headers.get("X-Asset-Filename", ""), app.store.root), 201)
            if self.command == "POST" and path == "/api/audio/import":
                return self._json(import_audio(self._body(binary=True, limit=MAX_AUDIO_BYTES),
                                  self.headers.get("X-Asset-Filename", ""), app.store.root,
                                  ffprobe=ffprobe_command(app.renders.ffmpeg)), 201)
            if self.command == "POST" and path == "/api/textures/import":
                payload = self._body(binary=True, limit=MAX_TEXTURE_BYTES)
                return self._json(import_texture(payload, app.store.root,
                                                filename=unquote(self.headers.get("X-Asset-Filename", ""))), 201)
            if self.command == "POST" and path == "/api/products/import":
                payload = self._body(binary=True)
                query = parse_qs(parsed.query)
                one = lambda name, default="": query.get(name, [default])[0]
                suffix = Path(self.headers.get("X-Asset-Filename", "")).suffix.lower()
                if suffix not in PRODUCT_SUFFIXES:
                    raise ValueError(PRODUCT_SUFFIX_ERROR)
                temporary = app.store.root / f"product-import-{uuid.uuid4().hex}"
                temporary.mkdir()
                try:
                    source = temporary / f"source{suffix}"
                    source.write_bytes(payload)
                    provenance = {"source": one("source", "Product model supplied through the local editor"),
                                  "owner": one("owner"), "reuseBasis": one("reuseBasis"),
                                  "allowedExternalDestinations": []}
                    # PLY uses main's mesh normalizer, which is pinned to the renderer's Blender 4.3.2.
                    scene = create_product_scene(source, temporary / "prepared", name=one("name", "Imported product"),
                                                 provenance=provenance,
                                                 blender=app.renders.blender if suffix == ".ply" else app.import_blender or app.renders.blender,
                                                 source_up=one("sourceUp", "z"), source_units=one("sourceUnits") or None)
                    imported = app.store.create(one("name", "Imported product"), scene,
                                                source_dir=temporary / "prepared")
                finally:
                    shutil.rmtree(temporary)
                return self._json(imported, 201)
            if self.command == "POST" and path == "/api/worlds/import":
                payload = self._body(binary=True)
                query = parse_qs(parsed.query)
                one = lambda name, default="": query.get(name, [default])[0]
                suffix = Path(self.headers.get("X-Asset-Filename", "")).suffix.lower()
                if suffix not in (".glb", ".spz", ".ply"):
                    raise ValueError("Upload a visual GLB mesh or SPZ/PLY Gaussian splat")
                temp = app.store.root / f"import-{uuid.uuid4().hex}{suffix}"
                try:
                    temp.write_bytes(payload)
                    provenance = {"source": "Manual world export supplied through the local editor", "owner": one("owner"),
                                  "reuseBasis": one("reuseBasis"), "allowedExternalDestinations": []}
                    entry = import_world(temp, app.store.root, name=one("name", "Imported world"), provenance=provenance,
                                         source_up=one("sourceUp", "Y"), scale_to_meters=float(one("scaleToMeters", "1")))
                finally:
                    temp.unlink(missing_ok=True)
                return self._json(entry, 201)
            body = self._body()
            if self.command == "POST":
                if path == "/api/marketplace/submissions":
                    return self._json(app.marketplace.submit_saved(body), 202)
                if len(parts) == 5 and parts[:3] == ["api", "marketplace", "submissions"] and parts[4] == "withdraw":
                    return self._json(app.marketplace.withdraw(parts[3]))
                if path == "/api/atlas/quickstart":
                    return self._json(app.atlas.submit(body["imageUrl"]), 202)
                if path == "/api/atlas/worlds":
                    return self._json(app.atlas_worlds.submit(body), 202)
                if len(parts) == 5 and parts[:3] == ["api", "atlas", "worlds"]:
                    if parts[4] == "sharing":
                        return self._json(app.atlas_worlds.set_sharing(parts[3], body))
                    if parts[4] == "references":
                        return self._json(app.atlas_worlds.select_concept(parts[3], body), 202)
                    if parts[4] == "refresh":
                        return self._json(app.atlas_worlds.refresh(parts[3]))
                    if parts[4] == "revise":
                        return self._json(app.atlas_worlds.revise(parts[3], body), 202)
                    if parts[4] in ("draft", "refine"):
                        return self._json(app.atlas_worlds.reconstruct(parts[3], parts[4]), 202)
                if len(parts) == 5 and parts[:3] == ["api", "atlas", "quickstart"] and parts[4] == "refresh":
                    return self._json(app.atlas.refresh(parts[3]))
                if path == "/api/proofs":
                    app.limits.check_sampling(validate_scene(body["scene"]))
                    return self._json(app.proofs.submit(body), 202)
                if path == "/api/proofs/session/cancel":
                    return self._json(app.proofs.cancel_session(body.get("sessionId"), body.get("sequence")))
                if len(parts) == 4 and parts[:2] == ["api", "proofs"] and parts[3] == "cancel":
                    return self._json(app.proofs.cancel(parts[2]))
                if path in ("/api/world-cleanup/analyze", "/api/world-cleanup/preview"):
                    from .worlds import verify_scene_assets
                    scene = validate_scene(body["scene"])
                    verify_scene_assets(scene, app.store.root)
                    if path.endswith("/analyze"):
                        return self._json(app.world_cleanup.analyze(scene["environment"], body.get("options")))
                    result = app.world_cleanup.preview(scene["environment"], body)
                    # Repair is provisional. Reuse normal scene/asset validation
                    # before allowing its immutable environment into the editor.
                    checked = validate_scene({**scene, "environment": result["environment"]})
                    verify_scene_assets(checked, app.store.root)
                    return self._json({**result, "environment": checked["environment"]})
                if path == "/api/presets":
                    return self._json(app.presets.create(body.get("name"), body.get("scopes"), body["scene"]), 201)
                if path == "/api/presets/query":
                    return self._json(app.presets.list(body["scene"]))
                if len(parts) == 4 and parts[:2] == ["api", "presets"] and parts[3] == "apply":
                    return self._json(app.presets.apply(parts[2], body.get("scopes"), body["scene"]))
                if path == "/api/polyhaven/import":
                    return self._json(app.polyhaven.import_asset(body["kind"], body["id"]), 201)
                if path == "/api/materials/generate":
                    return self._json(app.materials.create(body), 202)
                if len(parts) == 5 and parts[:3] == ["api", "materials", "jobs"] and parts[4] == "cancel":
                    return self._json(app.materials.cancel(parts[3]))
                if path == "/api/github-worlds/generate":
                    return self._json(app.github.dispatch(body), 202)
                if len(parts) == 5 and parts[:3] == ["api", "github-worlds", "runs"] and parts[4] == "import":
                    return self._json(app.github.import_run(parts[3]))
                if path == "/api/evaluate":
                    scene = validate_scene(body["scene"])
                    if "frame" in body:
                        # Interactive transforms need only the visible pose. Keep
                        # the canonical sampler and validation shared with export.
                        return self._json({"scene": scene, "sample": evaluate(
                            scene, body["frame"], include_placement=body.get("includePlacement") is True),
                                           "digest": scene_digest(scene)})
                    app.limits.check_sampling(scene)
                    self._heavy_admission()
                    result = {**sample_scene(scene), "digest": scene_digest(scene), "objects": resolve_scene_objects(scene)}
                    payload = comparison_payload(scene) if "comparison" in scene else None
                    if payload:
                        result["comparison"] = payload
                    return self._json(result)
                if path == "/api/scene-objects/frame":
                    from .object_editing import frame_scene_objects
                    return self._json({"scene": frame_scene_objects(body["scene"])})
                if path == "/api/comparison/calibrate":
                    return self._json({"scene": calibrate_scene(body["scene"], body["side"], body["calibration"])})
                if path == "/api/comparison/review":
                    return self._json({"scene": review_alignment(body["scene"])})
                if path == "/api/projects":
                    return self._json(app.store.create(body.get("name", "New campaign"), body.get("scene")), 201)
                if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "approve":
                    return self._json(app.store.approve(parts[2], body.get("expectedRevisionId")))
                if path == "/api/renders":
                    return self._json(app.renders.create(body), 202)
                if path == "/api/comparison-renders":
                    return self._json(app.comparison_renders.create(body), 202)
                if len(parts) == 4 and parts[:2] == ["api", "comparison-renders"]:
                    if parts[3] == "cancel":
                        return self._json(app.comparison_renders.cancel(parts[2]))
                    if parts[3] == "resume":
                        return self._json(app.comparison_renders.resume(parts[2]), 202)
                if len(parts) == 4 and parts[:2] == ["api", "jobs"]:
                    if parts[3] == "cancel":
                        return self._json(app.renders.cancel(parts[2]))
                    if parts[3] == "resume":
                        app.renders.enqueue(parts[2], resume=True)
                        return self._json(app.renders.summary(parts[2]), 202)
            if self.command == "PUT" and len(parts) == 3 and parts[:2] == ["api", "projects"]:
                return self._json(app.store.save(parts[2], body["scene"], body.get("expectedRevisionId"), body.get("name")))
            return self._json({"error": "Unknown API route"}, 404)

        def _handle(self):
            self._heavy_slot = False
            try:
                # Hold the slot before reading large uploads or starting native
                # conversion/snapshot work. It is always released on disconnect.
                path = unquote(urlparse(self.path).path)
                heavy = self.command == "POST" and (path.endswith("/import") or path in (
                    "/api/renders", "/api/comparison-renders", "/api/world-cleanup/analyze", "/api/world-cleanup/preview"))
                if heavy:
                    self._security(mutate=True)
                    if not app.access.authorized(self.headers.get("Cookie")):
                        raise LoginRequired()
                    self._heavy_admission()
                self._dispatch()
            except ServiceBusyError as error:
                self._json({"error": str(error)}, 503, retry_after=2)
            except ConflictError as error:
                self._json({"error": str(error)}, 409)
            except LoginRequired:
                self._json({"error": "Sign in to this workspace", "loginUrl": "/api/login"}, 401)
            except FileNotFoundError:
                self._json({"error": "Record or asset not found"}, 404)
            except PermissionError as error:
                self._json({"error": str(error)}, 403)
            except (ValueError, TypeError, KeyError) as error:
                self._json({"error": str(error)}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (TimeoutError, socket.timeout):
                self.close_connection = True
                try:
                    self._json({"error": "Request timed out before it completed."}, 408)
                except OSError:
                    pass
            except Exception as error:
                if app.access.enabled:
                    traceback.print_exc()
                    self._json({"error": "The workspace could not complete this request. Check the server logs."}, 500)
                else:
                    self._json({"error": f"Local server error: {type(error).__name__}: {error}"}, 500)
            finally:
                if self._heavy_slot:
                    app.heavy_requests.release()

        do_GET = _handle
        do_POST = _handle
        do_PUT = _handle

    return Handler


def serve(data_dir="workspace-data", *, host="127.0.0.1", port=8787, blender="blender", ffmpeg="ffmpeg", import_blender=None):
    access = HostedAccess.from_environment()
    limits = ServiceLimits.from_environment()
    if host not in ("127.0.0.1", "localhost") and not access.enabled:
        raise ValueError("Public binding requires GESSO_PUBLIC_URL and GESSO_ACCESS_KEY")
    with workspace_server_lock(data_dir):
        app = Application(data_dir, port=port, blender=blender, ffmpeg=ffmpeg, import_blender=import_blender,
                          access=access, limits=limits)
        server = BoundedHTTPServer((host, port), make_handler(app), limits=limits)
        app.port = server.server_port
        app.renders.base_url = f"http://127.0.0.1:{app.port}"
        print(f"gesso editor: {app.access.public_url or f'http://127.0.0.1:{app.port}'}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Stopping editor server. Interrupted jobs remain resumable.", flush=True)
        finally:
            if app._proofs is not None:
                app._proofs.close()
            server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="workspace-data")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    serve(args.data_dir, host=args.host, port=args.port)
