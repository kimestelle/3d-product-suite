"""Moderated world submissions and server-owned subscription entitlements."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import struct
from urllib.parse import urlsplit

from .store import ConflictError, identifier, now
from .textures import verify_texture_asset
from .worldlabs import _atomic_json, _state_lock
from .worlds import _immutable_write, safe_asset_path, validate_provenance, verify_scene_assets

REVIEW_TURNAROUND = "2–3 business days"
STATES = ("pending_review", "changes_needed", "approved", "withdrawn")
MAX_SUBMISSIONS = 1000


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _text(value, name, limit, *, required=True):
    if not isinstance(value, str) or len(value) > limit or any(ord(char) < 32 for char in value):
        raise ValueError(f"{name} must be text up to {limit} characters")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{name} is required")
    return value


def _read(path):
    if path.is_symlink() or path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("Marketplace record exceeds its supported size")
    return json.loads(path.read_text(encoding="utf-8"))


def _extent(path, asset, count):
    """Read fixed-point source centers only; covariance never proves a solid wall."""
    if asset["format"] != "spz":
        return None
    with gzip.open(path, "rb") as stream:
        header = stream.read(16)
        _, version, points, _, bits, _, _ = struct.unpack("<III4B", header)
        if version not in (2, 3) or points != count or count > 2_000_000:
            return None
        minimum, maximum = [float("inf")] * 3, [float("-inf")] * 3
        remaining = count
        while remaining:
            batch = min(8192, remaining)
            raw = stream.read(batch * 9)
            if len(raw) != batch * 9:
                raise ValueError("Truncated SPZ positions")
            for offset in range(0, len(raw), 9):
                for axis in range(3):
                    start = offset + axis * 3
                    value = int.from_bytes(raw[start:start + 3], "little", signed=True) * 2 ** -bits
                    minimum[axis] = min(minimum[axis], value)
                    maximum[axis] = max(maximum[axis], value)
            remaining -= batch
    return {"min": minimum, "max": maximum}


class Marketplace:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.directory = self.root / "marketplace"

    def _folder(self, submission_id):
        return self.directory / "submissions" / identifier(submission_id)

    def membership(self):
        path = self.directory / "membership.json"
        if not path.exists():
            return {"active": False, "configured": False}
        active = False
        try:
            record = _read(path)
            expiry = datetime.fromisoformat(record["expiresAt"].replace("Z", "+00:00"))
            active = (record.get("schemaVersion") == 1 and record.get("subscriptionStatus") == "active"
                      and expiry.tzinfo is not None and expiry > datetime.now(timezone.utc))
        except (KeyError, TypeError, ValueError, OSError):
            pass
        return {"active": active, "configured": True}

    def _records(self):
        for file in (self.directory / "submissions").glob("*/review.json"):
            record = _read(file)
            if record.get("id") != file.parent.name or record.get("state") not in STATES:
                raise ValueError("Invalid marketplace review record")
            yield record

    def _snapshot(self, submission_id):
        snapshot = _read(self._folder(submission_id) / "snapshot.json")
        identity = {key: snapshot[key] for key in ("worldSha256", "name", "creator", "description", "tags")}
        expected_id = "listing-" + hashlib.sha256(_canonical(identity)).hexdigest()[:24]
        if (snapshot.get("id") != submission_id or expected_id != submission_id
                or hashlib.sha256(_canonical(snapshot["world"])).hexdigest() != snapshot.get("worldSha256")):
            raise ValueError("Submitted world snapshot changed")
        return snapshot

    def _audit(self, world):
        issues, facts = [], {}
        try:
            environment = world["environment"]
            if world["id"] != environment["revisionId"] or environment["kind"] not in ("splat", "mesh"):
                raise ValueError("World identity is invalid")
            validate_provenance(environment["provenance"])
            assets = verify_scene_assets({"environment": environment}, self.root)
            asset = environment["asset"]
            facts = next({key: record[key] for key in ("bytes", "pointCount") if key in record}
                         for record in assets if record["sha256"] == asset["sha256"])
            facts["format"] = asset["format"]
            if asset["format"] == "spz":
                facts["coordinateBounds"] = _extent(safe_asset_path(self.root, asset["path"]), asset, facts.get("pointCount", 0))
                if facts["coordinateBounds"] is None:
                    issues.append("This Gaussian layout needs an additional geometry review.")
        except (KeyError, TypeError, ValueError, OSError, StopIteration, EOFError, struct.error):
            issues.append("World assets, alignment, or ownership metadata failed validation.")
        preview = world.get("previewAsset")
        try:
            if not isinstance(preview, dict) or preview.get("format") not in ("png", "jpg", "jpeg", "webp"):
                raise ValueError("No image cover")
            image = verify_texture_asset(preview, self.root)
            if max(image["widthPx"], image["heightPx"]) > 2048 or image["bytes"] > 2 * 1024 * 1024:
                raise ValueError("Cover exceeds bounds")
        except (KeyError, TypeError, ValueError, OSError):
            issues.append("A verified room image is required before publication.")
        return {"schemaVersion": 1, "checkedAt": now(), "passed": not issues, "issues": issues, "facts": facts,
                "summary": "Asset integrity and attribution fields checked. Visual review is pending." if not issues else "Submission needs changes before visual approval.",
                "interiorCleanup": world.get("interiorCleanup"),
                "limits": "File checks do not certify straight walls, coherent lighting, or hidden Gaussian surfaces."}

    def submit(self, world, metadata=None):
        metadata = metadata or {}
        if not isinstance(world, dict) or not isinstance(metadata, dict):
            raise ValueError("A saved world and submission details are required")
        world = copy.deepcopy(world)
        name = _text(world.get("name"), "World name", 160)
        provenance = world.get("environment", {}).get("provenance", {})
        creator = _text(metadata.get("creator", provenance.get("owner", "")), "Creator", 120)
        description = _text(metadata.get("description", ""), "Description", 1200, required=False)
        tags = metadata.get("tags", [])
        if not isinstance(tags, list) or len(tags) > 8:
            raise ValueError("Choose at most eight tags")
        tags = list(dict.fromkeys(_text(tag, "Tag", 32) for tag in tags))
        details = {"name": name, "creator": creator, "description": description, "tags": tags}
        source_hash = hashlib.sha256(_canonical(world)).hexdigest()
        submission_id = "listing-" + hashlib.sha256(_canonical({"worldSha256": source_hash, **details})).hexdigest()[:24]
        with _state_lock(self.directory):
            folder = self._folder(submission_id)
            if (folder / "review.json").exists():
                return self.submission(submission_id)
            if len(list(self._records())) >= MAX_SUBMISSIONS:
                raise ValueError("The community review queue is full")
            audit = self._audit(world)
            if "interiorCleanup" in metadata:
                audit["interiorCleanup"] = copy.deepcopy(metadata["interiorCleanup"])
            snapshot = {"schemaVersion": 1, "id": submission_id, "worldSha256": source_hash, "world": world, **details}
            _immutable_write(folder / "snapshot.json", _canonical(snapshot))
            _atomic_json(folder / "audit.json", audit)
            _atomic_json(folder / "review.json", {"schemaVersion": 1, "id": submission_id,
                         "state": "pending_review" if audit["passed"] else "changes_needed", "createdAt": now(), "updatedAt": now()})
            return self.submission(submission_id)

    def submit_saved(self, body):
        if not isinstance(body, dict) or body.get("communityOptIn") is not True:
            raise ValueError("Community submission requires an explicit opt-in")
        world_id = identifier(body.get("worldId"))
        world = _read(safe_asset_path(self.root, f"worlds/{world_id}.json"))
        return self.submit(world, {key: body[key] for key in ("creator", "description", "tags") if key in body})

    def submission(self, submission_id):
        folder = self._folder(submission_id)
        review, snapshot, audit = _read(folder / "review.json"), self._snapshot(submission_id), _read(folder / "audit.json")
        return {**{key: snapshot[key] for key in ("id", "name", "creator", "description", "tags")}, **review, "audit": audit,
                "reviewTurnaround": REVIEW_TURNAROUND}

    def submissions(self):
        return {"submissions": [self.submission(record["id"]) for record in self._records()], "reviewTurnaround": REVIEW_TURNAROUND}

    def review(self, submission_id, state, *, reviewer, notes="", published_url=None):
        if state not in ("approved", "changes_needed", "withdrawn"):
            raise ValueError("Choose approved, changes_needed, or withdrawn")
        reviewer = _text(reviewer, "Reviewer", 120)
        notes = _text(notes, "Review notes", 1200, required=False)
        if published_url is not None:
            parsed = urlsplit(published_url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("Publication evidence must be a public HTTPS URL")
        with _state_lock(self.directory):
            folder = self._folder(submission_id)
            record = _read(folder / "review.json")
            if record["state"] == "withdrawn" and state != "withdrawn":
                raise ConflictError("A withdrawn submission needs a new explicit submission")
            if state == "approved":
                audit = self._audit(self._snapshot(submission_id)["world"])
                if not audit["passed"]:
                    raise ConflictError("Resolve the asset and cover audit before approving this world")
                _atomic_json(folder / "audit.json", audit)
            record.update(state=state, reviewer=reviewer, notes=notes, reviewedAt=now(), updatedAt=now())
            if published_url:
                record["publicationEvidence"] = published_url
            _atomic_json(folder / "review.json", record)
        return self.submission(submission_id)

    def withdraw(self, submission_id):
        return self.review(submission_id, "withdrawn", reviewer="Workspace owner", notes="Withdrawn through the connected workspace.")

    def resubmit(self, submission_id):
        """A fresh owner opt-in reopens review; it cannot restore approval."""
        with _state_lock(self.directory):
            folder = self._folder(submission_id)
            record = _read(folder / "review.json")
            if record["state"] != "withdrawn":
                return self.submission(submission_id)
            audit = self._audit(self._snapshot(submission_id)["world"])
            _atomic_json(folder / "audit.json", audit)
            record.update(state="pending_review" if audit["passed"] else "changes_needed", updatedAt=now())
            for key in ("reviewer", "notes", "reviewedAt", "publicationEvidence"):
                record.pop(key, None)
            _atomic_json(folder / "review.json", record)
        return self.submission(submission_id)

    def _approved(self, submission_id):
        record = _read(self._folder(submission_id) / "review.json")
        if record.get("state") != "approved":
            raise FileNotFoundError("World is not published")
        return record, self._snapshot(submission_id)

    def detail(self, submission_id):
        record, snapshot = self._approved(submission_id)
        world, audit = snapshot["world"], _read(self._folder(submission_id) / "audit.json")
        preview_url = f"/api/marketplace/{submission_id}/preview"
        return {**{key: snapshot[key] for key in ("id", "name", "creator", "description", "tags")},
                "kind": world["environment"]["kind"], "format": audit["facts"].get("format"), "previewUrl": preview_url,
                "previewUrls": [preview_url], "assetBytes": audit["facts"].get("bytes"), "splatCount": audit["facts"].get("pointCount"),
                "createdAt": record["createdAt"], "reviewedAt": record["reviewedAt"],
                "audit": {"summary": "File checks and reviewer approval completed."},
                "downloadUrl": f"/api/marketplace/{submission_id}/download"}

    def list(self):
        return {"listings": [self.detail(record["id"]) for record in self._records() if record["state"] == "approved"],
                "membership": self.membership(), "reviewTurnaround": REVIEW_TURNAROUND}

    def preview(self, submission_id):
        _, snapshot = self._approved(submission_id)
        cover = snapshot["world"]["previewAsset"]
        verify_texture_asset(cover, self.root)
        return safe_asset_path(self.root, cover["path"])

    def download(self, submission_id):
        _, snapshot = self._approved(submission_id)
        if not self.membership()["active"]:
            raise PermissionError("An active subscription is required to download community worlds")
        world = snapshot["world"]
        verify_scene_assets({"environment": world["environment"]}, self.root)
        return safe_asset_path(self.root, world["environment"]["asset"]["path"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("workspace-data"))
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("list")
    review = actions.add_parser("review")
    review.add_argument("id")
    review.add_argument("--state", choices=("approved", "changes_needed", "withdrawn"), required=True)
    review.add_argument("--reviewer", required=True)
    review.add_argument("--notes", default="")
    seed = actions.add_parser("seed")
    seed.add_argument("--world", type=Path, required=True)
    seed.add_argument("--published-url", required=True)
    seed.add_argument("--reviewer", required=True)
    seed.add_argument("--description", default="")
    args = parser.parse_args(argv)
    service = Marketplace(args.root)
    if args.action == "list":
        result = service.submissions()
    elif args.action == "review":
        result = service.review(args.id, args.state, reviewer=args.reviewer, notes=args.notes)
    else:
        submitted = service.submit(_read(args.world), {"description": args.description})
        result = service.review(submitted["id"], "approved", reviewer=args.reviewer,
                                notes="Previously reviewed public world, explicitly seeded by the workspace owner.", published_url=args.published_url)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
