"""Durable paired exports over two immutable jobs in the existing render queue."""

import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import uuid
import zipfile

from . import jobs
from .comparison import comparison_payload
from .scene import scene_digest, validate_scene
from .store import identifier, now
from .worlds import verify_scene_assets


PAIR_ARTIFACTS = {"comparison.json", "pair.zip"}


class ComparisonJobs:
    def __init__(self, renders):
        self.renders = renders
        self.root = renders.store.root / "comparison-renders"
        self.root.mkdir(exist_ok=True)
        self.lock = threading.RLock()

    def directory(self, pair_id):
        return self.root / identifier(pair_id)

    def _read(self, pair_id):
        directory = self.directory(pair_id)
        record = json.loads((directory / "pair.json").read_text())
        if record.get("schemaVersion") != 1 or record.get("id") != pair_id:
            raise ValueError("Invalid paired render manifest")
        pinned = {key: value for key, value in record.items() if key != "parentDigest"}
        if scene_digest(pinned) != record.get("parentDigest"):
            raise ValueError("Paired render settings were modified after creation")
        scene = validate_scene(json.loads((directory / "scene.json").read_text()))
        if scene_digest(scene) != record["sourceDigest"]:
            raise ValueError("Paired source revision was modified after creation")
        return record

    def _snapshot(self, summary):
        directory = self.renders.directory(summary["id"])
        job = jobs._read_job(directory)
        request = self.renders._request(summary["id"])
        return {
            "id": summary["id"], "sourceDigest": job["sceneDigest"],
            "samplesDigest": jobs._sha256(directory / "samples.json"),
            "rendererDigest": job["rendererDigest"],
            "assetsDigest": scene_digest(job.get("assets", [])),
            "renderProfile": job["renderProfile"], "kind": request["kind"],
            "frame": request.get("frame"),
        }

    def _child(self, pinned):
        summary = self.renders.summary(pinned["id"])
        current = self._snapshot(summary)
        if current != pinned:
            raise ValueError(f"Child {pinned['id']} settings or snapshots changed after pair creation")
        directory = self.renders.directory(pinned["id"])
        job = jobs._read_job(directory)
        scene = validate_scene(json.loads((directory / "scene.json").read_text()))
        if scene_digest(scene) != pinned["sourceDigest"]:
            raise ValueError("Paired child source revision was modified")
        if jobs._sha256(directory / "renderer.py") != pinned["rendererDigest"]:
            raise ValueError("Paired child renderer snapshot was modified")
        if scene_digest(verify_scene_assets(scene, directory)) != pinned["assetsDigest"]:
            raise ValueError("Paired child bundled assets were modified")
        if summary["state"] == "succeeded":
            name = "still.png" if pinned["kind"] == "still" else "film.mp4"
            artifact = job.get("artifacts", {}).get(name, {})
            path = directory / name
            if (not path.is_file() or path.is_symlink() or path.stat().st_size != artifact.get("bytes")
                    or jobs._sha256(path) != artifact.get("sha256")):
                # The core runner can repair an edited output from the same snapshots.
                summary = {**summary, "state": "failed", "artifacts": [],
                           "error": "Completed child output is missing or changed; resume to rebuild it"}
        return summary

    def create(self, data):
        scene = validate_scene(data["scene"])
        payload = comparison_payload(scene)
        if not payload:
            raise ValueError("Configure both comparison environments before exporting a pair")
        kind = data.get("kind", "still")
        if kind not in ("still", "reel"):
            raise ValueError("Render kind must be still or reel")
        pair_id = uuid.uuid4().hex
        directory = self.directory(pair_id)
        created = []
        with self.lock, self.renders.lock:
            try:
                directory.mkdir()
                for side in ("a", "b"):
                    child = self.renders.create({**data, "kind": kind, "scene": payload[side]}, enqueue=False)
                    created.append(child)
                children = {side: self._snapshot(child) for side, child in zip(("a", "b"), created)}
                first, second = children["a"], children["b"]
                if (first["renderProfile"] != second["renderProfile"] or first["frame"] != second["frame"]
                        or first["kind"] != second["kind"]):
                    raise ValueError("Paired renders must use identical profiles and frames")
                if first["rendererDigest"] != second["rendererDigest"]:
                    raise ValueError("Paired renders must use the same renderer implementation")
                profile = first["renderProfile"]
                frames = [first["frame"]] if kind == "still" else list(range(1, profile["frameCount"] + 1))
                record = {
                    "schemaVersion": 1, "id": pair_id, "kind": kind, "createdAt": now(),
                    "sourceDigest": scene_digest(scene), "sharedDigest": payload["sharedDigest"],
                    "alignmentDigest": payload["alignmentDigest"], "alignmentStatus": payload["alignmentStatus"],
                    "pairing": payload["pairing"], "frame": first["frame"],
                    "frameDigest": scene_digest(frames), "renderProfile": profile,
                    "renderProfileDigest": scene_digest(profile), "children": children,
                }
                record["parentDigest"] = scene_digest(record)
                jobs._atomic_json(directory / "scene.json", scene)
                jobs._atomic_json(directory / "pair.json", record)
            except BaseException:
                # No child has entered the worker queue before both snapshots and parent exist.
                for child in created:
                    self.renders.prepared.discard(child["id"])
                    shutil.rmtree(self.renders.directory(child["id"]), ignore_errors=True)
                shutil.rmtree(directory, ignore_errors=True)
                raise
            for child in created:
                self.renders.enqueue(child["id"])
            return self.summary(pair_id)

    def _exports(self, record, children):
        directory = self.directory(record["id"])
        name = "still.png" if record["kind"] == "still" else "film.mp4"
        sources = {}
        for side, child in children.items():
            source = self.renders.directory(child["id"]) / name
            sources[side] = {"name": f"{side}/{name}", "sha256": jobs._sha256(source), "bytes": source.stat().st_size}
        manifest = {
            key: record[key] for key in ("schemaVersion", "id", "kind", "createdAt", "sourceDigest", "sharedDigest",
                "alignmentDigest", "alignmentStatus", "pairing", "frame", "frameDigest", "renderProfile", "renderProfileDigest", "parentDigest")
        }
        manifest["children"] = {side: {**record["children"][side], "artifact": sources[side]} for side in ("a", "b")}
        manifest_path, zip_path = directory / "comparison.json", directory / "pair.zip"
        exports_path = directory / "exports.json"
        if exports_path.is_file():
            try:
                cached = json.loads(exports_path.read_text())
                if (cached.get("manifestDigest") == scene_digest(manifest)
                        and all((directory / filename).is_file() and not (directory / filename).is_symlink()
                                and jobs._sha256(directory / filename) == cached["artifacts"][filename]["sha256"]
                                for filename in PAIR_ARTIFACTS)):
                    return [{"name": filename, "url": f"/api/comparison-renders/{record['id']}/files/{filename}"}
                            for filename in sorted(PAIR_ARTIFACTS)]
            except (OSError, ValueError, KeyError, TypeError):
                pass
        jobs._atomic_json(manifest_path, manifest)
        handle, temporary = tempfile.mkstemp(dir=directory, prefix=".pair-", suffix=".zip")
        os.close(handle)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(manifest_path, "comparison.json")
                for side in ("a", "b"):
                    source = self.renders.directory(children[side]["id"]) / name
                    archive.write(source, sources[side]["name"])
                    if jobs._sha256(source) != sources[side]["sha256"]:
                        raise ValueError("Child output changed during paired export")
            os.replace(temporary, zip_path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        jobs._atomic_json(exports_path, {"manifestDigest": scene_digest(manifest), "artifacts": {
            filename: {"sha256": jobs._sha256(directory / filename), "bytes": (directory / filename).stat().st_size}
            for filename in sorted(PAIR_ARTIFACTS)}})
        return [{"name": filename, "url": f"/api/comparison-renders/{record['id']}/files/{filename}"}
                for filename in sorted(PAIR_ARTIFACTS)]

    def summary(self, pair_id):
        with self.lock:
            record = self._read(pair_id)
            children, errors = {}, []
            for side in ("a", "b"):
                pinned = record["children"][side]
                try:
                    children[side] = self._child(pinned)
                except (OSError, ValueError, KeyError, TypeError) as error:
                    profile = pinned["renderProfile"]
                    children[side] = {"id": pinned["id"], "kind": record["kind"], "state": "failed", "stage": "failed",
                        "sourceDigest": pinned["sourceDigest"], "frame": pinned["frame"], "width": profile["width"],
                        "height": profile["height"], "completedFrames": 0,
                        "totalFrames": 1 if record["kind"] == "still" else profile["frameCount"],
                        "error": str(error), "artifacts": [], "createdAt": record["createdAt"]}
                if children[side].get("error"):
                    errors.append(f"{side.upper()}: {children[side]['error']}")
            states = {child["state"] for child in children.values()}
            artifacts = []
            if states == {"succeeded"}:
                state = "succeeded"
                try:
                    artifacts = self._exports(record, children)
                except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
                    state = "failed"
                    errors.append(f"Paired export: {error}")
            else:
                state = next((candidate for candidate in ("failed", "interrupted", "cancelled", "running", "queued")
                              if candidate in states), "failed")
            return {key: record[key] for key in ("id", "kind", "sourceDigest", "sharedDigest", "alignmentStatus", "frame", "createdAt")} | {
                "state": state, "children": children, "artifacts": artifacts, "error": "\n".join(errors) or None}

    def list(self):
        summaries = []
        for path in self.root.glob("*/pair.json"):
            try:
                summaries.append(self.summary(path.parent.name))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return sorted(summaries, key=lambda item: item["createdAt"], reverse=True)

    def cancel(self, pair_id):
        with self.lock, self.renders.lock:
            record = self._read(pair_id)
            for pinned in record["children"].values():
                try:
                    # Stopping a worker must still work when its source or
                    # samples fail integrity checks. A successful child remains
                    # untouched; strict validation is required again on resume.
                    if self.renders.summary(pinned["id"])["state"] != "succeeded":
                        self.renders.cancel(pinned["id"])
                except (OSError, ValueError, KeyError, TypeError):
                    continue
            return self.summary(pair_id)

    def resume(self, pair_id):
        with self.lock, self.renders.lock:
            record = self._read(pair_id)
            # Validate both immutable children before scheduling either one.
            children = {side: self._child(pinned) for side, pinned in record["children"].items()}
            for child in children.values():
                if child["state"] != "succeeded":
                    self.renders.check_resume(child["id"])
            for child in children.values():
                if child["state"] != "succeeded":
                    self.renders.enqueue(child["id"], resume=True)
            return self.summary(pair_id)

    def artifact(self, pair_id, filename):
        if filename not in PAIR_ARTIFACTS or self.summary(pair_id)["state"] != "succeeded":
            raise ValueError("Paired artifact is available only after both children succeed")
        path = self.directory(pair_id) / filename
        if path.is_symlink():
            raise ValueError("Invalid paired artifact path")
        return path
