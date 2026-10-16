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
        request_digest = hashlib.sha256(json.dumps({"image": image_url, "preset": preset,
            "budget": budget, "prompt": prompt}, sort_keys=True).encode()).hexdigest()
        now = datetime.now(timezone.utc)
        # An uncertain submission is never replaced with a fresh paid request.
        for path in self.requests.glob("*.json"):
            prior = json.loads(path.read_text())
            if prior.get("state") in ("submitting", "unknown"):
                raise RuntimeError(f"An earlier dispatch has an uncertain result ({prior['id']}). Inspect GitHub Actions before starting another generation.")
            if (prior.get("state") == "dispatched" and prior.get("requestDigest") == request_digest
                    and (now - datetime.fromisoformat(prior["createdAt"])).total_seconds() < 60):
                return prior
        experiment_id = uuid.uuid4().hex
        path = self.requests / f"{experiment_id}.json"
        record = {"id": experiment_id, "createdAt": now.isoformat(), "state": "submitting", "requestDigest": request_digest,
                  "budgetCredits": budget, "imageProvided": bool(image_url), "repository": self.repository}
        _atomic_json(path, record)
        try:
            self.api(f"actions/workflows/{WORKFLOW}/dispatches", method="POST", body={"ref": "main", "inputs": {
                "experiment_id": experiment_id, "prompt": prompt, "default_environment": preset,
                "reference_image_url": image_url, "model": "marble-1.1", "budget_credits": str(budget)}})
        except BaseException:
            record["state"] = "unknown"
            _atomic_json(path, record)
            raise
        record.update(state="dispatched", workflowUrl=self.url)
        _atomic_json(path, record)
        return record

    @staticmethod
    def _validated_pair(extracted):
        """Validate the complete archive and lineage before changing the library."""
        try:
            pair = json.loads((extracted / "world-pair.json").read_text())
        except (OSError, ValueError) as error:
            raise ValueError("Comparison artifact requires a valid world-pair.json") from error
        if (not isinstance(pair, dict) or pair.get("provider") != "worldlabs"
                or not isinstance(pair.get("worldId"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", pair["worldId"])):
            raise ValueError("Comparison artifact has an invalid provider world identity")
        library = extracted / "world-library"
        entries = list_worlds(library)  # Also verifies every immutable asset hash.
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
            return {"runId": str(run_id), "worlds": imported, "worldId": pair["worldId"]}
