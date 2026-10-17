"""Run the single-provider experiment using an encrypted GitHub Environment key."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import uuid
import zipfile

from .jobs import _atomic_json, _lock
from .store import ROOT
from .worldlabs import TEXT_GENERATION_MAX_CREDITS
from .world_requests import generation_identity, identity_from_fingerprint
from .worlds import import_world, list_worlds, safe_asset_path

WORKFLOW = "worldlabs-pair.yml"
PRESETS = ("botanical-studio", "warm-gallery", "modern-loft")


class GitHubWorlds:
    def __init__(self, data_dir, repository=None):
        self.root = Path(data_dir)
        self.repository = repository or self._repository()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", self.repository):
            raise ValueError("Invalid GitHub repository")
        self.url = f"https://github.com/{self.repository}/actions/workflows/{WORKFLOW}"
        self.requests = self.root / "generation-requests"
        self.requests.mkdir(parents=True, exist_ok=True)
        self.results = self.root / "worldlabs-results"

    @staticmethod
    def _repository():
        result = subprocess.run(["git", "config", "--get", "remote.origin.url"], cwd=ROOT,
                                capture_output=True, text=True, timeout=5)
        remote = result.stdout.strip()
        match = re.fullmatch(r"(?:https://github.com/|git@github.com:)([^/]+/[^/]+?)(?:\.git)?", remote)
        return match[1] if match else "kimestelle/3d-product-suite"

    def api(self, path, *, method="GET", body=None):
        command = ["gh", "api", f"repos/{self.repository}/{path}", "--method", method]
        if body is not None:
            command += ["--input", "-"]
        result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                                capture_output=True, text=True, timeout=40)
        if result.returncode:
            raise RuntimeError("GitHub Actions request failed: " + (result.stderr.strip() or "Check gh authentication and Actions permissions")[-1000:])
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def runs(self):
        result = self.api(f"actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=12")
        return [{"id": r["id"], "status": r["status"], "conclusion": r["conclusion"], "url": r["html_url"],
                 "name": r.get("display_title", r.get("name")), "createdAt": r["created_at"]} for r in result["workflow_runs"]]

    def dispatch(self, data):
        with _lock(self.requests, ".dispatch.lock"):
            return self._dispatch_locked(data)

    def _dispatch_locked(self, data):
        if not isinstance(data, dict):
            raise ValueError("Generation request must be a JSON object")
        force_new = data.get("forceNew", False)
        if type(force_new) is not bool:
            raise ValueError("forceNew must be a boolean")
        image_url = data.get("imageUrl", "")
        if not isinstance(image_url, str):
            raise ValueError("Reference image URL must be a string")
        image_url = image_url.strip()
        if image_url:
            from .worldlabs import _validate_download_url
            _validate_download_url(image_url)
        preset = data.get("preset", "botanical-studio")
        if preset not in PRESETS:
            raise ValueError("Unknown default environment")
        budget = data.get("budgetCredits", 6000)
        if type(budget) is not int or not 5080 <= budget <= 6000:
            raise ValueError("This standard experiment requires 5,080–6,000 API credits")
        prompt = data.get("prompt", "")
        if not isinstance(prompt, str) or len(prompt) > 4000:
            raise ValueError("Prompt must be at most 4,000 characters")
        identity = generation_identity(prompt=prompt, preset=preset, image_url=image_url)
        cache_key = identity["key"]
        now = datetime.now(timezone.utc)
        records = self._request_records()
        matches = []
        for path, prior in records:
            if not prior.get("cacheKey"):
                # Old dispatches hashed the spending cap too. Reconstruct their
                # original digest, so changing only today's cap still reuses it.
                old_digest = hashlib.sha256(json.dumps({"image": image_url, "preset": preset,
                    "budget": prior.get("budgetCredits"), "prompt": prompt}, sort_keys=True).encode()).hexdigest()
                if prior.get("requestDigest") == old_digest:
                    prior["cacheKey"] = cache_key
                    _atomic_json(path, prior)
            if prior.get("cacheKey") == cache_key:
                matches.append(prior)
        matches.sort(key=lambda record: record.get("createdAt", ""), reverse=True)
        if not force_new:
            cached = self._local_result(cache_key)
            if cached is not None:
                return cached
            if matches:
                return self._reuse_request(matches[0])
        else:
            for prior in matches:
                if prior.get("forceNew") is True:
                    try:
                        age = (now - datetime.fromisoformat(prior["createdAt"])).total_seconds()
                    except (KeyError, TypeError, ValueError):
                        raise RuntimeError("A saved World Labs request has an invalid timestamp; inspect it before generating again")
                    if 0 <= age < 60:
                        return self._reuse_request(prior)
        # An uncertain submission is never replaced with another paid request,
        # including when the caller explicitly requests a new variation.
        for _, prior in records:
            if prior.get("state") in ("submitting", "unknown"):
                self._reuse_request(prior)
        experiment_id = uuid.uuid4().hex
        path = self.requests / f"{experiment_id}.json"
        record = {"id": experiment_id, "createdAt": now.isoformat(), "state": "submitting", "cacheKey": cache_key,
                  "forceNew": force_new, "budgetCredits": budget, "imageProvided": bool(image_url), "repository": self.repository}
        _atomic_json(path, record)
        try:
            self.api(f"actions/workflows/{WORKFLOW}/dispatches", method="POST", body={"ref": "main", "inputs": {
                "experiment_id": experiment_id, "prompt": prompt, "default_environment": preset,
                "reference_image_url": image_url, "model": "marble-1.1", "budget_credits": str(budget),
                "cache_key": cache_key, "force_new": "true" if force_new else "false"}})
        except BaseException:
            record["state"] = "unknown"
            _atomic_json(path, record)
            raise
        record.update(state="dispatched", workflowUrl=self.url)
        _atomic_json(path, record)
        return dict(record, cacheStatus="dispatched", needsImport=True)

    def _request_records(self):
        records = []
        for path in self.requests.glob("*.json"):
            try:
                record = json.loads(path.read_text())
                if (not isinstance(record, dict) or record.get("id") != path.stem
                        or not re.fullmatch(r"[a-f0-9]{32}", path.stem)):
                    raise ValueError("Invalid request identity")
                if "cacheKey" in record and (not isinstance(record["cacheKey"], str)
                        or not re.fullmatch(r"[a-f0-9]{64}", record["cacheKey"])):
                    raise ValueError("Invalid request cache key")
                if not isinstance(record.get("state"), str) or not record["state"]:
                    raise ValueError("Missing request state")
            except (OSError, ValueError) as error:
                raise RuntimeError("A saved World Labs request is unreadable; inspect generation-requests before generating again") from error
            if record.get("repository") == self.repository:
                records.append((path, record))
        return records

    def _reuse_request(self, record):
        if record.get("state") in ("submitting", "unknown"):
            raise RuntimeError(f"An earlier dispatch has an uncertain result ({record['id']}). Inspect GitHub Actions and recover its saved world or operation before starting another generation.")
        return dict(record, cacheStatus="reused-request", needsImport=True,
                    workflowUrl=record.get("workflowUrl", self.url))

    def _local_result(self, cache_key):
        path = self.results / f"{cache_key}.json"
        if not path.exists():
            return None
        try:
            result = json.loads(path.read_text())
            if (result.get("cacheKey") != cache_key or result.get("schemaVersion") != 1
                    or result.get("repository") != self.repository
                    or not re.fullmatch(r"[0-9]{1,20}", str(result.get("runId", "")))):
                raise ValueError("Invalid cached result identity")
            by_id = {entry["id"]: entry for entry in list_worlds(self.root)}
            selected = []
            for saved in result["worlds"]:
                entry = by_id[saved["id"]]
                if entry["environment"]["asset"]["sha256"] != saved["sha256"]:
                    raise ValueError("Cached world asset digest differs")
                selected.append(entry)
            if len(selected) != 3:
                raise ValueError("Cached comparison requires three representations")
            pair = {"provider": "worldlabs", "worldId": result["worldId"],
                    "mesh": selected[0], "splat": selected[1], "gaussianMesh": selected[2]}
            self._validate_pair_entries(pair, selected)
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            raise RuntimeError("Cached World Labs assets are incomplete or corrupt. Restore the cached files or re-import the existing successful GitHub run into a clean library; no replacement generation was submitted.") from error
        return {"cacheKey": cache_key, "cacheStatus": "local-hit", "needsImport": False,
                "state": "imported", "worlds": selected, "worldId": result["worldId"],
                "runId": str(result["runId"]), "workflowUrl": result.get("workflowUrl", self.url)}

    @staticmethod
    def _validated_pair(extracted):
        """Validate the complete archive and lineage before changing the library."""
        try:
            pair = json.loads((extracted / "world-pair.json").read_text())
        except (OSError, ValueError) as error:
            raise ValueError("Comparison artifact requires a valid world-pair.json") from error
        library = extracted / "world-library"
        entries = list_worlds(library)  # Also verifies every immutable asset hash.
        selected = GitHubWorlds._validate_pair_entries(pair, entries)
        comparison_path = extracted / "comparison" / "comparison.json"
        if comparison_path.exists():
            try:
                comparison = json.loads(comparison_path.read_text())
                conditions = comparison["conditions"]
                valid = (comparison["pairing"]["worldId"] == pair["worldId"]
                         and conditions == {"mesh": pair["mesh"]["id"], "gaussianMesh": pair["gaussianMesh"]["id"]})
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise ValueError("Comparison manifest is invalid") from error
            if not valid:
                raise ValueError("Comparison manifest does not match the paired provider world and representations")
        return pair, selected

    @staticmethod
    def _validate_pair_entries(pair, entries):
        if (not isinstance(pair, dict) or pair.get("provider") != "worldlabs"
                or not isinstance(pair.get("worldId"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", pair["worldId"])):
            raise ValueError("Comparison artifact has an invalid provider world identity")
        by_id = {entry["id"]: entry for entry in entries}
        selected = []
        for condition, kind, representation in (("mesh", "mesh", "hq-visual-glb"),
                                                ("splat", "splat", "gaussian-spz"),
                                                ("gaussianMesh", "mesh", "gaussian-reconstructed-mesh")):
            entry = pair.get(condition)
            if (not isinstance(entry, dict) or not isinstance(entry.get("id"), str)
                    or by_id.get(entry["id"]) != entry):
                raise ValueError(f"Comparison artifact is missing its verified {condition} representation")
            environment = entry["environment"]
            provenance = environment["provenance"]
            if (not entry["name"].strip() or len(entry["name"].strip()) > 160
                    or type(environment.get("fixture", False)) is not bool):
                raise ValueError("Comparison world name or fixture declaration is invalid")
            configuration = {"name": entry["name"].strip(), "provenance": provenance,
                             "asset": environment["asset"], "fixture": environment.get("fixture", False)}
            expected_id = "world-" + hashlib.sha256(json.dumps(configuration, sort_keys=True,
                separators=(",", ":"), allow_nan=False).encode()).hexdigest()[:24]
            if entry["id"] != expected_id:
                raise ValueError("Comparison world identity or lineage digest is invalid")
            if (environment["kind"] != kind or provenance.get("provider") != "worldlabs"
                    or provenance.get("providerWorldId") != pair["worldId"]
                    or provenance.get("representation") != representation):
                raise ValueError("Comparison representations do not share the claimed provider world and lineage")
            selected.append(entry)
        if len({entry["id"] for entry in selected}) != 3 or len(entries) != 3:
            raise ValueError("Comparison artifact must contain exactly its three distinct representations")
        splat = pair["splat"]["environment"]["asset"]
        reconstructed = pair["gaussianMesh"]["environment"]
        provenance = reconstructed["provenance"]
        report = provenance.get("reconstruction")
        if (provenance.get("sourceSplatSha256") != splat["sha256"] or not isinstance(report, dict)
                or report.get("sourceSha256") != splat["sha256"]):
            raise ValueError("Reconstructed mesh lineage does not match the paired Gaussian asset digest")
        for field in ("scaleToMeters", "translationM", "rotationXyzw"):
            if reconstructed["asset"][field] != splat[field]:
                raise ValueError("Reconstructed mesh alignment does not match its paired Gaussian asset")
        return selected

    def _artifact_identity(self, extracted, pair, run):
        """Bind verified artifact bytes to their provider-input fingerprint."""
        cache_key = None
        manifest_path = extracted / "experiment.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text())
                fingerprint = manifest["promptSha256"]
                model = manifest["model"]
                seed = manifest.get("seed", 42)
                if (manifest.get("provider") != "worldlabs" or manifest.get("worldId") != pair["worldId"]
                        or not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                        or model not in TEXT_GENERATION_MAX_CREDITS or type(seed) is not int):
                    raise ValueError("Invalid generation fingerprint")
                cache_key = identity_from_fingerprint(fingerprint, model, seed)
                if manifest.get("cacheKey", cache_key) != cache_key:
                    raise ValueError("Generation cache key differs from its fingerprint")
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise ValueError("Comparison experiment manifest has an invalid generation identity") from error
        request = None
        title = run.get("display_title", "")
        match = re.match(r"^([a-f0-9]{32})(?:\s|$)", title) if isinstance(title, str) else None
        if match:
            path = self.requests / f"{match[1]}.json"
            if path.exists():
                try:
                    record = json.loads(path.read_text())
                    if record.get("id") != match[1] or record.get("repository") != self.repository:
                        raise ValueError("Request identity differs from its workflow run")
                    saved_key = record.get("cacheKey")
                    if saved_key is not None and (not isinstance(saved_key, str)
                            or not re.fullmatch(r"[a-f0-9]{64}", saved_key)):
                        raise ValueError("Invalid request cache key")
                    if cache_key and saved_key and saved_key != cache_key:
                        raise ValueError("Artifact fingerprint differs from the dispatched request")
                    cache_key = cache_key or saved_key
                    request = (path, record)
                except (OSError, ValueError, TypeError, AttributeError) as error:
                    raise ValueError("Comparison artifact does not match its saved generation request") from error
        return cache_key, request

    def import_run(self, run_id):
        if not re.fullmatch(r"[0-9]{1,20}", str(run_id)):
            raise ValueError("Invalid workflow run ID")
        run = self.api(f"actions/runs/{run_id}")
        if run.get("conclusion") != "success" or run.get("path", "").split("@")[0] != f".github/workflows/{WORKFLOW}":
            raise ValueError("Import a successful World Labs comparison workflow run")
        artifact_list = self.api(f"actions/runs/{run_id}/artifacts")["artifacts"]
        artifacts = [a for a in artifact_list if a["name"].startswith(f"worldlabs-pair-{run_id}-") and not a["expired"]]
        if not artifacts:
            raise ValueError("This run has no available comparison artifact")
        artifact = max(artifacts, key=lambda a: a["id"])
        if artifact["size_in_bytes"] > 384 * 1024 * 1024:
            raise ValueError("Comparison archive exceeds the local import limit")
        with tempfile.TemporaryDirectory(prefix="worldlabs-import-", dir=self.root) as temporary:
            temporary = Path(temporary)
            archive_path = temporary / "world.zip"
            with archive_path.open("wb") as output:
                result = subprocess.run(["gh", "api", f"repos/{self.repository}/actions/artifacts/{artifact['id']}/zip"],
                                        stdout=output, stderr=subprocess.PIPE, timeout=180)
            if result.returncode:
                raise RuntimeError("Could not download the GitHub comparison artifact")
            extracted = temporary / "extracted"
            extracted.mkdir()
            with zipfile.ZipFile(archive_path) as archive:
                if sum(info.file_size for info in archive.infolist()) > 512 * 1024 * 1024:
                    raise ValueError("Expanded artifact exceeds the local import limit")
                for info in archive.infolist():
                    name = PurePosixPath(info.filename)
                    mode = info.external_attr >> 16
                    if name.is_absolute() or ".." in name.parts or "\\" in info.filename or stat.S_ISLNK(mode):
                        raise ValueError("Unsafe artifact member")
                archive.extractall(extracted)
            pair, entries = self._validated_pair(extracted)
            cache_key, request = self._artifact_identity(extracted, pair, run)
            library = extracted / "world-library"
            imported = []
            for entry in entries:
                environment = entry["environment"]
                asset = environment["asset"]
                imported.append(import_world(safe_asset_path(library, asset["path"]), self.root,
                    name=entry["name"], provenance=environment["provenance"], source_up=asset["sourceUp"],
                    scale_to_meters=asset["scaleToMeters"], translation_m=asset["translationM"],
                    rotation_xyzw=asset["rotationXyzw"], fixture=environment.get("fixture", False)))
            destination = self.root / "comparisons" / str(run_id)
            if (extracted / "comparison").is_dir() and not destination.exists():
                destination.parent.mkdir(exist_ok=True)
                shutil.copytree(extracted / "comparison", destination)
            result = {"runId": str(run_id), "worlds": imported, "worldId": pair["worldId"]}
            if cache_key:
                with _lock(self.requests, ".dispatch.lock"):
                    self.results.mkdir(exist_ok=True)
                    _atomic_json(self.results / f"{cache_key}.json", {
                        "schemaVersion": 1, "cacheKey": cache_key, "repository": self.repository,
                        "worldId": pair["worldId"], "runId": str(run_id),
                        "workflowUrl": run.get("html_url", self.url),
                        "worlds": [{"id": entry["id"], "sha256": entry["environment"]["asset"]["sha256"]}
                                   for entry in imported]})
                    if request:
                        path, record = request
                        record.update(cacheKey=cache_key, state="imported", runId=str(run_id),
                                      worldId=pair["worldId"], workflowUrl=run.get("html_url", self.url))
                        _atomic_json(path, record)
                result["cacheKey"] = cache_key
            return result
