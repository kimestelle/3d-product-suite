#!/usr/bin/env python3
"""Seed the private World Labs cache from an existing verified GitHub artifact.

This script reads GitHub artifacts only. It never constructs a World Labs client
and cannot generate a world or export a mesh.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import select
import stat
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film.github_worlds import GitHubWorlds, WORKFLOW  # noqa: E402
from film.world_cache import WorldCache, read_json, verify_pair  # noqa: E402
from film.world_requests import generation_identity  # noqa: E402

MAX_ARCHIVE_BYTES = 384 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024


def identity_from_environment():
    if os.environ.get("WORLDLABS_FORCE_NEW", "").lower() in ("1", "true", "yes"):
        raise ValueError("An existing artifact cannot seed an explicitly new variation")
    return generation_identity(
        prompt=os.environ.get("WORLDLABS_PROMPT", ""),
        preset=os.environ.get("WORLDLABS_DEFAULT_ENVIRONMENT") or "botanical-studio",
        model=os.environ.get("WORLDLABS_MODEL") or "marble-1.1",
        image_url=os.environ.get("WORLDLABS_REFERENCE_IMAGE_URL", ""),
    )


def _download_archive(repository, artifact_id, destination):
    """Bound the actual download, independently of GitHub's size metadata."""
    command = ["gh", "api", f"repos/{repository}/actions/artifacts/{artifact_id}/zip"]
    deadline = time.monotonic() + 180
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            total = 0
            with Path(destination).open("wb") as output:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                        raise RuntimeError("GitHub comparison artifact download timed out")
                    chunk = os.read(process.stdout.fileno(), 64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARCHIVE_BYTES:
                        raise ValueError("Comparison archive exceeds the cache import limit")
                    output.write(chunk)
            if process.wait(timeout=max(0.1, deadline - time.monotonic())):
                raise RuntimeError("Could not download the existing GitHub comparison artifact")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def _extract_archive(archive_path, extracted):
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Comparison archive exceeds the cache import limit")
    with zipfile.ZipFile(archive_path) as archive:
        members = archive.infolist()
        if len(members) > 20000 or sum(info.file_size for info in members) > MAX_EXPANDED_BYTES:
            raise ValueError("Expanded comparison artifact exceeds the cache import limit")
        seen = set()
        for info in members:
            name = PurePosixPath(info.filename)
            mode = info.external_attr >> 16
            if (not name.parts or name.is_absolute() or ".." in name.parts or "\\" in info.filename
                    or ":" in name.parts[0] or stat.S_ISLNK(mode)
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or name.as_posix() in seen):
                raise ValueError("Unsafe comparison artifact member")
            seen.add(name.as_posix())
        archive.extractall(extracted)


def seed_from_run(run_id, cache_dir, *, repository=None, identity=None, downloader=None):
    """Read, validate and seed one completed result; any mismatch fails closed."""
    run_id = str(run_id)
    if not re.fullmatch(r"[0-9]{1,20}", run_id):
        raise ValueError("Invalid existing workflow run ID")
    identity = identity or identity_from_environment()
    with tempfile.TemporaryDirectory(prefix="worldlabs-cache-seed-") as temporary:
        temporary = Path(temporary)
        github = GitHubWorlds(temporary / "github", repository=repository or os.environ.get("GITHUB_REPOSITORY"))
        run = github.api(f"actions/runs/{run_id}")
        if (run.get("conclusion") != "success"
                or run.get("path", "").split("@")[0] != f".github/workflows/{WORKFLOW}"):
            raise ValueError("Cache seeding requires a successful World Labs comparison workflow run")
        artifacts = github.api(f"actions/runs/{run_id}/artifacts").get("artifacts", [])
        matching = [artifact for artifact in artifacts
                    if isinstance(artifact, dict)
                    and re.fullmatch(rf"worldlabs-pair-{run_id}-[0-9]+", artifact.get("name", ""))
                    and artifact.get("expired") is False]
        if not matching:
            raise ValueError("The existing run has no available comparison artifact")
        if any(type(artifact.get("id")) is not int or artifact["id"] <= 0 for artifact in matching):
            raise ValueError("Invalid GitHub comparison artifact identity")
        artifact = max(matching, key=lambda entry: entry["id"])
        if (type(artifact.get("size_in_bytes")) is not int
                or not 0 <= artifact["size_in_bytes"] <= MAX_ARCHIVE_BYTES):
            raise ValueError("Comparison archive exceeds the cache import limit")
        archive_path = temporary / "world.zip"
        (downloader or _download_archive)(github.repository, artifact["id"], archive_path)
        extracted = temporary / "extracted"
        extracted.mkdir()
        _extract_archive(archive_path, extracted)
        pair, _ = github._validated_pair(extracted)
        manifest = read_json(extracted / "experiment.json")
        cache_key, _ = github._artifact_identity(extracted, pair, run)
        if (manifest.get("state") != "prepared-for-review" or manifest.get("worldId") != pair["worldId"]
                or cache_key != identity["key"]):
            raise ValueError("Existing comparison is incomplete or belongs to a different provider request")
        verify_pair(extracted)
        cache = WorldCache(cache_dir, identity)
        with cache.locked():
            existing = cache.completed_pair()
            if existing is not None:
                if existing != pair:
                    raise ValueError("The cache already contains a different completed world; preserve it for review")
            else:
                cache.seed_from_output(extracted, manifest)
            # Verify the copied bytes too, before allowing the generation step.
            if cache.completed_pair() != pair:
                raise ValueError("The existing artifact did not produce a complete verified cache entry")
    return {"cacheKey": identity["key"], "worldId": pair["worldId"], "sourceRunId": run_id,
            "additionalProviderCredits": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/worldlabs"))
    args = parser.parse_args()
    try:
        result = seed_from_run(args.run_id, args.cache_dir)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Existing World Labs cache import failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
