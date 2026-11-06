"""Create Atlas worlds from a staged guide, with separate view, draft and refine jobs."""

from __future__ import annotations

import base64
from contextlib import suppress
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import struct
import tempfile

from .atlas import ASSET_SUFFIXES, MAX_CACHED_BYTES, REJECTED, RETRYABLE_REJECTIONS, _camera, _key, _provider_id
from .atlas_client import AtlasClient, AtlasError
from .store import ConflictError, identifier, now
from .worldlabs import _atomic_json, _state_lock, _validate_download_url
from .worlds import MAX_ASSET_BYTES, MAX_DECODED_SPZ_BYTES, import_world

GUIDE_ID = "water-light-pavilion"
GUIDES = Path(__file__).with_name("atlas_guides")
TASKS = {"views": "atlasChisel", "draft": "posedImages2Splats", "refine": "posedImages2Splats"}
MAX_RUNS = 24


def _guide(guide_id):
    if guide_id != GUIDE_ID:
        raise ValueError("Unknown Atlas layout guide.")
    folder = GUIDES / guide_id
    return folder, json.loads((folder / "guide.json").read_text(encoding="utf-8"))


def _inline(file, mime):
    return {"base64": f"data:{mime};base64," + base64.b64encode(file.read_bytes()).decode("ascii")}


def _view_request(folder, guide, notes, reference):
    frames = [{"camera": item["camera"], "depth": {
        "logDepthAsset": _inline(folder / item["depthFile"], "image/png"),
        "zMin": item["zMin"], "zMax": item["zMax"],
    }} for item in guide["frames"]]
    if reference is None:
        sources = [{"camera": item["camera"], "imageAsset": _inline(folder / item["imageFile"], "image/jpeg")}
                   for item in guide["references"]]
    else:
        if not isinstance(reference, dict):
            raise ValueError("Atlas reference must contain an image URL and a camera.")
        try:
            camera = _camera(reference["camera"])
            url = _validate_download_url(reference["imageUrl"])
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            raise ValueError("Atlas reference needs a public HTTPS image URL and a valid camera.") from None
        if camera["extrinsics"]["coordinateSystem"] != frames[0]["camera"]["extrinsics"]["coordinateSystem"]:
            raise ValueError("Reference camera must use the guide's RUB coordinates.")
        sources = [{"camera": camera, "imageAsset": {"url": url}}]
    prompt = guide["prompt"]
    if notes:
        prompt += "\nArt direction: " + notes
    return {"prompt": prompt, "contextFrames": frames, "sourceFrames": sources,
            "targetCameras": [frame["camera"] for frame in frames], "returnDepth": True,
            "enhancePrompt": False, "modelParameters": {"seed": guide["seed"]}}


def _gesso_splat(original, staging):
    """Clear the Atlas compatibility flag only on the imported copy."""
    try:
        with gzip.open(original, "rb") as reader:
            header = reader.read(16)
            magic, version, count, degree, fractional_bits, flags, reserved = struct.unpack("<III4B", header)
            if flags <= 3:
                return original
            if not (magic == 0x5053474E and version == 2 and 0 < count <= 10_000_000
                    and degree <= 3 and fractional_bits <= 24 and reserved == 0 and flags & ~3 == 0x40):
                raise ValueError("Atlas SPZ uses an unsupported header extension.")
            expected = 16 + count * (19 + 3 * degree * (degree + 2))
            if expected > MAX_DECODED_SPZ_BYTES:
                raise ValueError("SPZ decompressed data exceeds the size limit.")
            copy = staging / "compatible.spz"
            with gzip.GzipFile(copy, "wb", mtime=0) as output:
                output.write(header[:14] + bytes([flags & ~0x40]) + header[15:])
                remaining = expected - len(header)
                while remaining:
                    chunk = reader.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Atlas SPZ data is truncated.")
                    output.write(chunk)
                    remaining -= len(chunk)
                if reader.read(1):
                    raise ValueError("Atlas SPZ has an unsupported extension.")
            return copy
    except (OSError, EOFError, struct.error) as error:
        raise ValueError("Atlas SPZ has an invalid header or checksum.") from error


