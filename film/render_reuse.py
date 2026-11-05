"""Verified, bounded ungraded masters shared by sibling render jobs.

This is an optional accelerator. It never changes a scene, output profile or
sample count. A new job first creates its own native scene/execution receipt;
only then can a matching raw PNG avoid a frame render. Image finishing and
encoding remain owned by that new job.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
import fcntl
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

from .render_devices import _valid_execution

MIB = 1024 * 1024
MAX_ENTRIES = 4096
SCHEMA = "verified-raw-master-v1"
_HEX = re.compile(r"[a-f0-9]{64}\Z")


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _digest(value):
    return hashlib.sha256(_json(value)).hexdigest()


def _hash_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _regular(path, maximum):
    try:
        info = path.lstat()
        return stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= maximum
    except OSError:
        return False


@lru_cache(maxsize=16)
def _binary_digest(path, identity):
    return _hash_file(Path(path))


def tool_identity(command):
    """Same version text is insufficient to identify a native renderer build."""
    resolved = shutil.which(str(command))
    if not resolved:
        return None
    path = Path(resolved).resolve()
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        return None
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return {"path": str(path), "sha256": _binary_digest(str(path), identity)}


def physical_scene(scene, profile, first_sample):
    """Keep all static inputs; bind animation/editorial changes to actual poses.

    The renderer uses the first sample to anchor implicit lights/support, so its
    object/part/light state also participates. Source actions remain because
    they influence which assembly root establishes that rig. Frame number and
    FPS remain conservative pixel dependencies even though animated RNG is off.
    """
    source = copy.deepcopy(scene)
    for field in ("postProcessing", "audio", "shots", "motions", "animation"):
        source.pop(field, None)
    source["render"] = {key: profile[key] for key in
        ("width", "height", "samples", "fps", "engine", "seed", "blenderVersion")}
    source["render"]["executionPolicy"] = profile.get("executionPolicy")
    initial = {key: value for key, value in first_sample.items()
               if key not in ("frame", "timeSeconds", "shotId", "camera", "clip")}
    return {"source": source, "initialWorldState": initial}


def runtime_identity(config, profile):
    """Require the renderer's actual backend/settings, never just AUTO/OPTIX."""
    if not isinstance(config, dict) or not _valid_execution(config.get("execution")):
        return None
    if any(config.get(key) != profile[key] for key in ("width", "height", "samples", "seed", "engine", "blenderVersion")):
        return None
    if config.get("execution", {}).get("policy") != (profile.get("executionPolicy") or {"cycles": "CPU"})["cycles"]:
        return None
    required = ("adapterVersion", "blenderVersion", "engine", "execution", "seed", "samples",
                "denoising", "width", "height", "fps", "viewTransform", "look", "cameraGate")
    if any(key not in config for key in required):
        return None
    if config["fps"] != profile["fps"] or config["denoising"] != config["execution"]["denoiser"]["enabled"]:
        return None
    return {key: config[key] for key in required}


