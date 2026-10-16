"""Single-user loopback editor server and a serial local render queue."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import queue
import re
import shutil
import threading
import uuid
from urllib.parse import parse_qs, unquote, urlparse

from . import jobs
from .scene import sample_scene, scene_digest, validate_scene
from .stills import create_still_job, run_still_job
from .store import ConflictError, ProjectStore, ROOT, identifier, now
from .worlds import MAX_ASSET_BYTES, import_world, list_worlds
from .github_worlds import GitHubWorlds
from .products import create_product_scene
from .comparison import calibrate_scene, comparison_payload, review_alignment
from .comparison_jobs import ComparisonJobs

ARTIFACTS = {"still.png", "film.mp4", "scene.blend", "contact-sheet.png", "still-01.png", "still-02.png", "still-03.png"}
ASSET_NAME = re.compile(r"[0-9a-f]{64}\.(?:glb|spz|ply)\Z")


class RenderQueue:
    def __init__(self, store, *, base_url, blender="blender", ffmpeg="ffmpeg"):
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
        return json.loads((self.directory(job_id) / "request.json").read_text())

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
            artifacts = [{"name": name, "url": f"/api/jobs/{job_id}/files/{name}"}
                         for name in job.get("artifacts", {}) if name in ARTIFACTS]
        errors = job.get("errors", [])
        return {"id": job_id, "kind": request["kind"], "state": state, "stage": request.get("stage"),
                "frame": request.get("frame"), "sourceDigest": job["sceneDigest"],
                "width": job["renderProfile"]["width"], "height": job["renderProfile"]["height"],
                "completedFrames": min(count, 1) if still else count,
                "totalFrames": 1 if still else job["renderProfile"]["frameCount"],
                "error": request.get("error") or (errors[-1]["message"] if errors and state == "failed" else None),
                "artifacts": artifacts, "createdAt": request["createdAt"]}

    def list(self):
        summaries = []
        for path in self.root.glob("*/request.json"):
            try:
                summaries.append(self.summary(path.parent.name))
            except (OSError, ValueError, KeyError):
                continue
        return sorted(summaries, key=lambda item: item["createdAt"], reverse=True)

    def create(self, data, *, enqueue=True):
        scene = validate_scene(data["scene"])
        kind = data.get("kind", "still")
        if kind not in ("still", "reel"):
            raise ValueError("Render kind must be still or reel")
        job_id = uuid.uuid4().hex
        output = self.directory(job_id)
        source = self.store.scene_source(scene)
        profile = {"width": data.get("width", 540 if kind == "still" else 270),
                   "height": data.get("height", 960 if kind == "still" else 480),
                   "samples": data.get("samples", 32 if kind == "still" else 8)}
        frame = data.get("frame", 1)
        try:
            if kind == "still":
                create_still_job(source, output, frame=frame, **profile)
            else:
                jobs.create_job(source, output, **profile)
            jobs._atomic_json(output / "request.json", {"id": job_id, "kind": kind, "frame": frame if kind == "still" else None,
                              "createdAt": now(), "pipelineState": "queued", "stage": "queued", "prepared": not enqueue})
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
            output = self.directory(job_id)
            request = self._request(job_id)
            try:
                with jobs._lock(output, ".pipeline.lock", blocking=False) as pipeline_lock:
                    jobs._check_cancel(output)
                    job = jobs._read_job(output)
                    scene = jobs._verify_snapshots(output, job)
                    if scene["environment"]["kind"] == "splat":
                        request.update(pipelineState="running", stage="capturing")
                        jobs._atomic_json(output / "request.json", request)
                        asset = scene["environment"]["asset"]
                        profile = job["renderProfile"]
                        command = ["node", str(ROOT / "scripts" / "capture_splats.mjs"), "--url", self.base_url,
                                   "--samples", str(output / "samples.json"), "--output", str(output / "plate"),
                                   "--asset-url", f"/api/assets/{Path(asset['path']).name}",
                                   "--width", str(profile["width"]), "--height", str(profile["height"]),
                                   "--source-digest", job["sceneDigest"]]
                        if request["kind"] == "still":
                            command += ["--frames", str(request["frame"])]
                        jobs._run_process(command, output, "splat-capture.log", worker_fd=pipeline_lock.fileno())
                    jobs._check_cancel(output)
                    request.update(pipelineState="running", stage="rendering")
                    jobs._atomic_json(output / "request.json", request)
                    runner = run_still_job if request["kind"] == "still" else jobs.run_job
                    result = runner(output, blender=self.blender, ffmpeg=self.ffmpeg, reset_cancellation=False)
                    request.update(pipelineState=result["state"], stage="complete" if result["state"] == "succeeded" else result["state"])
            except jobs._Cancelled:
                request.update(pipelineState="cancelled", stage="cancelled")
            except BaseException as error:
                message = str(error)
                capture_log = output / "splat-capture.log"
                if request.get("stage") == "capturing" and capture_log.exists():
                    message += "\n" + capture_log.read_text(errors="replace")[-2000:]
                request.update(pipelineState="failed", stage="failed", error=message)
            finally:
                jobs._atomic_json(output / "request.json", request)
                with self.lock:
                    self.active.discard(job_id)
                self.pending.task_done()


class Application:
    def __init__(self, data_dir, *, port=8787, blender="blender", ffmpeg="ffmpeg"):
        self.store = ProjectStore(data_dir)
        self.store.seed_worlds()
        self.port = port
        self.github = GitHubWorlds(self.store.root)
        self.renders = RenderQueue(self.store, base_url=f"http://127.0.0.1:{port}", blender=blender, ffmpeg=ffmpeg)
        self.comparison_renders = ComparisonJobs(self.renders)

    def capabilities(self):
        import os
        return {"worldlabsConfigured": bool(os.environ.get("WORLDLABS_API_KEY")),
                "githubWorldsAvailable": shutil.which("gh") is not None,
                "githubWorkflowUrl": self.github.url,
                "blenderAvailable": shutil.which(self.renders.blender) is not None,
                "ffmpegAvailable": shutil.which(self.renders.ffmpeg) is not None}


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ProductSuite/0.2"

        def _security(self, mutate=False):
            hosts = {f"127.0.0.1:{app.port}", f"localhost:{app.port}"}
            if self.headers.get("Host") not in hosts:
                raise PermissionError("Use the local editor address")
            origin = self.headers.get("Origin")
            allowed = {f"http://{host}" for host in hosts} | {"http://localhost:5173", "http://127.0.0.1:5173"}
            if origin and origin not in allowed:
                raise PermissionError("Cross-origin requests are not allowed")
            if mutate and self.headers.get("X-Product-Suite") != "1":
                raise PermissionError("Missing local editor request header")

        def _body(self, *, binary=False):
            limit = MAX_ASSET_BYTES if binary else 4 * 1024 * 1024
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > limit:
                raise ValueError(f"Request body must contain 1–{limit} bytes")
            expected = "application/octet-stream" if binary else "application/json"
            if self.headers.get("Content-Type", "").split(";")[0] != expected:
                raise ValueError(f"Content-Type must be {expected}")
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise ValueError("Incomplete request body")
            return payload if binary else json.loads(payload)

        def _json(self, value, status=200):
            payload = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)

        def _file(self, path, *, immutable=False):
            if not path.is_file():
                raise FileNotFoundError("File not found")
            self.send_response(200)
            mime = {".glb": "model/gltf-binary", ".spz": "application/octet-stream", ".ply": "application/octet-stream",
                    ".blend": "application/octet-stream"}.get(path.suffix, mimetypes.guess_type(str(path))[0] or "application/octet-stream")
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Cache-Control", "public,max-age=31536000,immutable" if immutable else "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if path.suffix == ".blend":
                self.send_header("Content-Disposition", 'attachment; filename="scene.blend"')
            self.end_headers()
            with path.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile)

        def _dispatch(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            parts = path.strip("/").split("/")
            mutate = self.command in ("POST", "PUT")
            self._security(mutate)
            if self.command == "GET":
                if path == "/api/bootstrap":
                    return self._json({"project": app.store.bootstrap(), "projects": app.store.list(),
                                       "worlds": list_worlds(app.store.root), "capabilities": app.capabilities(), "jobs": app.renders.list()})
                if path == "/api/worldlabs/status":
                    return self._json({"configured": app.capabilities()["worldlabsConfigured"]})
                if path == "/api/github-worlds/runs":
                    return self._json(app.github.runs())
                if path == "/api/worlds":
                    return self._json(list_worlds(app.store.root))
                if path == "/api/projects":
                    return self._json(app.store.list())
                if path == "/api/jobs":
                    return self._json(app.renders.list())
                if path == "/api/comparison-renders":
                    return self._json(app.comparison_renders.list())
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
                    return self._file(app.renders.directory(parts[2]) / parts[4])
                if len(parts) == 3 and parts[:2] == ["api", "assets"]:
                    if not ASSET_NAME.fullmatch(parts[2]):
                        raise ValueError("Invalid immutable asset name")
                    asset = app.store.root / "assets" / parts[2]
                    if jobs._sha256(asset) != parts[2].split(".")[0]:
                        raise ValueError("World asset was modified")
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
            if self.command == "POST" and path == "/api/products/import":
                payload = self._body(binary=True)
                query = parse_qs(parsed.query)
                one = lambda name, default="": query.get(name, [default])[0]
                if Path(self.headers.get("X-Asset-Filename", "")).suffix.lower() != ".glb":
                    raise ValueError("Upload a self-contained product GLB in meters, centered at its bounding-box origin")
                temporary = app.store.root / f"product-import-{uuid.uuid4().hex}"
                temporary.mkdir()
                try:
                    source = temporary / "source.glb"
                    source.write_bytes(payload)
                    provenance = {"source": one("source", "Product GLB supplied through the local editor"),
                                  "owner": one("owner"), "reuseBasis": one("reuseBasis"),
                                  "allowedExternalDestinations": []}
                    scene = create_product_scene(source, temporary / "prepared", name=one("name", "Imported product"),
                                                 provenance=provenance)
                    return self._json(app.store.create(one("name", "Imported product"), scene,
                                                       source_dir=temporary / "prepared"), 201)
                finally:
                    shutil.rmtree(temporary)
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
                    return self._json(entry, 201)
                finally:
                    temp.unlink(missing_ok=True)
            body = self._body()
            if self.command == "POST":
                if path == "/api/github-worlds/generate":
                    return self._json(app.github.dispatch(body), 202)
                if len(parts) == 5 and parts[:3] == ["api", "github-worlds", "runs"] and parts[4] == "import":
                    return self._json(app.github.import_run(parts[3]))
                if path == "/api/evaluate":
                    scene = validate_scene(body["scene"])
                    result = {**sample_scene(scene), "digest": scene_digest(scene)}
                    payload = comparison_payload(scene) if "comparison" in scene else None
                    if payload:
                        result["comparison"] = payload
                    return self._json(result)
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
            try:
                self._dispatch()
            except ConflictError as error:
                self._json({"error": str(error)}, 409)
            except FileNotFoundError:
                self._json({"error": "Record or asset not found"}, 404)
            except PermissionError as error:
                self._json({"error": str(error)}, 403)
            except (ValueError, TypeError, KeyError) as error:
                self._json({"error": str(error)}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self._json({"error": f"Local server error: {type(error).__name__}: {error}"}, 500)

        do_GET = _handle
        do_POST = _handle
        do_PUT = _handle

    return Handler


def serve(data_dir="workspace-data", *, port=8787, blender="blender", ffmpeg="ffmpeg"):
    app = Application(data_dir, port=port, blender=blender, ffmpeg=ffmpeg)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    app.port = server.server_port
    app.renders.base_url = f"http://127.0.0.1:{app.port}"
    print(f"Product Suite editor: http://127.0.0.1:{app.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping editor server. Interrupted jobs remain resumable.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default="workspace-data")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    serve(args.data_dir, port=args.port)