class AtlasWorlds:
    def __init__(self, root, *, client_factory=AtlasClient):
        self.root = Path(root)
        self.directory = self.root / "atlas-worlds"
        self.client_factory = client_factory

    def _client(self):
        key = _key(self.root)
        if not key:
            raise AtlasError("Configure a private Atlas project key on the Gesso server first.")
        return self.client_factory(key)

    def _path(self, run_id):
        return self.directory / identifier(run_id) / "run.json"

    def _read(self, run_id):
        run = json.loads(self._path(run_id).read_text(encoding="utf-8"))
        if run.get("schemaVersion") != 1 or run.get("id") != run_id:
            raise ValueError("Atlas world record is invalid.")
        return run

    def _save(self, run):
        run["updatedAt"] = now()
        _atomic_json(self._path(run["id"]), run)

    def _records(self):
        for path in self.directory.glob("*/run.json"):
            with suppress(OSError, ValueError, TypeError, AttributeError):
                yield self._read(path.parent.name)

    @staticmethod
    def _public(run):
        public = {key: run[key] for key in ("id", "guideId", "prompt", "createdAt", "updatedAt", "stage")}
        job = run["jobs"][run["stage"]]
        public["state"] = "pending" if job["state"] == "submitting" else job["state"]
        public.update({key: job[key] for key in ("operationId", "error", "retryAt") if job.get(key)})
        if job.get("rejected"):
            public["canRetry"] = True
        if "frames" in run:
            public["views"] = [{"url": f"/api/atlas/worlds/{run['id']}/views/{i}", "camera": frame["camera"]}
                               for i, frame in enumerate(run["frames"])]
        for stage, key in (("draft", "draftWorld"), ("refine", "refinedWorld")):
            if world := run["jobs"].get(stage, {}).get("world"):
                public[key] = world
        return public

    def list(self):
        return {"runs": [self._public(run) for run in sorted(
            self._records(), key=lambda item: item["createdAt"], reverse=True)]}

    @staticmethod
    def guide_reference(guide_id):
        folder, guide = _guide(guide_id)
        return folder / guide["references"][0]["imageFile"]

    def submit(self, body):
        if not isinstance(body, dict):
            raise ValueError("Atlas world request must be an object.")
        guide_id = body.get("guideId")
        notes = body.get("prompt", "")
        if not isinstance(notes, str) or len(notes) > 1000:
            raise ValueError("Atlas art direction must be 1000 characters or fewer.")
        notes = notes.strip()
        folder, guide = _guide(guide_id)
        request = _view_request(folder, guide, notes, body.get("reference"))
        run_id = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()[:32]
        with _state_lock(self.directory):
            try:
                run = self._read(run_id)
            except FileNotFoundError:
                records = list(self._records())
                if len(records) >= MAX_RUNS:
                    raise ValueError("This workspace has reached its Atlas world record limit.")
                run = {"schemaVersion": 1, "id": run_id, "guideId": guide_id, "guideName": guide["name"],
                       "prompt": notes, "scenePrompt": request["prompt"], "stage": "views", "jobs": {},
                       "translationM": guide["translationM"], "expectedViews": len(request["targetCameras"]),
                       "createdAt": now()}
            return self._submit_stage(run, "views", request)

    def reconstruct(self, run_id, stage):
        if stage not in ("draft", "refine"):
            raise ValueError("Unknown Atlas reconstruction stage.")
        with _state_lock(self.directory):
            run = self._read(run_id)
            prior = "views" if stage == "draft" else "draft"
            if run["jobs"].get(prior, {}).get("state") != "succeeded":
                raise ConflictError(f"Complete the Atlas {prior} stage first.")
            request = {"posedFrames": run["frames"], "prompt": run["scenePrompt"], "enhancePrompt": False}
            if stage == "draft":
                request["refine"] = False
            return self._submit_stage(run, stage, request)

    def _submit_stage(self, run, stage, request):
        job = run["jobs"].get(stage)
        if job and job["state"] == "submitting":
            self._interrupt(run, job)
        if job and (not job.get("rejected") or self._waiting(job)):
            return self._public(run)
        for other in self._records():
            if other["jobs"][other["stage"]]["state"] in ("submitting", "pending"):
                raise ConflictError("Check the active Atlas world operation before starting another.")
        client = self._client()
        run["stage"] = stage
        job = {"state": "submitting"}
        run["jobs"][stage] = job
        self._save(run)
        try:
            operation = client.submit_task(TASKS[stage], request, f"gesso-world-{run['id']}-{stage}")
            job.update(state="pending", operationId=_provider_id(operation.get("id")))
            self._save(run)
            self._operation(run, job, operation)
        except AtlasError as error:
            if job.get("operationId"):
                job.update(state="pending", error=str(error))
            elif error.status in REJECTED:
                job.update(state="failed", rejected=error.status in RETRYABLE_REJECTIONS, error=str(error))
            else:
                job.update(state="uncertain", error="Atlas may have accepted the request. Check Atlas Operations before trying again.")
            self._retry_after(job, error)
        self._save(run)
        return self._public(run)

    def _interrupt(self, run, job):
        job.update(state="uncertain", error="Submission was interrupted. Check Atlas Operations before trying again.")
        self._save(run)

    @staticmethod
    def _waiting(job):
        return bool(job.get("retryAt") and job["retryAt"] > now())

    @staticmethod
    def _retry_after(job, error, default=0):
        if error.retry_after is not None or default:
            retry_at = datetime.now(timezone.utc) + timedelta(seconds=min(error.retry_after or default, 86400))
            job["retryAt"] = retry_at.isoformat()

    def refresh(self, run_id):
        with _state_lock(self.directory):
            run = self._read(run_id)
            job = run["jobs"][run["stage"]]
            if job["state"] == "submitting":
                self._interrupt(run, job)
            if job["state"] != "pending" or self._waiting(job):
                return self._public(run)
            try:
                client = self._client()
                if "assetId" not in job:
                    self._operation(run, job, client.operation(job["operationId"]))
                    self._save(run)
                if "assetId" in job:
                    self._import(run, job, client)
            except AtlasError as error:
                job["error"] = str(error)
                self._retry_after(job, error, default=10)
            except ValueError:
                job.update(state="failed", error="Atlas returned a Gaussian asset this version of Gesso cannot import.")
            self._save(run)
            return self._public(run)

    @staticmethod
    def _operation(run, job, operation):
        stage = run["stage"]
        metadata = operation.get("metadata")
        if (operation.get("id") != job["operationId"] or type(operation.get("done")) is not bool or
                isinstance(metadata, dict) and metadata.get("task") not in (None, TASKS[stage])):
            raise AtlasError("Atlas returned an unexpected world operation.")
        job.update(state="pending", error=None, retryAt=None)
        if not operation["done"]:
            return
        if operation.get("error") is not None:
            job.update(state="failed", error="Atlas reported a failed operation. Open Atlas Operations for details.")
            return
        try:
            response = operation["response"]
            if stage == "views":
                frames = response["frames"]
                if not isinstance(frames, list) or len(frames) != run["expectedViews"]:
                    raise ValueError("Unexpected Atlas view count.")
                run["frames"] = [{"camera": _camera(frame["camera"]),
                                  "imageAsset": {"assetId": _provider_id(frame["imageAsset"]["assetId"])},
                                  "depth": {"depthAsset": {"assetId": _provider_id(frame["depth"]["depthAsset"]["assetId"])}}}
                                 for frame in frames]
                job["state"] = "succeeded"
            else:
                if stage == "refine":
                    refined = response["refinedSplats"]
                    asset = refined[max(refined, key=int)]
                else:
                    asset = response["draftSplat"]
                job["assetId"] = _provider_id(asset["assetId"])
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            job.update(state="failed", error="Atlas completed without the expected world output.")

    def _import(self, run, job, client):
        folder = self._path(run["id"]).parent
        stage = run["stage"]
        original = folder / (stage + "-source.spz")
        if not original.is_file():
            client.read_asset(job["assetId"], original, kind="splat", max_bytes=MAX_ASSET_BYTES)
        with original.open("rb") as file:
            checksum = hashlib.file_digest(file, "sha256").hexdigest()
        label = "Draft" if stage == "draft" else "Refined"
        provider_id = run["jobs"]["views"]["operationId"]
        with tempfile.TemporaryDirectory(dir=folder, prefix=".import-") as temp:
            source = _gesso_splat(original, Path(temp))
            entry = import_world(source, self.root, name=f"{run['guideName']} · Atlas {label}",
                                 translation_m=run["translationM"], provenance={
                "source": "Marble 2 Atlas Chisel and posedImages2Splats",
                "owner": "Gesso workspace",
                "reuseBasis": "World generated in this workspace",
                "allowedExternalDestinations": [],
                "providerWorldId": provider_id,
                "splatOperationId": job["operationId"],
                "originalSha256": checksum,
                "representation": "gaussian-spz",
                "splatResolution": label.lower(),
            })
        job.update(state="succeeded", world={"id": entry["id"], "providerWorldId": provider_id},
                   error=None, retryAt=None)

    def view(self, run_id, index):
        run = self._read(run_id)
        if not index.isascii() or not index.isdecimal() or len(index) > 3:
            raise FileNotFoundError("Unknown Atlas view.")
        index = int(index)
        frames = run.get("frames", [])
        if index >= len(frames):
            raise FileNotFoundError("Unknown Atlas view.")
        folder = self._path(run_id).parent
        name = f"view-{index:02}"
        with _state_lock(folder / f".{name}-download"):
            for suffix in ASSET_SUFFIXES["image"]:
                path = folder / (name + suffix)
                if path.is_file() and not path.is_symlink():
                    return path
            with tempfile.TemporaryDirectory(dir=folder, prefix=".download-") as temp:
                staged = Path(temp) / "view"
                suffix = self._client().read_asset(frames[index]["imageAsset"]["assetId"], staged, kind="image")
                if suffix not in ASSET_SUFFIXES["image"]:
                    raise AtlasError("Atlas view has an unexpected file type.")
                path = folder / (name + suffix)
                with _state_lock(self.directory / ".cache", blocking=True):
                    used = sum(asset.stat().st_size for asset in self.directory.glob("*/view-*.*") if asset.is_file())
                    if used + staged.stat().st_size > MAX_CACHED_BYTES:
                        raise AtlasError("The local Atlas view cache has reached its storage limit.")
                    staged.replace(path)
            return path
