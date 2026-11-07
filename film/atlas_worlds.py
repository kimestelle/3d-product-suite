"""Create Atlas worlds from a staged guide, with separate view, draft and refine jobs."""

from __future__ import annotations

import base64
from contextlib import nullcontext, suppress
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import tempfile

from .atlas import ASSET_SUFFIXES, MAX_CACHED_BYTES, REJECTED, RETRYABLE_REJECTIONS, _camera, _key, _provider_id
from .atlas_client import AtlasClient, AtlasError
from .fal_images import FalClient, MODEL as FAL_MODEL, BASE_MODEL as FAL_BASE_MODEL
from .store import ConflictError, identifier, now
from .worldlabs import _atomic_json, _state_lock, _validate_download_url
from .worlds import MAX_ASSET_BYTES, MAX_DECODED_SPZ_BYTES, import_world

GUIDE_ID = "water-light-pavilion"
GUIDES = Path(__file__).with_name("atlas_guides")
TASKS = {"views": "atlasChisel", "pose": "images2PosedRGBD", "draft": "posedImages2Splats", "refine": "posedImages2Splats"}
MAX_RUNS = 24
REFERENCE_ANGLES = (
    "Room overview, eye-level wide view facing the primary shooting surface",
    "Diagonal view from the left, with overlapping windows and shooting surfaces",
    "Side view along the primary shooting surface toward the back of the room",
    "Reverse diagonal view from the back of the room toward the entrance",
)
CONCEPT_DIRECTIONS = (
    "A direct interpretation of the brief, with a clear main shooting surface and restrained supporting detail",
    "A second interpretation of the same brief, varying material balance and light direction while preserving all stated requirements",
    "A third interpretation of the same brief, varying spatial composition and the shape of the shooting surfaces while preserving all stated requirements",
)


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
    def __init__(self, root, *, client_factory=AtlasClient, fal_factory=FalClient):
        self.root = Path(root)
        self.directory = self.root / "atlas-worlds"
        self.client_factory = client_factory
        self.fal_factory = fal_factory

    def _client(self):
        key = _key(self.root)
        if not key:
            raise AtlasError("Configure a private Atlas project key on the Gesso server first.")
        return self.client_factory(key)

    def _fal_client(self):
        key = _key(self.root, env_name="FAL_KEY", file_env="FAL_KEY_FILE", filename="fal-api-key")
        if not key:
            raise AtlasError("Configure a private fal key on the Gesso server first.")
        return self.fal_factory(key)

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
        public["revision"] = run.get("revision", 1)
        public.update({key: run[key] for key in ("parentId", "instruction", "imageProvider", "model", "communityOptIn", "communitySubmission", "selectedConcept") if key in run})
        job = run["jobs"][run["stage"]]
        public["state"] = "pending" if job["state"] == "submitting" else job["state"]
        if run["stage"] == "pose" and job["state"] == "succeeded" and run.get("buildRequested"):
            public["state"] = "pending"
        public.update({key: job[key] for key in ("operationId", "error", "retryAt") if job.get(key)})
        if job.get("rejected"):
            public["canRetry"] = True
        if "conceptFiles" in run:
            public["concepts"] = [{"url": f"/api/atlas/worlds/{run['id']}/concepts/{i}", "name": f"Direction {i + 1}"}
                                  for i in range(len(run["conceptFiles"]))]
        if run.get("imageProvider") == "fal" and "referenceFiles" in run:
            public["views"] = [{"url": f"/api/atlas/worlds/{run['id']}/views/{i}", "name": REFERENCE_ANGLES[i]}
                               for i in range(len(run["referenceFiles"]))]
        elif "frames" in run:
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
        if "communityOptIn" in body and type(body["communityOptIn"]) is not bool:
            raise ValueError("Community submission preference must be true or false.")
        notes = body.get("prompt", "")
        if not isinstance(notes, str) or len(notes) > 1000:
            raise ValueError("Atlas art direction must be 1000 characters or fewer.")
        notes = notes.strip()
        folder, guide = _guide(guide_id)
        if body.get("imageProvider") == "fal":
            if body.get("reference") is not None:
                raise ValueError("Use the environment reference editor for fal images.")
            variation = body.get("variationKey")
            if variation is not None and (not isinstance(variation, str) or re.fullmatch(r"[A-Za-z0-9_-]{8,80}", variation) is None):
                raise ValueError("Variation key must be a bounded unique identifier.")
            return self._new_fal_run(guide_id, guide, notes, image_stage="concepts", variation=variation,
                                     community_opt_in=body.get("communityOptIn", True), update_consent="communityOptIn" in body)
        if body.get("imageProvider") not in (None, "atlas"):
            raise ValueError("Unknown reference image provider.")
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
                       "revision": 1,
                       "communityOptIn": body.get("communityOptIn", True),
                       "translationM": guide["translationM"], "expectedViews": len(request["targetCameras"]),
                       "createdAt": now()}
            else:
                if "communityOptIn" in body:
                    self._update_community_opt_in(run, body["communityOptIn"])
            return self._submit_stage(run, "views", request)

    def revise(self, parent_id, body):
        if not isinstance(body, dict):
            raise ValueError("Atlas reference edit must be an object.")
        instruction = body.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 1000:
            raise ValueError("Describe the reference change in 1 to 1000 characters.")
        instruction = instruction.strip()
        if "communityOptIn" in body and type(body["communityOptIn"]) is not bool:
            raise ValueError("Community submission preference must be true or false.")
        with _state_lock(self.directory):
            parent = self._read(parent_id)
            if parent.get("imageProvider") == "fal":
                image_stage = "concepts" if parent["stage"] == "concepts" else "references"
                if parent["jobs"].get(image_stage, {}).get("state") != "succeeded":
                    raise ConflictError("Complete the reference images before editing them.")
                _, guide = _guide(parent["guideId"])
                return self._new_fal_run(parent["guideId"], guide, parent["prompt"], parent=parent, instruction=instruction,
                                         image_stage=image_stage,
                                         community_opt_in=body.get("communityOptIn", parent.get("communityOptIn", False)),
                                         update_consent="communityOptIn" in body, locked=True)
            if parent["jobs"].get("views", {}).get("state") != "succeeded" or not parent.get("frames"):
                raise ConflictError("Complete the Atlas reference views before editing them.")
            folder, guide = _guide(parent["guideId"])
            request = _view_request(folder, guide, "", None)
            if [frame["camera"] for frame in parent["frames"]] != request["targetCameras"]:
                raise ConflictError("The saved views no longer match this layout guide. Start a new reference set.")
            request["sourceFrames"] = [{"camera": frame["camera"], "imageAsset": frame["imageAsset"]}
                                       for frame in parent["frames"]]
            request["prompt"] = (parent["scenePrompt"] + "\nReference revision: " + instruction
                                 + "\nKeep the same room layout, camera positions, and known scene. "
                                   "Preserve the existing appearance except for the requested change.")
            fingerprint = {"parentId": parent_id, "instruction": instruction, "request": request}
            run_id = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()[:32]
            try:
                run = self._read(run_id)
            except FileNotFoundError:
                if len(list(self._records())) >= MAX_RUNS:
                    raise ValueError("This workspace has reached its Atlas world record limit.")
                run = {"schemaVersion": 1, "id": run_id, "guideId": parent["guideId"],
                       "guideName": parent["guideName"], "prompt": parent["prompt"],
                       "scenePrompt": request["prompt"], "stage": "views", "jobs": {},
                       "parentId": parent_id, "instruction": instruction, "revision": parent.get("revision", 1) + 1,
                       "communityOptIn": body.get("communityOptIn", parent.get("communityOptIn", False)),
                       "translationM": parent["translationM"], "expectedViews": parent["expectedViews"],
                       "createdAt": now()}
            else:
                if "communityOptIn" in body:
                    self._update_community_opt_in(run, body["communityOptIn"])
            return self._submit_stage(run, "views", request)

    def reconstruct(self, run_id, stage):
        if stage not in ("draft", "refine"):
            raise ValueError("Unknown Atlas reconstruction stage.")
        with _state_lock(self.directory):
            run = self._read(run_id)
            if run.get("imageProvider") == "fal" and stage == "draft":
                if run["jobs"].get("references", {}).get("state") != "succeeded":
                    raise ConflictError("Complete the reference images before building 3D.")
                run["buildRequested"] = True
                if run["jobs"].get("pose", {}).get("state") != "succeeded":
                    folder = self._path(run_id).parent
                    request = {"frames": [{"imageAsset": _inline(folder / filename, "image/" + ("jpeg" if filename.endswith(".jpg") else filename.rsplit(".", 1)[-1]))}
                                           for filename in run["referenceFiles"]],
                               "canonicalizeToFirstFrame": True, "targetResolution": [1280, 720], "refinePoses": True}
                    result = self._submit_stage(run, "pose", request)
                    if run["jobs"].get("pose", {}).get("state") == "succeeded":
                        return self._build_fal_draft(run)
                    return result
                return self._build_fal_draft(run)
            prior = "views" if stage == "draft" else "draft"
            if run["jobs"].get(prior, {}).get("state") != "succeeded":
                raise ConflictError(f"Complete the Atlas {prior} stage first.")
            request = {"posedFrames": run["frames"], "prompt": run["scenePrompt"], "enhancePrompt": False}
            if stage == "draft":
                request["refine"] = False
            return self._submit_stage(run, stage, request)

    def _build_fal_draft(self, run):
        request = {"posedFrames": run["frames"], "prompt": run["scenePrompt"], "enhancePrompt": False, "refine": False}
        try:
            return self._submit_stage(run, "draft", request)
        except AtlasError as error:
            run["jobs"]["pose"]["error"] = str(error)
            self._save(run)
            return self._public(run)

    def _new_fal_run(self, guide_id, guide, notes, *, parent=None, instruction=None, community_opt_in=True,
                     update_consent=False, locked=False, image_stage="references", variation=None, concept_index=None):
        scene_prompt = ((parent["scenePrompt"] + ("\nRequested revision: " + instruction if instruction else "")) if parent else
                        notes or guide["prompt"])
        fingerprint = {"provider": "fal", "model": FAL_MODEL, "guideId": guide_id,
                       "scenePrompt": scene_prompt, "parentId": parent["id"] if parent else None,
                       "imageStage": image_stage, "variationKey": variation, "selectedConcept": concept_index}
        run_id = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()[:32]
        with nullcontext() if locked else _state_lock(self.directory):
            try:
                run = self._read(run_id)
            except FileNotFoundError:
                if len(list(self._records())) >= MAX_RUNS:
                    raise ValueError("This workspace has reached its Atlas world record limit.")
                self._fal_client()
                run = {"schemaVersion": 1, "id": run_id, "guideId": guide_id, "guideName": guide["name"],
                       "prompt": notes, "scenePrompt": scene_prompt, "imageProvider": "fal", "model": FAL_BASE_MODEL,
                       "stage": image_stage, "imageStage": image_stage, "jobs": {}, "revision": parent.get("revision", 1) + 1 if parent else 1,
                       "communityOptIn": community_opt_in,
                       "translationM": [0, 0, 0], "expectedViews": len(REFERENCE_ANGLES), "createdAt": now()}
                if notes:
                    run["guideName"] = notes[:80]
                if parent:
                    run["parentId"] = parent["id"]
                    if instruction:
                        run["instruction"] = instruction
                if concept_index is not None:
                    run["selectedConcept"] = concept_index
            else:
                if update_consent:
                    self._update_community_opt_in(run, community_opt_in)
            return self._submit_fal_references(run, image_stage)

    def select_concept(self, parent_id, body):
        index = body.get("conceptIndex") if isinstance(body, dict) else None
        if type(index) is not int or not 0 <= index < len(CONCEPT_DIRECTIONS):
            raise ValueError("Choose one of the three concept directions.")
        with _state_lock(self.directory):
            parent = self._read(parent_id)
            if parent.get("imageProvider") != "fal" or parent["jobs"].get("concepts", {}).get("state") != "succeeded":
                raise ConflictError("Complete the three concept images before choosing a direction.")
            _, guide = _guide(parent["guideId"])
            return self._new_fal_run(parent["guideId"], guide, parent["prompt"], parent=parent,
                                     image_stage="references", concept_index=index, locked=True,
                                     community_opt_in=parent.get("communityOptIn", False))

    def set_sharing(self, run_id, body):
        if not isinstance(body, dict) or type(body.get("communityOptIn")) is not bool:
            raise ValueError("Community submission preference must be true or false.")
        with _state_lock(self.directory):
            run = self._read(run_id)
            self._update_community_opt_in(run, body["communityOptIn"])
            return self._public(run)

    def _update_community_opt_in(self, run, enabled):
        """An explicit consent change must not create another paid generation."""
        if run.get("communityOptIn") is enabled:
            return
        from .marketplace import Marketplace
        marketplace = Marketplace(self.root)
        for job in run["jobs"].values():
            world = job.get("world", {})
            submission = world.get("communitySubmission")
            if not enabled and submission and submission.get("id"):
                current = marketplace.submission(submission["id"])
                if current["state"] != "withdrawn":
                    current = marketplace.withdraw(submission["id"])
                world["communitySubmission"] = current
                run["communitySubmission"] = current
            elif enabled and world.get("id"):
                current = marketplace.submit_saved({"worldId": world["id"], "communityOptIn": True})
                if current["state"] == "withdrawn":
                    current = marketplace.resubmit(current["id"])
                world["communitySubmission"] = current
                run["communitySubmission"] = current
        run["communityOptIn"] = enabled
        self._save(run)

    def _fal_source_images(self, run):
        if run.get("parentId"):
            parent = self._read(run["parentId"])
            folder = self._path(parent["id"]).parent
            if "selectedConcept" in run and parent.get("conceptFiles"):
                files = [folder / parent["conceptFiles"][run["selectedConcept"]]]
            elif run.get("imageStage") == "concepts":
                files = [folder / filename for filename in parent["conceptFiles"]]
            else:
                files = [folder / filename for filename in parent["referenceFiles"]]
        elif run["prompt"]:
            files = []
        else:
            folder, guide = _guide(run["guideId"])
            files = [folder / reference["imageFile"] for reference in guide["references"]]
        return [_inline(file, "image/" + ("jpeg" if file.suffix.lower() in (".jpg", ".jpeg") else file.suffix[1:]))["base64"]
                for file in files[:14]]

    def _submit_fal_references(self, run, image_stage=None):
        image_stage = image_stage or run.get("imageStage", "references")
        directions = CONCEPT_DIRECTIONS if image_stage == "concepts" else REFERENCE_ANGLES
        prior = run["jobs"].get(image_stage)
        if prior and (prior["state"] != "failed" or not prior.get("rejected") or self._waiting(prior)):
            return self._public(run)
        for other in self._records():
            if other["id"] != run["id"] and other["jobs"][other["stage"]]["state"] in ("submitting", "pending", "uncertain"):
                raise ConflictError("Check the active image or world operation before starting another.")
        client = self._fal_client()
        sources = self._fal_source_images(run)
        run["stage"] = image_stage
        job = run["jobs"].setdefault(image_stage, {"state": "pending", "requests": []})
        job["endpoint"] = FAL_MODEL if sources else FAL_BASE_MODEL
        job.update(state="pending", rejected=False, error=None, retryAt=None)
        for index, angle in enumerate(directions):
            if index < len(job["requests"]):
                request = job["requests"][index]
                if request["state"] in ("pending", "succeeded"):
                    continue
            else:
                request = {}
                job["requests"].append(request)
            request.update(state="submitting")
            self._save(run)
            if image_stage == "concepts":
                prompt = (run["scenePrompt"] + "\nCreate one photographic concept for this product film setting. " + angle
                          + ". Respect the user's specified location, materials, mood and constraints. "
                            "Leave the main product placement area clear. Return a single image without labels or a collage.")
            else:
                prompt = (run["scenePrompt"] + "\nRender one photograph of this same room from this view: " + angle
                          + ". Keep the same architecture, materials, furniture, lighting direction and object positions "
                            "as the supplied room references. Show overlapping landmarks across views. "
                            "Leave product shooting surfaces empty. Return one image, without labels or a collage.")
            try:
                request_id = client.submit({"prompt": prompt, "image_urls": sources, "num_images": 1,
                                            "aspect_ratio": "16:9", "resolution": "2K", "output_format": "png",
                                            "limit_generations": True, "enable_web_search": False})
                request.update(state="pending", requestId=_provider_id(request_id))
                self._save(run)
            except AtlasError as error:
                rejected = error.status in REJECTED
                request.update(state="failed" if rejected else "uncertain")
                job.update(state=request["state"], rejected=rejected and error.status in RETRYABLE_REJECTIONS,
                           error=str(error) if rejected else "fal may have accepted an image request. Check fal request history before retrying.")
                self._retry_after(job, error)
                self._save(run)
                return self._public(run)
        self._save(run)
        return self._public(run)

    def _refresh_fal_references(self, run):
        image_stage = run["stage"]
        is_concept = image_stage == "concepts"
        directions = CONCEPT_DIRECTIONS if is_concept else REFERENCE_ANGLES
        job = run["jobs"][image_stage]
        if any(item["state"] == "submitting" for item in job["requests"]):
            job.update(state="uncertain", error="An image submission was interrupted. Check fal request history before retrying.")
            self._save(run)
        if job["state"] not in ("pending", "failed") or self._waiting(job):
            return self._public(run)
        client = self._fal_client()
        folder = self._path(run["id"]).parent
        for index, request in enumerate(job["requests"]):
            if request["state"] != "pending":
                continue
            try:
                status = client.status(request["requestId"])
                if status.get("status") not in ("IN_QUEUE", "IN_PROGRESS", "COMPLETED"):
                    raise AtlasError("fal returned an unexpected image status.")
                if status["status"] != "COMPLETED":
                    continue
                if status.get("error"):
                    request["state"] = "failed"
                    job.update(state="failed", rejected=False, error="fal reported a failed image generation.")
                    continue
                result = client.result(request["requestId"])
                images = result.get("images")
                if not isinstance(images, list) or len(images) != 1:
                    raise AtlasError("fal completed without the expected reference image.")
                with tempfile.TemporaryDirectory(dir=folder, prefix=".reference-") as temporary:
                    staged = Path(temporary) / "image"
                    suffix = client.download_image(images[0].get("url"), staged)
                    if suffix not in ASSET_SUFFIXES["image"]:
                        raise AtlasError("fal returned an unsupported reference image.")
                    used = sum(path.stat().st_size for pattern in ("*/reference-*.*", "*/concept-*.*")
                               for path in self.directory.glob(pattern) if path.is_file())
                    if used + staged.stat().st_size > MAX_CACHED_BYTES:
                        raise AtlasError("The reference image cache has reached its storage limit.")
                    filename = f"{'concept' if is_concept else 'reference'}-{index:02}{suffix}"
                    staged.replace(folder / filename)
                    request.update(state="succeeded", file=filename)
                self._save(run)
            except AtlasError as error:
                job["error"] = str(error)
                if error.status is not None and 400 <= error.status < 500 and error.status not in (408, 425, 429):
                    request["state"] = "failed"
                    job.update(state="failed", rejected=False, retryAt=None)
                else:
                    self._retry_after(job, error, default=5)
                self._save(run)
                return self._public(run)
        if len(job["requests"]) == len(directions) and all(item["state"] == "succeeded" for item in job["requests"]):
            run["conceptFiles" if is_concept else "referenceFiles"] = [item["file"] for item in job["requests"]]
            job.update(state="succeeded", error=None, retryAt=None)
        self._save(run)
        return self._public(run)

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
            if run["stage"] in ("concepts", "references"):
                return self._refresh_fal_references(run)
            job = run["jobs"][run["stage"]]
            if run["stage"] == "pose" and job["state"] == "succeeded" and run.get("buildRequested"):
                return self._build_fal_draft(run)
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
            if run["stage"] == "pose" and job["state"] == "succeeded" and run.get("buildRequested"):
                return self._build_fal_draft(run)
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
            if stage in ("views", "pose"):
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
        provider_id = run["jobs"].get("views", run["jobs"].get("pose", {}))["operationId"]
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
        cleanup = {"schemaVersion": 1, "status": "full-source", "sourceSha256": entry["environment"]["asset"]["sha256"],
                   "reason": "No reviewed inside-camera sweep is attached to this import. The full Gaussian source is retained.",
                   "canApply": False}
        try:
            _atomic_json(folder / f"{stage}-interior-cleanup.json", cleanup)
        except OSError:
            cleanup["reason"] = "The cleanup assessment could not be saved. The full Gaussian source is retained."
        job.update(state="succeeded", world={"id": entry["id"], "providerWorldId": provider_id, "interiorCleanup": cleanup},
                   error=None, retryAt=None)
        if run.get("communityOptIn") is True:
            from .marketplace import Marketplace
            try:
                submission = Marketplace(self.root).submit(entry, {"interiorCleanup": cleanup})
                summary = {key: submission[key] for key in ("id", "state", "reviewTurnaround", "audit")}
                job["world"]["communitySubmission"] = summary
                run["communitySubmission"] = summary
            except (OSError, ValueError):
                job["world"]["communitySubmission"] = {"state": "changes_needed",
                    "error": "The private community audit could not complete. The generated world remains in this workspace."}

    def concept(self, run_id, index):
        run = self._read(run_id)
        return self._cached_reference(run, index, "conceptFiles")

    def _cached_reference(self, run, index, field):
        if not index.isascii() or not index.isdecimal() or len(index) > 3:
            raise FileNotFoundError("Unknown reference image.")
        index = int(index)
        files = run.get(field, [])
        if index >= len(files):
            raise FileNotFoundError("Unknown reference image.")
        folder = self._path(run["id"]).parent
        path = folder / files[index]
        if path.is_symlink() or not path.is_file() or path.parent != folder:
            raise FileNotFoundError("Reference image is unavailable.")
        return path

    def view(self, run_id, index):
        run = self._read(run_id)
        if run.get("imageProvider") == "fal":
            return self._cached_reference(run, index, "referenceFiles")
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