class RawMasterCache:
    def __init__(self, output, job, scene, blender, *, inspect_png, check_cancel=lambda: None):
        self.output, self.job, self.scene = Path(output), job, scene
        self.inspect_png, self.check_cancel = inspect_png, check_cancel
        self.root = self.output.parent / ".raw-render-cache"
        self.profile = job["renderProfile"]
        try:
            limit = int(os.environ.get("GESSO_RAW_RENDER_CACHE_MAX_MIB", "256"))
            if not 0 <= limit <= 4096:
                raise ValueError()
        except ValueError:
            limit = 0
        self.limit = limit * MIB
        self.enabled = bool(self.limit) and scene["environment"]["kind"] != "splat"
        self.base, self.frames, self.runtime, self.runtime_digest = None, {}, None, None
        self.stats = job.setdefault("renderReuse", {"policy": SCHEMA, "restoredFrames": 0,
            "storedFrames": 0, "restoredBytes": 0, "cacheMisses": 0, "admissionSkipped": 0})
        self.stats["eligible"] = self.enabled
        if not self.enabled:
            self.stats["reason"] = ("Gaussian plate/native execution equivalence is not certified for reuse."
                                    if scene["environment"]["kind"] == "splat" else "Raw master cache disabled.")
            return
        tool = tool_identity(blender)
        if tool is None:
            self.enabled = False
            self.stats.update(eligible=False, reason="Native renderer binary identity unavailable.")
            return
        samples = json.loads((self.output / "samples.json").read_text())["frames"]
        self.frames = {sample["frame"]: sample for sample in samples if sample.get("clip", {}).get("kind", "scene") == "scene"}
        self.base = {"policy": SCHEMA, "implementation": _hash_file(Path(__file__)),
            "renderer": job["rendererDigest"], "dependencies": job["rendererDependencies"],
            "tool": tool, "physical": physical_scene(scene, self.profile, samples[0])}
        self._inputs = {}

    def _input(self, number):
        if not self.enabled or number not in self.frames:
            return None
        if number not in self._inputs:
            sample = {key: value for key, value in self.frames[number].items() if key not in ("timeSeconds", "shotId")}
            self._inputs[number] = _digest({**self.base, "frame": sample})
        return self._inputs[number]

    def has_candidates(self, numbers):
        if not self.enabled or not self.root.is_dir() or self.root.is_symlink():
            return False
        return any((self.root / key).is_dir() and not (self.root / key).is_symlink()
                   for number in numbers if (key := self._input(number)))

    def _runtime(self):
        if self.runtime is not None:
            return True
        path = self.output / "render-config.json"
        if not _regular(path, 8 * MIB):
            return False
        value = runtime_identity(json.loads(path.read_text()), self.profile)
        if value is None:
            return False
        self.runtime, self.runtime_digest = value, _digest(value)
        return True

    @contextmanager
    def _lock(self):
        if self.root.is_symlink():
            raise ValueError("Raw cache root must not be a symlink")
        self.root.mkdir(exist_ok=True)
        descriptor = os.open(self.root / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def _valid(self, directory, key):
        if directory.is_symlink() or directory.parent.is_symlink():
            return None
        receipt, pixels = directory / "receipt.json", directory / "raw.png"
        if not _regular(receipt, 64 * 1024) or not _regular(pixels, 256 * MIB):
            return None
        value = json.loads(receipt.read_text())
        if (value.get("schema") != SCHEMA or value.get("inputDigest") != key
                or value.get("runtimeDigest") != self.runtime_digest or value.get("runtime") != self.runtime
                or value.get("receiptDigest") != _digest({k: v for k, v in value.items() if k != "receiptDigest"})
                or pixels.stat().st_size != value.get("bytes")):
            return None
        digest = self.inspect_png(pixels, self.profile["width"], self.profile["height"])
        return value if digest is not None and digest == value.get("rawSha256") else None

    def restore(self, numbers):
        if not self.enabled or not self._runtime() or not self.root.is_dir() or self.root.is_symlink():
            return []
        restored = []
        for number in numbers:
            self.check_cancel()
            key = self._input(number)
            if not key:
                continue
            directory = self.root / key / self.runtime_digest
            try:
                value = self._valid(directory, key)
                if value is None:
                    self.stats["cacheMisses"] += 1
                    continue
                path = self.output / "frames" / f"{number:06d}.png"
                path.parent.mkdir(exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".raw-reuse-", delete=False) as handle:
                    temporary = Path(handle.name)
                try:
                    shutil.copyfile(directory / "raw.png", temporary)
                    if self.inspect_png(temporary, self.profile["width"], self.profile["height"]) != value["rawSha256"]:
                        continue
                    self.check_cancel()
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
                # A restored ungraded frame belongs to this new job's own raw
                # receipt, never the previous job's finishing receipt.
                if self.job.get("postProcessing"):
                    from .post_processing import raw_frame_identity, record_raw_frame_receipt
                    record_raw_frame_receipt(self.output, raw_frame_identity(self.job), number)
                restored.append(number)
                self.stats["restoredFrames"] += 1
                self.stats["restoredBytes"] += value["bytes"]
            except (OSError, ValueError, KeyError, TypeError):
                self.stats["cacheMisses"] += 1
        return restored

    def _usage(self):
        total = count = 0
        for group in self.root.iterdir():
            if group.is_symlink():
                return self.limit, MAX_ENTRIES
            if group.is_file():
                total += group.stat().st_size
                continue
            if group.name.startswith(".stage-"):
                # A killed writer can leave its owned staging directory. Count
                # it against the budget, without deleting older evidence.
                for path in group.iterdir():
                    if not path.is_file() or path.is_symlink():
                        return self.limit, MAX_ENTRIES
                    total += path.stat().st_size
                continue
            if not _HEX.fullmatch(group.name) or not group.is_dir():
                return self.limit, MAX_ENTRIES
            for entry in group.iterdir():
                if entry.is_symlink() or not entry.is_dir() or not _HEX.fullmatch(entry.name):
                    return self.limit, MAX_ENTRIES
                count += 1
                if count >= MAX_ENTRIES:
                    return self.limit, count
                for path in entry.iterdir():
                    if path.name not in ("raw.png", "receipt.json") or not path.is_file() or path.is_symlink():
                        return self.limit, MAX_ENTRIES
                    total += path.lstat().st_size
        return total, count

    def store(self, numbers):
        if not self.enabled or not self._runtime():
            return
        for number in numbers:
            self.check_cancel()
            key = self._input(number)
            if not key:
                continue
            path = self.output / "frames" / f"{number:06d}.png"
            try:
                if not _regular(path, 256 * MIB):
                    continue
                raw_hash = self.inspect_png(path, self.profile["width"], self.profile["height"])
                if raw_hash is None:
                    continue
                with self._lock():
                    directory = self.root / key / self.runtime_digest
                    if directory.exists():
                        continue  # Existing masters, including corrupt ones, are never overwritten.
                    size = path.stat().st_size
                    used, entries = self._usage()
                    if used + size + 4096 > self.limit or entries >= MAX_ENTRIES or shutil.disk_usage(self.root).free < max(256 * MIB, size * 2 + 4 * MIB):
                        self.stats["admissionSkipped"] += 1
                        continue
                    directory.parent.mkdir(exist_ok=True)
                    if directory.parent.is_symlink():
                        raise ValueError("Raw master directory must not be a symlink")
                    temporary = Path(tempfile.mkdtemp(dir=self.root, prefix=".stage-"))
                    try:
                        shutil.copyfile(path, temporary / "raw.png")
                        if self.inspect_png(temporary / "raw.png", self.profile["width"], self.profile["height"]) != raw_hash:
                            continue
                        value = {"schema": SCHEMA, "inputDigest": key, "runtimeDigest": self.runtime_digest,
                            "runtime": self.runtime, "rawSha256": raw_hash, "bytes": size,
                            "sourceSceneDigest": self.job["sceneDigest"], "sourceJobId": self.job["jobId"]}
                        value["receiptDigest"] = _digest(value)
                        (temporary / "receipt.json").write_bytes(_json(value))
                        self.check_cancel()
                        os.rename(temporary, directory)
                        self.stats["storedFrames"] += 1
                    finally:
                        if temporary.exists():
                            shutil.rmtree(temporary)
            except (OSError, ValueError, KeyError, TypeError):
                self.stats["admissionSkipped"] += 1
