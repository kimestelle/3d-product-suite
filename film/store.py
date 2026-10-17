"""Local projects with immutable scene revisions and optimistic saves."""

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import threading
import uuid

from .jobs import _atomic_json
from .scene import load_scene, scene_digest, validate_scene
from .worlds import bundle_assets, verify_scene_assets

ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = re.compile(r"[a-z0-9-]{1,64}\Z")


class ConflictError(ValueError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError("Invalid record identifier")
    return value


class ProjectStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.projects = self.root / "projects"
        self.projects.mkdir(parents=True, exist_ok=True)
        (self.root / "assets").mkdir(exist_ok=True)
        self.lock = threading.RLock()

    def _directory(self, project_id):
        return self.projects / identifier(project_id)

    def list(self):
        with self.lock:
            records = []
            for path in self.projects.glob("*/index.json"):
                record = json.loads(path.read_text())
                records.append({k: record[k] for k in ("id", "name", "updatedAt", "revisionId", "approvedRevisionId")})
            return sorted(records, key=lambda x: x["updatedAt"], reverse=True)

    def get(self, project_id, revision=None):
        with self.lock:
            directory = self._directory(project_id)
            index = json.loads((directory / "index.json").read_text())
            selected = identifier(revision or index["revisionId"])
            saved = json.loads((directory / "revisions" / f"{selected}.json").read_text())
            validate_scene(saved["scene"])
            verify_scene_assets(saved["scene"], self.root)
            return {**index, "scene": saved["scene"], "headRevisionId": index["revisionId"], "revisionId": selected}

    def create(self, name="MORA / Campaign 01", scene=None, *, source_dir=None):
        if scene is None:
            scene = load_scene(ROOT / "examples" / "bottle.scene.json")
            scene["environment"]["plinth"]["visible"] = False
            scene["environment"]["floorY"] = 0
            scene["placement"]["restsOn"] = "floor"
        else:
            validate_scene(scene)
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("Project name must contain 1–120 characters")
        with self.lock:
            bundle_assets(scene, self.root if source_dir is None else source_dir, self.root)
            project_id = uuid.uuid4().hex
            directory = self._directory(project_id)
            (directory / "revisions").mkdir(parents=True)
            revision = scene_digest(scene)
            timestamp = now()
            _atomic_json(directory / "revisions" / f"{revision}.json", {"scene": scene, "createdAt": timestamp})
            _atomic_json(directory / "index.json", {"id": project_id, "name": name.strip(), "createdAt": timestamp,
                         "updatedAt": timestamp, "revisionId": revision, "approvedRevisionId": None})
            return self.get(project_id)

    def save(self, project_id, scene, expected_revision, name=None, *, source_dir=None):
        validate_scene(scene)
        with self.lock:
            current = self.get(project_id)
            if expected_revision != current["revisionId"]:
                raise ConflictError("This project changed in another session. Reopen it before saving.")
            if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 120):
                raise ValueError("Project name must contain 1–120 characters")
            bundle_assets(scene, self.root if source_dir is None else source_dir, self.root)
            directory = self._directory(project_id)
            revision = scene_digest(scene)
            path = directory / "revisions" / f"{revision}.json"
            if not path.exists():
                _atomic_json(path, {"scene": scene, "createdAt": now()})
            index = {k: v for k, v in current.items() if k not in ("scene", "headRevisionId")}
            index.update(revisionId=revision, updatedAt=now())
            if name is not None:
                index["name"] = name.strip()
            _atomic_json(directory / "index.json", index)
            return self.get(project_id)

    def approve(self, project_id, expected_revision):
        with self.lock:
            current = self.get(project_id)
            if expected_revision != current["revisionId"]:
                raise ConflictError("Save or reopen the current revision before approving it.")
            index = {k: v for k, v in current.items() if k not in ("scene", "headRevisionId")}
            index.update(approvedRevisionId=current["revisionId"], updatedAt=now())
            _atomic_json(self._directory(project_id) / "index.json", index)
            return self.get(project_id)

    def scene_source(self, scene):
        """Put scene files beside the immutable assets directory for job bundling."""
        validate_scene(scene)
        digest = scene_digest(scene)
        path = self.root / f"{digest}.scene.json"
        with self.lock:
            verify_scene_assets(scene, self.root)
            if not path.exists():
                _atomic_json(path, scene)
            elif load_scene(path) != scene:
                raise ValueError("Content-addressed source scene was modified")
        return path

    def bootstrap(self):
        with self.lock:
            projects = self.list()
            return self.get(projects[0]["id"]) if projects else self.create()

    def seed_worlds(self):
        from .worlds import import_world
        provenance = {"source": "Original synthetic room fixtures from scripts/create_world_fixtures.py; not World Labs output",
                      "owner": "3d-product-suite project", "reuseBasis": "Original project fixture for engineering tests",
                      "allowedExternalDestinations": []}
        for suffix, name in (("glb", "Fixture room · mesh"), ("ply", "Fixture room · Gaussian")):
            path = ROOT / "examples" / "worlds" / f"neutral-room.{suffix}"
            if path.is_file():
                import_world(path, self.root, name=name, provenance=provenance, source_up="Y", fixture=True)
        defaults_path = ROOT / "examples" / "worlds" / "defaults.json"
        if defaults_path.exists():
            defaults = json.loads(defaults_path.read_text())
            for default in defaults["environments"]:
                path = defaults_path.parent / default["assetFile"]
                import_world(path, self.root, name=f"Default · {default['displayName']}", provenance=default["provenance"],
                             source_up=default["sourceUp"], fixture=True)
