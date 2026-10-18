"""Server-side Patina queue and a durable local library of immutable PBR maps.

Only a user-triggered create submits work. Restart/poll/cancel never resubmit a
paid request. Credentials stay in memory; provider logs and response bodies are
never exposed as errors. No provider request is made merely by listing materials.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from .jobs import _atomic_json
from .store import identifier, now
from .worlds import _immutable_write, safe_asset_path
from .material_assets import MAP_TYPES, MAX_IMAGE_BYTES, validate_png, validate_material_textures

MODEL = "fal-ai/patina/material"
QUEUE_URL = "https://queue.fal.run/" + MODEL
API_BYTES = 1024 * 1024


class MaterialProviderError(ValueError):
    """A safe, credential-free provider error."""


def _require(condition, message):
    if not condition:
        raise MaterialProviderError(message)


def _api_url(url, request_id=None, action=None):
    _require(isinstance(url, str) and len(url) <= 2048, "fal queue URL is invalid")
    parsed = urllib.parse.urlsplit(url)
    _require(parsed.scheme == "https" and parsed.netloc == "queue.fal.run" and not parsed.query and not parsed.fragment,
             "fal queue URL must stay on the authenticated queue host")
    if request_id is None:
        _require(url == QUEUE_URL, "Unexpected fal submission URL")
    else:
        _require(isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", request_id), "Invalid fal request ID")
        # Queue routing may omit the model's /material subpath in returned URLs.
        suffix = {"status": "/status", "cancel": "/cancel", "result": "(?:/response)?"}[action]
        _require(re.fullmatch(r"/fal-ai/patina(?:/material)?/requests/"+re.escape(request_id)+suffix, parsed.path),
                 "fal queue URL does not match its request and action")
    return url


def _download_url(url):
    _require(isinstance(url, str) and len(url) <= 8192, "fal image URL is invalid")
    parsed = urllib.parse.urlsplit(url)
    try:
        valid_port = parsed.port in (None,443)
    except ValueError:
        valid_port = False
    host = (parsed.hostname or "").lower()
    _require(parsed.scheme == "https" and valid_port and not parsed.username and not parsed.password and not parsed.fragment
             and (host == "fal.media" or host.endswith(".fal.media")), "Material images must come from the HTTPS fal CDN")
    return url


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise MaterialProviderError("fal API redirected; credentials were not forwarded")


class _CdnRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        _download_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


class PatinaClient:
    def __init__(self, key, *, opener=None, download_opener=None):
        _require(isinstance(key, str) and key.strip() and "\r" not in key and "\n" not in key,
                 "Set FAL_KEY in the server environment and restart the local app to generate materials.")
        self._key = key.strip()
        self.opener = opener or urllib.request.build_opener(_NoRedirect())
        self.download_opener = download_opener or urllib.request.build_opener(_CdnRedirect())

    @classmethod
    def from_environment(cls):
        return cls(os.environ.get("FAL_KEY", ""))

    def _request(self, method, url, payload=None, *, request_id=None, action=None):
        _api_url(url, request_id, action)
        data = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode() if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method,
            headers={"Authorization": "Key "+self._key, "Content-Type":"application/json", "Accept":"application/json"})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(API_BYTES+1)
            _require(len(raw) <= API_BYTES, "fal response exceeded its size limit")
            result = json.loads(raw)
            _require(isinstance(result,dict), "fal returned an invalid response")
            return result
        except urllib.error.HTTPError as error:
            raise MaterialProviderError(f"fal returned HTTP {error.code}; check the account and model access.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise MaterialProviderError("Could not reach fal. Submissions are never automatically retried.") from None
        except (UnicodeError,json.JSONDecodeError):
            raise MaterialProviderError("fal returned invalid JSON") from None

    def submit(self, prompt):
        result = self._request("POST", QUEUE_URL, {"prompt":prompt, "image_size":"square_hd", "num_images":1,
            "maps":list(MAP_TYPES), "tiling_mode":"both", "enable_prompt_expansion":False,
            "enable_safety_checker":True, "output_format":"png", "upscale_factor":"0"})
        request_id = result.get("request_id")
        _require(isinstance(request_id,str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}",request_id), "fal returned no valid request ID")
        base = QUEUE_URL+"/requests/"+request_id
        urls = {"status":result.get("status_url",base+"/status"), "result":result.get("response_url",base),
                "cancel":result.get("cancel_url",base+"/cancel")}
        for action,url in urls.items():
            _api_url(url,request_id,action)
        return {"requestId":request_id,"urls":urls}

    def status(self, submission):
        return self._request("GET",submission["urls"]["status"],request_id=submission["requestId"],action="status")

    def result(self, submission):
        return self._request("GET",submission["urls"]["result"],request_id=submission["requestId"],action="result")

    def cancel(self, submission):
        return self._request("PUT",submission["urls"]["cancel"],request_id=submission["requestId"],action="cancel")

    def download(self, url):
        request = urllib.request.Request(_download_url(url),headers={"Accept":"image/png"})
        try:
            with self.download_opener.open(request,timeout=30) as response:
                _download_url(response.geturl())
                declared = response.headers.get("Content-Length")
                _require(declared is None or declared.isdecimal() and int(declared) <= MAX_IMAGE_BYTES,
                         "Material image exceeds the 16 MiB limit")
                payload = response.read(MAX_IMAGE_BYTES+1)
            validate_png(payload)
            return payload
        except (urllib.error.URLError,TimeoutError,OSError):
            raise MaterialProviderError("Material image download failed; no credentials were sent to the CDN.") from None


class MaterialLibrary:
    def __init__(self, root, *, client_factory=None, start_worker=True, poll_interval=3):
        self.root = Path(root)
        self.directory = self.root/"materials"
        self.jobs = self.directory/"jobs"
        self.entries = self.directory/"entries"
        self.jobs.mkdir(parents=True,exist_ok=True)
        self.entries.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.client_factory = client_factory or PatinaClient.from_environment
        self.pending = queue.Queue()
        self.poll_interval = poll_interval
        # An uncertain paid POST cannot be retried safely after process loss.
        for path in self.jobs.glob("*.json"):
            job = json.loads(path.read_text())
            if job["state"] in ("queued","running"):
                if job.get("phase") == "submitting" and not job.get("submission"):
                    job.update(state="failed",error="Submission was interrupted before confirmation. Check fal before generating again.")
                    self._save(job)
                else:
                    self.pending.put(job["id"])
        if start_worker:
            threading.Thread(target=self._worker,name="material-generation",daemon=True).start()

    @property
    def configured(self):
        return bool(os.environ.get("FAL_KEY", "").strip())

    def _save(self, job):
        job["updatedAt"] = now()
        _atomic_json(self.jobs/(job["id"]+".json"),job)

    def _get(self, job_id):
        return json.loads((self.jobs/(identifier(job_id)+".json")).read_text())

    @staticmethod
    def _summary(job):
        fields = ("id","state","prompt","createdAt","updatedAt","error","material","notice","phase")
        return {key:job[key] for key in fields if key in job}

    def get(self, job_id):
        with self.lock:
            return self._summary(self._get(job_id))

    def list(self):
        with self.lock:
            entries = [json.loads(path.read_text()) for path in self.entries.glob("*.json")]
            jobs = [self._summary(json.loads(path.read_text())) for path in self.jobs.glob("*.json")]
            return {"configured":self.configured,"materials":sorted(entries,key=lambda x:x["createdAt"],reverse=True),
                    "jobs":sorted(jobs,key=lambda x:x["createdAt"],reverse=True)[:30]}

    def add_entry(self, entry):
        """Import an already downloaded library material without provider generation."""
        from .scene import _material
        _require(isinstance(entry, dict), "Material library entry must be an object")
        entry = dict(entry)
        identifier(entry.get("id"))
        _require(isinstance(entry.get("name"), str) and 0 < len(entry["name"].strip()) <= 140,
                 "Material name must contain 1–140 characters")
        _material(entry["material"])
        for asset in entry["material"].get("textures", {}).values():
            path = safe_asset_path(self.root, asset["path"])
            _require(path.is_file() and path.stat().st_size <= MAX_IMAGE_BYTES, "Material texture file is missing or too large")
            payload = path.read_bytes()
            _require(hashlib.sha256(payload).hexdigest() == asset["sha256"], "Material texture hash does not match")
            validate_png(payload)
        entry.setdefault("createdAt", now())
        with self.lock:
            _atomic_json(self.entries/(entry["id"]+".json"), entry)
        return entry

    def create(self, data):
        prompt = data.get("prompt")
        _require(isinstance(prompt,str) and 1 <= len(prompt.strip()) <= 1200,"Material prompt must contain 1–1200 characters")
        self.client_factory()  # Fail missing credentials before creating a misleading job.
        with self.lock:
            active = [path for path in self.jobs.glob("*.json") if json.loads(path.read_text())["state"] in ("queued","running")]
            _require(len(active) < 4,"Wait for an existing material generation to finish or cancel it.")
            job = {"id":uuid.uuid4().hex,"state":"queued","phase":"waiting","prompt":prompt.strip(),"createdAt":now(),
                   "provider":"fal","model":MODEL}
            self._save(job)
            self.pending.put(job["id"])
            return self._summary(job)

    def cancel(self, job_id):
        with self.lock:
            job = self._get(job_id)
            if job["state"] in ("succeeded","failed","cancelled"):
                return self._summary(job)
            job.update(state="cancelled",notice="Stopped locally. A running provider request may still finish.")
            self._save(job)
            submission = job.get("submission")
        if submission:
            try:
                self.client_factory().cancel(submission)
            except MaterialProviderError:
                with self.lock:
                    job=self._get(job_id)
                    job["notice"]="Stopped locally; provider cancellation could not be confirmed. Check fal before generating again."
                    self._save(job)
        return self.get(job_id)

    def _update(self, job_id, **updates):
        with self.lock:
            job = self._get(job_id)
            if job["state"] == "cancelled":
                return None
            job.update(updates)
            self._save(job)
            return job

    def _import(self, job, result, client):
        images=result.get("images")
        _require(isinstance(images,list) and 1 <= len(images) <= 10,"Patina returned an invalid material image set")
        by_type={}
        for image in images:
            _require(isinstance(image,dict),"Patina image metadata is invalid")
            kind=image.get("map_type")
            if kind is None:
                continue  # The unlabelled generation preview is not a calibrated basecolor map.
            _require(kind in MAP_TYPES and kind not in by_type,"Patina returned duplicate or unknown PBR maps")
            by_type[kind]=image
        _require(set(by_type)==set(MAP_TYPES),"Patina did not return all five requested PBR maps")
        payloads={};textures={}
        for kind,image in by_type.items():
            with self.lock:
                if self._get(job["id"])["state"]=="cancelled":
                    return
            payload=client.download(image.get("url"))
            validate_png(payload)
            digest=hashlib.sha256(payload).hexdigest()
            asset={"path":f"assets/{digest}.png","sha256":digest,"format":"png"}
            payloads[asset["path"]]=payload
            textures[kind]=asset
        material={"name":job["prompt"][:64],"baseColor":[1,1,1,1],"roughness":1,"metallic":1,"transmission":0,"ior":1.45,
                  "textures":textures,"textureRepeat":[1,1],"normalScale":1,"heightScaleM":0}
        validate_material_textures(material)
        entry={"id":job["id"],"name":job["prompt"][:64],"material":material,"prompt":job["prompt"],
               "provider":"fal","model":MODEL,"createdAt":now()}
        if type(result.get("seed")) is int:
            entry["seed"]=result["seed"]
        with self.lock:
            if self._get(job["id"])["state"]=="cancelled":
                return
            for path,payload in payloads.items():
                _immutable_write(safe_asset_path(self.root,path),payload)
            _atomic_json(self.entries/(entry["id"]+".json"),entry)
            self._update(job["id"],state="succeeded",phase="complete",material=entry,error=None)

    def _run(self, job_id):
        try:
            job=self._get(job_id)
            if job["state"]=="cancelled":
                return
            client=self.client_factory()
            if not job.get("submission"):
                if self._update(job_id,state="running",phase="submitting") is None:
                    return
                try:
                    submission=client.submit(job["prompt"])
                except MaterialProviderError as error:
                    self._update(job_id,state="failed",error=str(error)+" Submission could not be confirmed; check fal before generating again.")
                    return
                with self.lock:
                    job=self._get(job_id)
                    job["submission"]=submission
                    self._save(job)
                if job["state"]=="cancelled":
                    client.cancel(submission)
                    return
                job=self._update(job_id,state="queued",phase="generating")
                if job is None:
                    return
            deadline=time.monotonic()+1800
            errors=0
            while time.monotonic()<deadline:
                with self.lock:
                    if self._get(job_id)["state"]=="cancelled":
                        return
                try:
                    response=client.status(job["submission"])
                    errors=0
                except MaterialProviderError as error:
                    errors+=1
                    if errors>=5:
                        raise MaterialProviderError("Could not retrieve fal status. Existing request retained; check fal before generating again.") from error
                    time.sleep(self.poll_interval)
                    continue
                state=response.get("status")
                _require(state in ("IN_QUEUE","IN_PROGRESS","COMPLETED"),"fal returned an unknown queue state")
                if state=="COMPLETED":
                    _require(not response.get("error"),"Patina could not generate this material. Try a different prompt.")
                    if self._update(job_id,state="running",phase="downloading") is None:
                        return
                    result=client.result(job["submission"])
                    self._import(job,result,client)
                    return
                if self._update(job_id,state="queued" if state=="IN_QUEUE" else "running",phase="generating") is None:
                    return
                time.sleep(self.poll_interval)
            raise MaterialProviderError("Material generation exceeded 30 minutes. Existing request retained; check fal before generating again.")
        except MaterialProviderError as error:
            self._update(job_id,state="failed",phase="failed",error=str(error))
        except (ValueError,KeyError,TypeError,OSError):
            self._update(job_id,state="failed",phase="failed",error="Material output could not be validated or saved. Existing request retained; no new generation was submitted.")

    def _worker(self):
        while True:
            job_id=self.pending.get()
            try:
                self._run(job_id)
            finally:
                self.pending.task_done()
