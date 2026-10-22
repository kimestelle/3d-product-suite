"""Private, content-verified World Labs assets and a durable per-request journal.

Cache failure never authorizes a replacement paid generation. Provider state is
written directly inside the locked entry so interruption cannot lose accepted IDs.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil

from . import worldlabs, worlds


def read_json(path):
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise worldlabs.WorldLabsError("Cannot read cached World Labs state; preserve it and recover the existing operation") from None
    worldlabs._require(isinstance(document, dict), "Invalid cached World Labs state")
    return document


def verify_pair(directory):
    """Validate all three immutable assets, library documents and shared lineage."""
    directory = Path(directory)
    pair = read_json(directory / "world-pair.json")
    world_id = worldlabs._identifier(pair.get("worldId"), "cached provider world ID")
    worldlabs._require(pair.get("provider") == "worldlabs", "Cached pair has a different provider")
    entries = {entry["id"]: entry for entry in worlds.list_worlds(directory / "world-library")}
    representations = {"mesh": ("mesh", "hq-visual-glb"), "splat": ("splat", "gaussian-spz"),
                       "gaussianMesh": ("mesh", "gaussian-reconstructed-mesh")}
    for kind, (environment_kind, representation) in representations.items():
        entry = pair.get(kind)
        worldlabs._require(isinstance(entry, dict) and entries.get(entry.get("id")) == entry,
                           "Cached pair does not match its immutable world library")
        environment = entry["environment"]
        provenance = environment["provenance"]
        worldlabs._require(environment["kind"] == environment_kind
                           and provenance.get("provider") == "worldlabs"
                           and provenance.get("providerWorldId") == world_id
                           and provenance.get("representation") == representation,
                           "Cached world pair has inconsistent provider lineage")
        configuration = {"name": entry["name"], "provenance": provenance, "asset": environment["asset"],
                         "fixture": bool(environment.get("fixture"))}
        expected_id = "world-" + hashlib.sha256(worlds._canonical(configuration)).hexdigest()[:24]
        worldlabs._require(entry["id"] == expected_id, "Cached world revision identity is invalid")
    worldlabs._require(len(entries) == 3 and len({pair[kind]["id"] for kind in representations}) == 3,
                       "Cached pair must contain exactly its three distinct representations")
    source_hash = pair["splat"]["environment"]["asset"]["sha256"]
    reconstructed = pair["gaussianMesh"]["environment"]
    worldlabs._require(reconstructed["provenance"].get("sourceSplatSha256") == source_hash,
                       "Cached reconstructed mesh refers to a different Gaussian source")
    for field in ("scaleToMeters", "translationM", "rotationXyzw"):
        worldlabs._require(reconstructed["asset"][field] == pair["splat"]["environment"]["asset"][field],
                           "Cached reconstructed mesh alignment differs from its Gaussian source")
    worldlabs._require(reconstructed["provenance"].get("reconstruction", {}).get("sourceSha256") == source_hash,
                       "Cached reconstructed mesh report has inconsistent Gaussian lineage")
    report = pair.get("reconstruction")
    worldlabs._require(isinstance(report, dict) and report.get("sourceSha256") == source_hash,
                       "Cached reconstruction report refers to a different Gaussian source")
    return pair


def copy_payload(source, destination, *, include_manifest=False):
    """Copy private local artifacts; journals remain authoritative in the cache."""
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        return
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("provider-state", "world-library", "reconstruction"):
        if (source / name).exists():
            shutil.copytree(source / name, destination / name, dirs_exist_ok=True)
    names = ["world-pair.json"] + (["experiment.json"] if include_manifest else [])
    for name in names:
        if (source / name).is_file():
            worldlabs._atomic_json(destination / name, read_json(source / name))


class WorldCache:
    def __init__(self, root, identity, *, variation=None):
        self.identity = {name: identity[name] for name in ("key", "promptSha256", "model", "seed")}
        root = Path(root)
        if variation:
            root = root / "variations" / worldlabs._identifier(variation, "cache variation ID")
        self.directory = root / identity["key"]
        self.record = None

    @contextmanager
    def locked(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        descriptor = os.open(self.directory / ".cache.lock", os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            # Wait for the first caller to finish, then inspect its result. Never
            # race a second paid submission for an identical provider request.
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            path = self.directory / "cache.json"
            if path.exists():
                self.record = read_json(path)
                worldlabs._require(self.record.get("schemaVersion") == 1
                                   and self.record.get("provider") == "worldlabs"
                                   and all(self.record.get(key) == value for key, value in self.identity.items()),
                                   "Cached World Labs request identity is invalid; preserve it for recovery")
                worldlabs._require(self.record.get("status") in ("prepared", "incomplete", "completed")
                                   and type(self.record.get("providerWorkStarted")) is bool
                                   and (self.record["status"] == "prepared") == (not self.record["providerWorkStarted"]),
                                   "Cached World Labs lifecycle is invalid; preserve it for recovery")
                worldlabs._require(not self.record.get("seedInProgress"),
                                   "Cached existing-world copy was interrupted; restore its preserved original assets and journals before continuing")
            else:
                worldlabs._require(not any(path.name != ".cache.lock" for path in self.directory.iterdir()),
                                   "Cached World Labs identity is missing; preserve existing state for recovery")
                self.record = {"schemaVersion": 1, "provider": "worldlabs", **self.identity,
                               "status": "prepared", "providerWorkStarted": False}
                self.save()
            yield self
        finally:
            os.close(descriptor)

    def save(self, **updates):
        self.record.update(updates)
        worldlabs._atomic_json(self.directory / "cache.json", self.record)

    def completed_pair(self):
        if self.record["status"] != "completed":
            return None
        pair = verify_pair(self.directory)
        worldlabs._require(self.record.get("worldId") == pair["worldId"],
                           "Cached provider world identity does not match its assets")
        return pair

    def seed_from_output(self, output, manifest):
        """Backfill compatible pre-cache work without creating provider requests."""
        worldlabs._require(not self.record.get("providerWorkStarted"), "Cache already contains provider work")
        if manifest.get("state") == "prepared-for-review":
            pair = verify_pair(output)
            worldlabs._require(manifest.get("worldId") == pair["worldId"], "Existing experiment has different world lineage")
            # This source already represents accepted, paid work. Commit that
            # fact before a potentially interrupted filesystem copy, so a new
            # output can never mistake a partially seeded entry for a miss.
            self.save(status="completed", worldId=pair["worldId"], providerWorkStarted=True,
                      backfilledExistingOutput=True, seedInProgress=True)
            copy_payload(output, self.directory, include_manifest=True)
            self.save(seedInProgress=False)
        elif (Path(output) / "provider-state").exists() or manifest.get("worldId"):
            self.save(status="incomplete", providerWorkStarted=True, worldId=manifest.get("worldId"),
                      backfilledExistingOutput=True, seedInProgress=True)
            copy_payload(output, self.directory, include_manifest=True)
            self.save(seedInProgress=False)
