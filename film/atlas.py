"""Durable Marble 2 quickstart records for the local World Comparison page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid

from .atlas_client import AtlasClient, AtlasError
from .store import ConflictError, identifier, now
from .worldlabs import _atomic_json, _state_lock, _validate_download_url

SAMPLE_IMAGE = (
    "https://images.pexels.com/photos/31252468/pexels-photo-31252468.jpeg"
    "?auto=compress&cs=tinysrgb&w=1280"
)
TASK = "images2PosedRGBD"
ASSET_SUFFIXES = {
    "image": (".png", ".jpg", ".webp"),
    "depth": (".exr",),
    "confidence": (".png", ".jpg", ".webp"),
}
MAX_RUNS = 64
MAX_CACHED_BYTES = 256 * 1024 * 1024
# These responses explicitly reject the request. An unknown status or a server
# error can arrive after acceptance, so its record must never create a new run.
REJECTED = {400, 401, 402, 403, 422, 429}
RETRYABLE_REJECTIONS = {401, 402, 429}


def _provider_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value):
        raise AtlasError("Atlas did not return a valid record ID.")
    return value


def _key(root, *, env_name="WLT_API_KEY", file_env="WLT_API_KEY_FILE", filename="atlas-api-key"):
    value = os.environ.get(env_name)
    if not value:
        path = Path(os.environ.get(file_env) or root / "secrets" / filename)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                    return None
                value = handle.read(4097).decode("utf-8")
        except (OSError, UnicodeError):
            return None
    value = value.strip()
    if not value or len(value) > 4096 or not re.fullmatch(r"[!-~]+", value):
        return None
    return value


def _camera(value):
    extrinsics = value["extrinsics"]
    intrinsics = value["intrinsics"]
    convention = extrinsics.get("coordinateSystem", extrinsics.get("coordinate_system", "rub"))
    position, quaternion = extrinsics["position"], extrinsics["quaternion"]
    if (convention not in ("rub", "rdf") or not isinstance(position, list) or len(position) != 3
            or not isinstance(quaternion, list) or len(quaternion) != 4 or not any(quaternion)):
        raise ValueError("Invalid pose")
    lens = {field: intrinsics[field] for field in ("fx", "fy", "cx", "cy", "width", "height")}
    if not all(type(item) in (int, float) and math.isfinite(item)
               for item in [*position, *quaternion, *lens.values()]):
        raise ValueError("Invalid camera values")
    if (lens["fx"] <= 0 or lens["fy"] <= 0 or
            any(type(lens[field]) is not int or not 1 <= lens[field] <= 16384 for field in ("width", "height"))):
        raise ValueError("Invalid camera intrinsics")
    return {"extrinsics": {"position": position, "quaternion": quaternion, "coordinateSystem": convention},
            "intrinsics": lens}


class AtlasQuickstart:
    def __init__(self, root, *, client_factory=AtlasClient):
        self.root = Path(root)
        self.directory = self.root / "atlas"
        self.client_factory = client_factory

    def status(self):
        return {"configured": bool(_key(self.root))}

    def _client(self):
        key = _key(self.root)
        if not key:
            raise AtlasError("Configure a private Atlas project key on the Gesso server first.")
        return self.client_factory(key)

    def _path(self, run_id):
        return self.directory / identifier(run_id) / "run.json"

    def _save(self, run):
        run["updatedAt"] = now()
        _atomic_json(self._path(run["id"]), run)

    def _public(self, run):
        public = {name: run[name] for name in (
            "id", "state", "imageUrl", "createdAt", "updatedAt", "operationId", "error", "retryAt"
        ) if name in run}
        if run.get("state") == "succeeded":
            public["result"] = {
                "camera": run["camera"],
                "assets": [{"kind": kind, "url": f"/api/atlas/quickstart/{run['id']}/assets/{kind}"}
                           for kind in ASSET_SUFFIXES if kind in run["assetIds"]],
            }
        return public

    def _read(self, run_id):
        run = json.loads(self._path(run_id).read_text(encoding="utf-8"))
        if not isinstance(run, dict) or run.get("schemaVersion") != 1 or run.get("id") != run_id:
            raise ValueError("Atlas run record is invalid.")
        return run

    def _records(self):
        for path in self.directory.glob("*/run.json"):
            try:
                yield self._read(path.parent.name)
            except (OSError, ValueError, TypeError):
                continue

    def list(self):
        return {"runs": [self._public(run) for run in sorted(
            self._records(), key=lambda item: item["createdAt"], reverse=True)]}

    def submit(self, image_url):
        image_url = _validate_download_url(image_url.strip() if isinstance(image_url, str) else image_url)
        body = {"frames": [{"imageAsset": {"url": image_url}}], "targetResolution": [1280, 720]}
        run_id = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:32]
        with _state_lock(self.directory):
            try:
                run = self._read(run_id)
            except FileNotFoundError:
                run = None
            if run and run["state"] == "submitting":
                run.update(state="uncertain", error="Submission was interrupted. Check Atlas Operations for this request.")
                self._save(run)
            if run and not run.get("rejected"):
                return self._public(run)
            if run and self._retry_waiting(run):
                return self._public(run)
            records = list(self._records())
            if any(item["state"] == "pending" for item in records):
                raise ConflictError("Check the pending Atlas operation before starting another.")
            if run is None and len(records) >= MAX_RUNS:
                raise ValueError("This workspace has reached its Atlas quickstart record limit.")
            client = self._client()
            if run is None:
                run = {"schemaVersion": 1, "id": run_id, "imageUrl": image_url,
                       "request": body, "idempotencyKey": uuid.uuid4().hex, "createdAt": now()}
            run.update(state="submitting", rejected=False, error=None, retryAt=None)
            self._save(run)
            try:
                operation = client.submit(run["request"], run["idempotencyKey"])
                run["operationId"] = _provider_id(operation.get("id"))
                self._apply_operation(run, operation)
            except AtlasError as error:
                rejected = error.status in REJECTED
                state = "failed" if rejected else "pending" if run.get("operationId") else "uncertain"
                run.update(state=state, rejected=error.status in RETRYABLE_REJECTIONS, error=str(error))
                if state == "uncertain":
                    run["error"] += " Check Atlas Operations before trying a different request."
                self._set_retry(run, error)
            self._save(run)
            return self._public(run)

    def refresh(self, run_id):
        with _state_lock(self.directory):
            run = self._read(run_id)
            if run["state"] == "submitting":
                run.update(state="uncertain", error="Submission was interrupted. Check Atlas Operations for this request.")
                self._save(run)
            if run["state"] != "pending" or self._retry_waiting(run):
                return self._public(run)
            try:
                self._apply_operation(run, self._client().operation(run["operationId"]))
            except AtlasError as error:
                run["error"] = ("The operation is not readable yet. Check it again shortly using the same ID."
                                if error.status == 404 else str(error))
                self._set_retry(run, error)
            self._save(run)
            return self._public(run)

    @staticmethod
    def _retry_waiting(run):
        return bool(run.get("retryAt") and run["retryAt"] > now())

    @staticmethod
    def _set_retry(run, error):
        if error.retry_after is not None:
            retry_at = datetime.now(timezone.utc) + timedelta(seconds=min(error.retry_after, 86400))
            run["retryAt"] = retry_at.isoformat()

    @staticmethod
    def _apply_operation(run, operation):
        if operation.get("id") != run["operationId"] or type(operation.get("done")) is not bool:
            raise AtlasError("Atlas returned an unexpected operation envelope.")
        metadata = operation.get("metadata")
        if isinstance(metadata, dict) and metadata.get("task") not in (None, TASK):
            raise AtlasError("Atlas returned a different task for this operation.")
        run.update(state="pending", error=None, retryAt=None)
        if not operation["done"]:
            return
        if operation.get("error") is not None:
            run.update(state="failed", error="Atlas reported a failed operation. Open Atlas Operations for details.")
            return
        try:
            frames = operation["response"]["frames"]
            if not isinstance(frames, list) or len(frames) != 1:
                raise ValueError("Unexpected frame count")
            frame = frames[0]
            camera = _camera(frame["camera"])
            depth = frame["depth"]
            asset_ids = {"image": _provider_id(frame["imageAsset"]["assetId"]),
                         "depth": _provider_id(depth["depthAsset"]["assetId"])}
            if depth.get("confidenceAsset") is not None:
                asset_ids["confidence"] = _provider_id(depth["confidenceAsset"]["assetId"])
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            run.update(state="failed", error="Atlas completed without the expected posed image and depth data.")
            return
        run.update(state="succeeded", camera=camera, assetIds=asset_ids)

    def asset(self, run_id, kind):
        if kind not in ASSET_SUFFIXES:
            raise FileNotFoundError("Unknown Atlas asset kind")
        run = self._read(run_id)
        if run["state"] != "succeeded" or kind not in run["assetIds"]:
            raise FileNotFoundError("Atlas output is not available")
        directory = self._path(run_id).parent
        with _state_lock(directory / f".{kind}-download"):
            for suffix in ASSET_SUFFIXES[kind]:
                path = directory / (kind + suffix)
                if path.is_file() and not path.is_symlink():
                    return path
            client = self._client()
            with tempfile.TemporaryDirectory(dir=directory, prefix=".download-") as temp:
                staged = Path(temp) / "asset"
                suffix = client.read_asset(run["assetIds"][kind], staged, kind=kind)
                if suffix not in ASSET_SUFFIXES[kind]:
                    raise AtlasError("Atlas asset has an unexpected file type.")
                path = directory / (kind + suffix)
                with _state_lock(self.directory / ".cache"):
                    used = sum(asset.stat().st_size for asset in self.directory.glob("*/*")
                               if asset.suffix in {".png", ".jpg", ".webp", ".exr"} and asset.is_file())
                    if used + staged.stat().st_size > MAX_CACHED_BYTES:
                        raise AtlasError("The local Atlas asset cache has reached its storage limit.")
                    staged.replace(path)
            return path
