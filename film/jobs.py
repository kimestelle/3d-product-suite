"""Durable, single-worker render jobs for the Linux prototype.

Blender owns rendering; FFmpeg assembles verified PNG frames. The job directory
contains immutable source snapshots and may be resumed after a worker exits.
"""
from __future__ import annotations

from contextlib import contextmanager
from functools import lru_cache
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import shutil
import tempfile
import time
import uuid
import zlib
import zipfile

from .export_formats import FORMATS, artifact_names, job_format, primary_artifact
from .scene import load_scene, sample_scene, scene_digest
from .worlds import bundle_assets, verify_scene_assets

BLENDER_VERSION = "4.3.2"
FFMPEG_VERSION = "7.1.5"
BATCH_SIZE = 48
_RENDERER = Path(__file__).resolve().parents[1] / "scripts" / "blender_scene.py"
_RENDERER_DEPENDENCIES = {name: Path(__file__).with_name(name) for name in ("decal_geometry.py", "film_images.py", "material_assets.py", "post_processing.py", "render_devices.py")}
_CURRENT_EXECUTION = object()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path, data):
    path = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=f".{path.name}.",
                                         suffix=".tmp", delete=False, encoding="utf-8") as handle:
            temporary = Path(handle.name)
            json.dump(data, handle, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _read_job(output):
    try:
        job = json.loads((output / "job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"Cannot read job manifest in {output}: {error}") from error
    if job.get("schemaVersion") != 1:
        raise ValueError("Unsupported render job schema version")
    return job


@contextmanager
def _lock(output, filename, *, blocking=True):
    with (output / filename).open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError as error:
            raise RuntimeError("Another worker is already running this job") from error
        # Close our descriptor on exit rather than explicitly unlocking. A
        # render child inherits the same open-file description, so it retains
        # the worker lock if this process is killed before reaping the child.
        yield handle


def _save_job(output, job):
    with _lock(output, ".manifest.lock"):
        job["updatedAt"] = _now()
        job["cancellationRequested"] = (output / "cancel.requested").exists()
        _atomic_json(output / "job.json", job)


def execution_policy(value=_CURRENT_EXECUTION):
    """Freeze device requests when creating a job, independently of later env changes."""
    if value is _CURRENT_EXECUTION:
        value = {"cycles": os.environ.get("GESSO_CYCLES_DEVICE", "AUTO").upper(),
                 "capture": os.environ.get("GESSO_CAPTURE_DEVICE", "auto").lower(),
                 "denoising": os.environ.get("GESSO_CYCLES_DENOISE", "") == "1"}
    if (not isinstance(value, dict) or set(value) != {"cycles", "capture", "denoising"}
            or value["cycles"] not in ("AUTO", "CPU", "METAL", "OPTIX", "CUDA", "HIP", "ONEAPI")
            or value["capture"] not in ("auto", "hardware", "software")
            or type(value["denoising"]) is not bool):
        raise ValueError("Invalid export execution policy: choose a supported Cycles device and auto, hardware or software Gaussian capture")
    return dict(value)


def _profile(scene, sampled, width, height, samples, export_format=None, *, execution=_CURRENT_EXECUTION):
    settings = scene["render"]
    width = settings["width"] if width is None else width
    height = settings["height"] if height is None else height
    samples = settings["samples"] if samples is None else samples
    for name, value in (("width", width), ("height", height)):
        if type(value) is not int or value < 2 or value > 16384 or value % 2:
            raise ValueError(f"{name} must be an even integer from 2 to 16384 for rendering")
    if type(samples) is not int or not 1 <= samples <= 65536:
        raise ValueError("samples must be an integer from 1 to 65536")
    if settings["blenderVersion"] != BLENDER_VERSION or settings["ffmpegVersion"] != FFMPEG_VERSION:
        raise ValueError(f"Render tools must be pinned to Blender {BLENDER_VERSION} and FFmpeg {FFMPEG_VERSION}")
    if export_format is not None and (not isinstance(export_format, str) or export_format not in FORMATS):
        raise ValueError("Unknown export format")
    return {**({"format": export_format} if export_format is not None else {}),
            **({"executionPolicy": execution_policy(execution)} if execution is not None else {}),
            "width": width, "height": height, "samples": samples,
            "fps": settings["fps"], "frameCount": len(sampled["frames"]),
            "engine": settings["engine"], "seed": settings["seed"],
            "blenderVersion": BLENDER_VERSION, "ffmpegVersion": FFMPEG_VERSION}


def create_job(scene_path, output_dir, *, width=None, height=None, samples=None, export_format=None):
    """Snapshot a scene. Reusing an output directory requires identical inputs."""
    scene = load_scene(scene_path)
    sampled = sample_scene(scene)
    profile = _profile(scene, sampled, width, height, samples, export_format)
    digest = scene_digest(scene)
    renderer_source = _RENDERER.read_bytes()
    renderer_digest = hashlib.sha256(renderer_source).hexdigest()
    dependencies = {name: path.read_bytes() for name, path in _RENDERER_DEPENDENCIES.items()}
    dependency_digests = {name: hashlib.sha256(source).hexdigest() for name, source in dependencies.items()}
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with _lock(output, ".manifest.lock"):
        if (output / "job.json").exists():
            job = _read_job(output)
            if job.get("sceneDigest") != digest or job.get("renderProfile") != profile:
                raise ValueError("Output directory belongs to a different source revision or render profile; use a new directory")
            _verify_snapshots(output, job)
            return job
        if any(path.name != ".manifest.lock" for path in output.iterdir()):
            raise ValueError("Output directory is not empty and has no job manifest; use a new directory")
        assets = bundle_assets(scene, Path(scene_path).resolve().parent, output)
        timestamp = _now()
        job = {"schemaVersion": 1, "jobId": str(uuid.uuid4()), "state": "queued",
               "createdAt": timestamp, "updatedAt": timestamp,
               "sceneDigest": digest, "sourceScene": "scene.json", "samples": "samples.json",
               "rendererScript": "renderer.py", "rendererDigest": renderer_digest, "rendererDependencies": dependency_digests,
               "renderProfile": profile, "renderProfileDigest": scene_digest(profile), "completedRanges": [], "frameDigests": {}, "attempts": [],
               "errors": [], "tools": {}, "artifacts": {}, "assets": assets, "cancellationRequested": False,
               "renderingPath": {"authored": "authored-cycles", "mesh": "mesh-cycles", "splat": "camera-matched-splat-plate"}[scene["environment"]["kind"]]}
        from .post_processing import has_post_processing, validate_post_processing
        if has_post_processing(scene.get("postProcessing")):
            job["postProcessing"] = validate_post_processing(scene["postProcessing"])
        if scene["environment"]["kind"] == "splat":
            job["limitations"] = ["Distant color plate only: no near-field Gaussian depth, occlusion, reflections or transmission equivalence."]
        with (output / "renderer.py").open("wb") as handle:
            handle.write(renderer_source)
            handle.flush()
            os.fsync(handle.fileno())
        for name, source in dependencies.items():
            with (output / name).open("wb") as handle:
                handle.write(source)
                handle.flush()
                os.fsync(handle.fileno())
        _atomic_json(output / "scene.json", scene)
        _atomic_json(output / "samples.json", sampled)
        _atomic_json(output / "job.json", job)
        return job


def _verify_snapshots(output, job):
    if job.get("rendererDigest") != _sha256(_RENDERER):
        raise ValueError("Renderer implementation changed after job creation; create a new job directory")
    if job["rendererDigest"] != _sha256(output / "renderer.py"):
        raise ValueError("Renderer snapshot was modified after job creation; create a new job directory")
    expected_dependencies = {name: _sha256(path) for name, path in _RENDERER_DEPENDENCIES.items()}
    if job.get("rendererDependencies") != expected_dependencies:
        raise ValueError("Renderer dependency implementation changed after job creation; create a new job directory")
    for name, expected_digest in expected_dependencies.items():
        dependency = output / name
        if not dependency.is_file() or _sha256(dependency) != expected_digest:
            raise ValueError("Renderer dependency snapshot was modified or is missing; create a new job directory")
    scene = load_scene(output / "scene.json")
    if scene_digest(scene) != job.get("sceneDigest"):
        raise ValueError("Source revision was modified after job creation; create a new job directory")
    from .post_processing import has_post_processing, validate_post_processing
    expected_grade = (validate_post_processing(scene["postProcessing"])
                      if has_post_processing(scene.get("postProcessing")) else None)
    if job.get("postProcessing") != expected_grade:
        raise ValueError("Job post processing does not match its immutable source revision")
    assets = verify_scene_assets(scene, output)
    if assets != job.get("assets", []):
        raise ValueError("Bundled world asset records do not match the immutable job source")
    expected = sample_scene(scene)
    try:
        actual = json.loads((output / "samples.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("Sample snapshot is missing or invalid; create a new job directory") from error
    if actual != expected:
        raise ValueError("Sample snapshot does not match the immutable source revision")
    profile = job["renderProfile"]
    if job.get("renderProfileDigest") is not None and scene_digest(profile) != job["renderProfileDigest"]:
        raise ValueError("Job render profile was modified after creation")
    if profile != _profile(scene, expected, profile["width"], profile["height"], profile["samples"], profile.get("format"),
                           execution=profile.get("executionPolicy")):
        raise ValueError("Job render profile is inconsistent with its source revision")
    return scene


def _read_valid_png(path, width=None, height=None):
    """Read once and check PNG structure, CRCs, dimensions and decoded scanlines.

    Blender and FFmpeg write non-interlaced PNGs. Reject other encodings rather
    than treating an unverified image as a completed frame.
    """
    try:
        if Path(path).stat().st_size > 256 * 1024 * 1024:
            return None
        payload = Path(path).read_bytes()
        if len(payload) > 256 * 1024 * 1024 or payload[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        offset, idats, header, palette, ended, idat_closed = 8, [], None, False, False, False
        while offset < len(payload):
            if offset + 12 > len(payload):
                return None
            size = struct.unpack_from(">I", payload, offset)[0]
            kind = payload[offset + 4:offset + 8]
            end = offset + 12 + size
            if end > len(payload):
                return None
            data = payload[offset + 8:offset + 8 + size]
            crc = struct.unpack_from(">I", payload, offset + 8 + size)[0]
            if zlib.crc32(data, zlib.crc32(kind)) & 0xFFFFFFFF != crc:
                return None
            if header is None and kind != b"IHDR":
                return None
            if kind == b"IHDR":
                if header is not None or size != 13:
                    return None
                header = struct.unpack(">IIBBBBB", data)
            elif kind == b"PLTE":
                if palette or idats or not size or size % 3 or size > 768:
                    return None
                palette = True
            elif kind == b"IDAT":
                if idat_closed:
                    return None
                idats.append(data)
            elif kind == b"IEND":
                if size or end != len(payload):
                    return None
                ended = True
                break
            elif not kind[0] & 32:  # unknown critical chunk
                return None
            if idats and kind != b"IDAT":
                idat_closed = True
            offset = end
        if not ended or not idats or header is None:
            return None
        w, h, depth, color, compression, filtering, interlace = header
        depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
        if (not w or not h or w > 16384 or h > 16384 or color not in depths
                or depth not in depths[color] or compression or filtering or interlace
                or (color == 3 and not palette)
                or (width is not None and w != width) or (height is not None and h != height)):
            return None
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
        stride = math.ceil(w * channels * depth / 8) + 1
        expected = stride * h
        if expected > 256 * 1024 * 1024:
            return None
        decoder = zlib.decompressobj()
        raw = decoder.decompress(b"".join(idats), expected + 1)
        if (len(raw) != expected or not decoder.eof or decoder.unused_data
                or any(raw[row * stride] > 4 for row in range(h))):
            return None
        return payload
    except (OSError, ValueError, struct.error, zlib.error):
        return None


def validate_png(path, width=None, height=None):
    """Verify PNG structure, CRCs, dimensions and complete decoded scanlines."""
    return _read_valid_png(path, width, height) is not None


def _inspect_png(path, width=None, height=None):
    """Validate and hash the same PNG bytes without another file read."""
    payload = _read_valid_png(path, width, height)
    return hashlib.sha256(payload).hexdigest() if payload is not None else None


def validate_plate_inputs(output, job, frame_numbers):
    """Verify and pin camera-matched splat plates before reusing rendered frames.

    The caller owns the worker lock and persists the mutated job. Capture runs
    before this boundary; plates are immutable inputs once a render begins.
    """
    output = Path(output).resolve()
    scene = load_scene(output / "scene.json")
    if scene["environment"]["kind"] != "splat":
        return None
    numbers = list(frame_numbers)
    profile = job["renderProfile"]
    if (not numbers or any(type(number) is not int or not 1 <= number <= profile["frameCount"] for number in numbers)
            or len(numbers) != len(set(numbers))):
        raise ValueError("Splat plate frame numbers must be unique source frame IDs")
    requested_numbers = sorted(numbers)
    scene_numbers = {number for shot in scene["shots"] if shot.get("kind", "scene") == "scene"
                     for number in range(shot["startFrame"], shot["endFrame"] + 1)}
    numbers = [number for number in requested_numbers if number in scene_numbers]
    if not numbers:
        return None
    try:
        manifest = json.loads((output / "plate" / "capture-manifest.json").read_text(encoding="utf-8"))
        sampled = json.loads((output / "samples.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("Splat capture-manifest.json and complete camera-matched plates are required") from error
    if not isinstance(manifest, dict):
        raise ValueError("Splat capture manifest must be a JSON object")
    expected_samples = hashlib.sha256(json.dumps(sampled, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    asset = scene["environment"]["asset"]
    capture_profile = manifest.get("profile", {})
    if (type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1 or manifest.get("sourceDigest") != job["sceneDigest"]
            or manifest.get("samplesDigest") != expected_samples
            or manifest.get("assetSha256") != asset["sha256"] or manifest.get("assetFormat") != asset["format"]):
        raise ValueError("Splat capture source, sampled cameras or world asset does not match this job")
    if (not isinstance(capture_profile, dict)
            or type(capture_profile.get("width")) is not int or type(capture_profile.get("height")) is not int
            or capture_profile.get("width") != profile["width"] or capture_profile.get("height") != profile["height"]
            or not isinstance(capture_profile.get("frameNumbers"), list)
            or any(type(number) is not int for number in capture_profile["frameNumbers"])
            or capture_profile.get("frameNumbers") not in (numbers, requested_numbers) or capture_profile.get("renderer") != "spark"
            or capture_profile.get("contents") != "gaussian-world-only" or capture_profile.get("colorSpace") != "srgb"
            or capture_profile.get("toneMapping") != "none"
            or not isinstance(capture_profile.get("runtimeDigest"), str)
            or re.fullmatch(r"[0-9a-f]{64}", capture_profile["runtimeDigest"]) is None):
        raise ValueError("Splat capture profile does not match requested frames, dimensions or pinned Spark runtime")
    from .gaussian_receipts import validate_world_copy
    validate_world_copy(output, asset, capture_profile)
    recorded = manifest.get("frames", {})
    if not isinstance(recorded, dict):
        raise ValueError("Splat capture must record a hash for every plate frame")
    hashes = {}
    for number in numbers:
        path = output / "plate" / f"{number:06d}.png"
        digest = _inspect_png(path, profile["width"], profile["height"])
        if digest is None:
            raise ValueError(f"Missing or invalid camera-matched splat plate for frame {number}")
        if recorded.get(str(number)) != digest:
            raise ValueError(f"Splat plate hash changed for frame {number}; create a new job directory")
        hashes[str(number)] = digest
    pinned = {"sourceDigest": manifest["sourceDigest"], "samplesDigest": expected_samples,
              "assetSha256": asset["sha256"], "assetFormat": asset["format"],
              "profile": capture_profile, "frames": hashes}
    digest = hashlib.sha256(json.dumps(pinned, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    if job.get("plateDigest") is not None and job["plateDigest"] != digest:
        raise ValueError("Splat plates or capture runtime changed after job started; create a new job directory")
    job["plateDigest"] = digest
    job["plateInputs"] = pinned
    return digest


def _frames(output, profile, *, digests=None):
    frames = []
    for number in range(1, profile["frameCount"] + 1):
        path = output / "frames" / f"{number:06d}.png"
        if digests is None:
            valid = validate_png(path, profile["width"], profile["height"])
        else:
            digest = _inspect_png(path, profile["width"], profile["height"])
            valid = digest is not None
            if valid:
                digests[number] = digest
        if valid:
            frames.append(number)
    return frames


def _verified_frames(output, job, *, digests=None):
    """Reject structurally valid frames whose recorded pixels were replaced."""
    hashes = {}
    needs_hashes = digests is not None or job.get("postProcessing") or job.get("frameDigests") or job.get("frameSequenceDigest")
    frames = _frames(output, job["renderProfile"], digests=hashes if needs_hashes else None)
    if job.get("postProcessing"):
        samples = json.loads((output / "samples.json").read_text())["frames"]
        scene_ids = {sample["frame"] for sample in samples if sample.get("clip", {}).get("kind", "scene") == "scene"}
        receipt = _post_processing_receipt(output)
        frames = [frame for frame in frames if frame not in scene_ids
                  or receipt.get(str(frame)) == hashes[frame]]
    recorded = job.get("frameDigests", {})
    if recorded:
        frames = [frame for frame in frames if str(frame) not in recorded
                  or hashes[frame] == recorded[str(frame)]]
    # Older successful manifests have a sequence digest but no per-frame hashes.
    # If their sequence changed, render the sequence again to restore its source.
    elif job.get("frameSequenceDigest"):
        if (len(frames) != job["renderProfile"]["frameCount"]
                or _frame_digest(output, len(frames), digests=hashes) != job["frameSequenceDigest"]):
            return []
    if digests is not None:
        digests.update((frame, hashes[frame]) for frame in frames)
    return frames


def _record_frame_digests(output, job, frames, *, digests=None):
    recorded = job.setdefault("frameDigests", {})
    for frame in frames:
        recorded[str(frame)] = (digests[frame] if digests is not None
                                else _sha256(output / "frames" / f"{frame:06d}.png"))


def _ranges(numbers):
    ranges = []
    for number in numbers:
        if ranges and ranges[-1][1] + 1 == number:
            ranges[-1][1] = number
        else:
            ranges.append([number, number])
    return ranges


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _frame_digest(output, count, *, digests=None):
    digest = hashlib.sha256()
    for frame in range(1, count + 1):
        value = digests[frame] if digests is not None else _sha256(output / "frames" / f"{frame:06d}.png")
        digest.update(value.encode("ascii"))
    return digest.hexdigest()


def _blend_valid(path):
    try:
        with path.open("rb") as handle:
            return handle.read(7) == b"BLENDER" and path.stat().st_size >= 12
    except OSError:
        return False


def _blend_needs_rebuild(output, job):
    path = output / "scene.blend"
    if not _blend_valid(path):
        return True
    recorded = job.get("artifacts", {}).get("scene.blend")
    if recorded:
        return (path.stat().st_size != recorded.get("bytes")
                or _sha256(path) != recorded.get("sha256"))
    return False


def _outputs_valid(output, job, complete, *, digests=None):
    profile = job["renderProfile"]
    artifacts = job.get("artifacts", {})
    if (len(complete) != profile["frameCount"] or set(artifacts) != set(artifact_names(job))
            or not _blend_valid(output / "scene.blend")):
        return False
    if job.get("frameSequenceDigest") != _frame_digest(output, profile["frameCount"], digests=digests):
        return False
    for name in artifact_names(job):
        path = output / name
        record = artifacts.get(name, {})
        try:
            if path.stat().st_size != record.get("bytes") or _sha256(path) != record.get("sha256"):
                return False
        except OSError:
            return False
    return True


class _Cancelled(Exception):
    pass


def _check_cancel(output):
    if (output / "cancel.requested").exists():
        raise _Cancelled()


def _check_tool(command, tool, expected):
    try:
        result = subprocess.run([str(command), "--version" if tool == "blender" else "-version"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                check=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Cannot run {tool}: {error}") from error
    prefix = r"Blender\s+" if tool == "blender" else r"ffmpeg version\s+"
    if not re.search(prefix + re.escape(expected) + r"(?=[\s-]|$)", result.stdout):
        first_line = result.stdout.splitlines()[0] if result.stdout else "no version output"
        raise RuntimeError(f"Expected {tool} {expected}; found {first_line}")
    return {"command": str(command), "version": expected,
            "reported": result.stdout.splitlines()[0]}


def _run_process(command, output, log_name, *, worker_fd=None):
    # Interactive proofs share this GPU. A pending proof gets the next native
    # batch boundary; CPU encoding never occupies the GPU scheduling slot.
    if "--python" in command:
        from .render_arbitration import background_render_slot
        with background_render_slot(output, cancel=lambda: _check_cancel(output)) as scheduling:
            receipt = output / "render-yield.json"
            receipt.unlink(missing_ok=True)
            token = uuid.uuid4().hex
            environment = dict(os.environ)
            environment["GESSO_RENDER_BATCH_TOKEN"] = token
            environment["GESSO_ROOT"] = str(Path(__file__).resolve().parents[1])
            extra_fds = ()
            if isinstance(scheduling, dict):
                if scheduling.get("proofDemandPath"):
                    environment["GESSO_PROOF_DEMAND_PATH"] = scheduling["proofDemandPath"]
                if type(scheduling.get("gpuLockFd")) is int:
                    extra_fds = (scheduling["gpuLockFd"],)
            _run_process_unlocked(command, output, log_name, worker_fd=worker_fd,
                                  environment=environment, extra_fds=extra_fds)
            if receipt.exists() or receipt.is_symlink():
                return {"yieldedFrames": _validated_render_yield(output, command, token)}
            return None
    return _run_process_unlocked(command, output, log_name, worker_fd=worker_fd)


def _validated_render_yield(output, command, token):
    """A proof request may pause a batch only after complete native frames.

    The current child must attest the exact requested prefix and each raw PNG.
    A stale or fabricated receipt can never mark unrelated frames completed.
    """
    receipt = output / "render-yield.json"
    try:
        if receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_size > 128 * 1024 or "--frames" not in command:
            raise ValueError()
        value = json.loads(receipt.read_text())
        requested = [int(frame) for frame in command[command.index("--frames") + 1].split(",")]
        completed = value["completed"]
        frames = [item["frame"] for item in completed]
        job = _read_job(output)
        if (value.get("schemaVersion") != 1 or value.get("token") != token
                or value.get("sourceDigest") != job["sceneDigest"]
                or value.get("rendererDigest") != job["rendererDigest"]
                or not frames or len(frames) >= len(requested) or frames != requested[:len(frames)]
                or any(type(frame) is not int for frame in frames)):
            raise ValueError()
        profile = job["renderProfile"]
        for frame, item in zip(frames, completed):
            digest = _inspect_png(output / "frames" / f"{frame:06d}.png", profile["width"], profile["height"])
            if digest is None or item.get("sha256") != digest:
                raise ValueError()
        receipt.unlink()
        return frames
    except (OSError, ValueError, TypeError, KeyError, AttributeError, IndexError) as error:
        raise RuntimeError("Native batch yield receipt is stale, invalid or does not match its complete raw frames") from error


def _run_process_unlocked(command, output, log_name, *, worker_fd=None, environment=None, extra_fds=()):
    _check_cancel(output)
    with (output / log_name).open("ab") as log:
        log.write(("\nCOMMAND " + repr([str(part) for part in command]) + "\n").encode("utf-8"))
        log.flush()
        process = subprocess.Popen([str(part) for part in command], stdout=log,
                                   stderr=subprocess.STDOUT, cwd=output,
                                   pass_fds=tuple(dict.fromkeys((*extra_fds, *((worker_fd,) if worker_fd is not None else ())))),
                                   **({"env": environment} if environment is not None else {}))
        try:
            while process.poll() is None:
                _check_cancel(output)
                time.sleep(0.1)
            _check_cancel(output)
            if process.returncode:
                raise RuntimeError(f"Process exited {process.returncode}; inspect {log_name}")
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            raise


def _render_non_scene_frames(output, profile, numbers):
    """Materialize flat content from the pinned renderer helper; return scene IDs."""
    sampled = json.loads((output / "samples.json").read_text())
    by_frame = {sample["frame"]: sample for sample in sampled["frames"]}
    flat = [number for number in numbers if by_frame[number].get("clip", {}).get("kind", "scene") != "scene"]
    if not flat:
        return numbers
    spec = importlib.util.spec_from_file_location("film._job_image_renderer", output / "film_images.py")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    cache = {}
    for number in flat:
        _check_cancel(output)
        clip = by_frame[number]["clip"]
        key = json.dumps(clip, sort_keys=True)
        destination = output / "frames" / f"{number:06d}.png"
        if key in cache:
            shutil.copyfile(cache[key], destination)
        else:
            renderer.render_clip(clip, output, profile["width"], profile["height"], destination)
            cache[key] = destination
    flat_set = set(flat)
    return [number for number in numbers if number not in flat_set]


def _post_processing_receipt(output):
    try:
        value = json.loads((output / "post-processing-frames.json").read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


@lru_cache(maxsize=8)
def _post_processor(path, digest):
    # Include snapshot identity if a completed directory is later recreated.
    spec = importlib.util.spec_from_file_location("film._job_post_processing", path)
    processor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(processor)
    return processor


def _post_process_scene_frames(output, job, numbers):
    """Finish only freshly rendered scene frames, with crash-safe final receipts.

    A raw renderer receipt can recover an interrupted batch. A PNG matching
    neither raw nor final receipt is re-rendered, preventing double grading.
    """
    # Preserve the native, ungraded pixels before a job-specific finish mutates
    # them. Reuse is optional and independently verifies exact physical inputs.
    _store_raw_scene_frames(output, job, numbers)
    recipe = job.get("postProcessing")
    if not recipe or not numbers:
        return
    processor = _post_processor(output / "post_processing.py", job["rendererDependencies"]["post_processing.py"])
    receipts = _post_processing_receipt(output)
    for number in numbers:
        _check_cancel(output)
        path = output / "frames" / f"{number:06d}.png"
        processor.apply_post_processing(path, recipe, cancel=lambda: _check_cancel(output))
        receipts[str(number)] = _sha256(path)
        _atomic_json(output / "post-processing-frames.json", receipts)
    processor.prune_raw_frame_receipts(output, processor.raw_frame_identity(job), numbers)


def _raw_master_cache(output, job, scene=None, blender=None):
    """Cache failures retain the ordinary render path and its quality profile."""
    try:
        from .render_reuse import RawMasterCache
        scene = scene if scene is not None else load_scene(output / "scene.json")
        blender = blender or job.get("tools", {}).get("blender", {}).get("command", "blender")
        return RawMasterCache(output, job, scene, blender, inspect_png=_inspect_png,
                              check_cancel=lambda: _check_cancel(output))
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _store_raw_scene_frames(output, job, numbers):
    if not numbers:
        return
    cache = _raw_master_cache(output, job)
    if cache is not None:
        try:
            cache.store(numbers)
        except (OSError, ValueError, TypeError, KeyError):
            pass  # Admission failure cannot fail or change a render.


def _restore_raw_scene_frames(output, job, scene, blender, numbers, rebuild_blend, worker_fd):
    cache = _raw_master_cache(output, job, scene, blender)
    if cache is None:
        return [], rebuild_blend
    try:
        candidates = cache.has_candidates(numbers)
    except (OSError, ValueError, TypeError, KeyError):
        candidates = False
    if not candidates:
        return [], rebuild_blend
    # Select the actual runtime and create this revision's native artifact
    # before considering cached pixels. AUTO alone never authorizes reuse.
    if rebuild_blend:
        _run_process(_render_command(blender, output, job["renderProfile"], []), output,
                     "blender.log", worker_fd=worker_fd)
        rebuild_blend = False
    try:
        restored = cache.restore(numbers)
    except (OSError, ValueError, TypeError, KeyError):
        restored = []
    if restored:
        _post_process_scene_frames(output, job, restored)
    return restored, rebuild_blend


def _recover_raw_scene_frames(output, job, numbers=None):
    """Finish only renderer-receipted raw scene pixels left by an interrupted batch."""
    if not job.get("postProcessing"):
        return []
    processor = _post_processor(output / "post_processing.py", job["rendererDependencies"]["post_processing.py"])
    identity = processor.raw_frame_identity(job)
    raw = processor.read_raw_frame_receipts(output, identity)
    if not raw:
        return []
    final = _post_processing_receipt(output)
    requested = set(numbers) if numbers is not None else None
    profile = job["renderProfile"]
    samples = json.loads((output / "samples.json").read_text())["frames"]
    recovered, committed = [], []
    for sample in samples:
        number = sample["frame"]
        if ((requested is not None and number not in requested)
                or sample.get("clip", {}).get("kind", "scene") != "scene" or str(number) not in raw):
            continue
        _check_cancel(output)
        path = output / "frames" / f"{number:06d}.png"
        digest = _inspect_png(path, profile["width"], profile["height"])
        if digest is None:
            continue
        if final.get(str(number)) == digest:
            committed.append(number)
        elif raw[str(number)] == digest:
            recovered.append(number)
    _post_process_scene_frames(output, job, recovered)
    processor.prune_raw_frame_receipts(output, identity, committed)
    return recovered


def _render_command(blender, output, profile, frames):
    command = [blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", str(output / "renderer.py"), "--",
               "--samples", str(output / "samples.json"), "--output", str(output),
               "--width", str(profile["width"]), "--height", str(profile["height"]),
               "--samples-per-pixel", str(profile["samples"])]
    if frames:
        command.extend(["--frames", ",".join(map(str, frames))])
    return command


def _audio_arguments(output, job, scene):
    """Mux the bundled soundtrack: offset places the file on the film clock, gain scales it, silence pads the tail."""
    audio = scene.get("audio")
    if not audio:
        return [], []
    offset = float(audio.get("offsetS", 0))
    placement = ["-itsoffset", f"{offset:g}"] if offset > 0 else ["-ss", f"{-offset:g}"] if offset < 0 else []
    encoder = ["-c:a", "pcm_s16le"] if job_format(job) == "prores" else ["-c:a", "aac", "-b:a", "192k"]
    return (placement + ["-i", str(output / audio["asset"]["path"])],
            ["-filter:a", f"volume={float(audio.get('gain', 1)):g},apad", "-map", "0:v:0", "-map", "1:a:0"] + encoder + ["-shortest"])


def _encode(output, job, scene, ffmpeg, *, worker_fd=None):
    profile = job["renderProfile"]
    count = profile["frameCount"]
    # Recheck the whole sequence immediately before assembly, including batches
    # that were completed in a previous process or attempt.
    verified = {}
    if len(_verified_frames(output, job, digests=verified)) != count:
        raise RuntimeError("Frame sequence is incomplete, changed or corrupt; refusing to encode")
    source_sequence_digest = _frame_digest(output, count, digests=verified)
    common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    name = primary_artifact(job)
    temporary = output / (".film.partial.mov" if job_format(job) == "prores" else ".film.partial.mp4")
    codec = (["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
             if job_format(job) == "prores" else ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
    audio_input, audio_output = _audio_arguments(output, job, scene)
    _run_process(common + ["-framerate", str(profile["fps"]), "-start_number", "1",
                          "-i", str(output / "frames" / "%06d.png")] + audio_input + ["-frames:v", str(count)] + codec +
                          audio_output + [str(temporary)], output, "ffmpeg.log", worker_fd=worker_fd)
    if not temporary.exists() or temporary.stat().st_size == 0:
        raise RuntimeError("FFmpeg returned without a film")
    os.replace(temporary, output / name)
    shots = scene["shots"]
    still_frames = ([(shot["startFrame"] + shot["endFrame"]) // 2 for shot in shots]
                    if len(shots) == 3 else [1, (count + 1) // 2, count])
    for index, number in enumerate(still_frames, start=1):
        _check_cancel(output)
        temporary = output / f".still-{index:02d}.partial.png"
        # These deliverables are the approved PNG frame itself. Re-encoding
        # repeats decoding/compression and can discard its color metadata.
        shutil.copyfile(output / "frames" / f"{number:06d}.png", temporary)
        if not validate_png(temporary, profile["width"], profile["height"]):
            raise RuntimeError(f"Copied still is invalid for frame {number}")
        os.replace(temporary, output / f"still-{index:02d}.png")
    rows = math.ceil(count / 12)
    temporary = output / ".contact-sheet.partial.png"
    _run_process(common + ["-framerate", str(profile["fps"]), "-start_number", "1",
                          "-i", str(output / "frames" / "%06d.png"),
                          "-vf", f"scale=128:-1,tile=12x{rows}:nb_frames={count}",
                          "-frames:v", "1", "-update", "1", str(temporary)], output, "ffmpeg.log", worker_fd=worker_fd)
    if not validate_png(temporary):
        raise RuntimeError("FFmpeg returned an invalid contact sheet")
    os.replace(temporary, output / "contact-sheet.png")
    _check_cancel(output)
    final_sequence_digest = _frame_digest(output, count)
    if final_sequence_digest != source_sequence_digest:
        raise RuntimeError("Frame sequence changed during export; refusing to mark succeeded")
    job["frameSequenceDigest"] = final_sequence_digest
    _record_frame_digests(output, job, range(1, count + 1), digests=verified)
    job["artifacts"] = {name: {"bytes": (output / name).stat().st_size,
                                     "sha256": _sha256(output / name)}
                        for name in artifact_names(job)}


def _archive_frames(output, job):
    """Lossless rendered frames and timing, without an intermediate video codec."""
    profile = job["renderProfile"]
    count = profile["frameCount"]
    verified = {}
    if len(_verified_frames(output, job, digests=verified)) != count:
        raise RuntimeError("Frame sequence is incomplete, changed or corrupt; refusing to archive")
    source_digest = _frame_digest(output, count, digests=verified)
    temporary = output / ".frames.partial.zip"
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            manifest = {"schemaVersion": 1, "fps": profile["fps"], "firstFrame": 1,
                        "frameCount": count, "width": profile["width"], "height": profile["height"],
                        "pattern": "frames/%06d.png", "sourceDigest": job["sceneDigest"]}
            archive.writestr("sequence.json", json.dumps(manifest, indent=2) + "\n")
            for number in range(1, count + 1):
                _check_cancel(output)
                path = output / "frames" / f"{number:06d}.png"
                with path.open("rb") as source, archive.open("frames/" + path.name, "w", force_zip64=True) as destination:
                    while chunk := source.read(1024 * 1024):
                        _check_cancel(output)
                        destination.write(chunk)
        _check_cancel(output)
        if _frame_digest(output, count) != source_digest:
            raise RuntimeError("Frame sequence changed during export; refusing to mark succeeded")
        os.replace(temporary, output / "frames.zip")
    finally:
        temporary.unlink(missing_ok=True)
    job["frameSequenceDigest"] = source_digest
    _record_frame_digests(output, job, range(1, count + 1), digests=verified)
    job["artifacts"] = {name: {"bytes": (output / name).stat().st_size, "sha256": _sha256(output / name)}
                        for name in artifact_names(job)}

def run_job(output_dir, *, blender="blender", ffmpeg="ffmpeg", reset_cancellation=True):
    """Render missing/invalid frames, then assemble all requested deliverables.

    Failed attempts remain in the manifest and raise their original exception.
    A subsequent call resumes; an explicit cancel also remains resumable.
    Queue dispatchers pass reset_cancellation=False to honor a queued cancel.
    """
    output = Path(output_dir).resolve()
    if not output.is_dir():
        raise ValueError(f"Job directory does not exist: {output}")
    with _lock(output, ".worker.lock", blocking=False) as worker_lock:
        with _lock(output, ".manifest.lock"):
            job = _read_job(output)
            if job.get("kind") == "still":
                raise ValueError("This is a still job; resume it with film.stills.run_still_job")
            # Clear a previous cancellation before validation. A cancellation
            # arriving after this point must remain visible to this attempt.
            if reset_cancellation:
                (output / "cancel.requested").unlink(missing_ok=True)
        attempt = None
        try:
            _check_cancel(output)
            scene = _verify_snapshots(output, job)
            export_format = job_format(job)
            profile = job["renderProfile"]
            validate_plate_inputs(output, job, range(1, profile["frameCount"] + 1))
            _recover_raw_scene_frames(output, job)
            completed_digests = {}
            completed = _verified_frames(output, job, digests=completed_digests)
            job["completedRanges"] = _ranges(completed)
            if job["state"] == "succeeded" and _outputs_valid(output, job, completed, digests=completed_digests):
                return job
            for prior in job["attempts"]:
                if prior.get("state") == "running":
                    prior.update(state="failed", endedAt=_now(),
                                 error="Worker interrupted before attempt completion")
            attempt = {"attempt": len(job["attempts"]) + 1, "startedAt": _now(),
                       "state": "running", "resumedFromRanges": _ranges(completed), "tools": {}}
            job["attempts"].append(attempt)
            job["state"] = "running"
            _save_job(output, job)
            tools = [("blender", blender, BLENDER_VERSION)]
            if export_format != "png-sequence":
                tools.append(("ffmpeg", ffmpeg, FFMPEG_VERSION))
            for tool, command, version in tools:
                _check_cancel(output)
                job["tools"][tool] = _check_tool(command, tool, version)
                attempt["tools"][tool] = job["tools"][tool]
                _save_job(output, job)
            (output / "frames").mkdir(exist_ok=True)
            rebuild_blend = _blend_needs_rebuild(output, job)
            completed_set = set(completed)
            missing = [frame for frame in range(1, profile["frameCount"] + 1) if frame not in completed_set]
            restored, rebuild_blend = _restore_raw_scene_frames(output, job, scene, blender, missing,
                                                               rebuild_blend, worker_lock.fileno())
            if restored:
                inspected = {frame: _inspect_png(output / "frames" / f"{frame:06d}.png", profile["width"], profile["height"])
                             for frame in restored}
                if any(value is None for value in inspected.values()):
                    raise RuntimeError("A reused raw frame failed final finishing validation")
                _record_frame_digests(output, job, restored, digests=inspected)
                completed = sorted(completed + restored)
                job["completedRanges"] = _ranges(completed)
                _save_job(output, job)
                completed_set.update(restored)
                missing = [frame for frame in missing if frame not in completed_set]
            while missing:
                batch = missing[:BATCH_SIZE]
                scene_frames = _render_non_scene_frames(output, profile, batch)
                finished_scene_frames = scene_frames
                if scene_frames or rebuild_blend:
                    result = _run_process(_render_command(blender, output, profile, scene_frames), output, "blender.log",
                                          worker_fd=worker_lock.fileno())
                    if isinstance(result, dict) and "yieldedFrames" in result:
                        finished_scene_frames = result["yieldedFrames"]
                    rebuild_blend = False
                    _post_process_scene_frames(output, job, finished_scene_frames)
                # Flat frames were composed before the native batch. A clean
                # cooperative yield commits those plus only the proven native
                # prefix, then releases the GPU for the current-frame proof.
                finished = [frame for frame in batch if frame not in scene_frames or frame in finished_scene_frames]
                if not finished:
                    raise RuntimeError("Native render batch made no verified progress")
                inspected = {frame: _inspect_png(output / "frames" / f"{frame:06d}.png", profile["width"], profile["height"])
                             for frame in finished}
                invalid = [frame for frame in finished if inspected[frame] is None]
                if invalid:
                    raise RuntimeError(f"Renderer did not produce valid frames: {invalid}")
                _record_frame_digests(output, job, finished, digests=inspected)
                completed = sorted(completed + finished)
                job["completedRanges"] = _ranges(completed)
                _save_job(output, job)
                finished_set = set(finished)
                missing = [frame for frame in missing if frame not in finished_set]
            if rebuild_blend or not _blend_valid(output / "scene.blend"):
                _run_process(_render_command(blender, output, profile, []), output, "blender.log",
                             worker_fd=worker_lock.fileno())
            if not _blend_valid(output / "scene.blend"):
                raise RuntimeError("Renderer did not produce a reopenable scene.blend")
            if export_format == "png-sequence":
                _archive_frames(output, job)
            else:
                _encode(output, job, scene, ffmpeg, worker_fd=worker_lock.fileno())
            job["state"] = attempt["state"] = "succeeded"
            attempt["endedAt"] = _now()
            _save_job(output, job)
            return job
        except _Cancelled:
            job["state"] = "cancelled"
            if attempt:
                attempt.update(state="cancelled", endedAt=_now())
            verified = {}
            completed = _verified_frames(output, job, digests=verified)
            _record_frame_digests(output, job, completed, digests=verified)
            job["completedRanges"] = _ranges(completed)
            _save_job(output, job)
            return job
        except BaseException as error:
            message = f"{type(error).__name__}: {error}"
            job["state"] = "failed"
            if attempt:
                attempt.update(state="failed", endedAt=_now(), error=message)
            job["errors"].append({"time": _now(), "attempt": attempt["attempt"] if attempt else None,
                                  "message": message})
            verified = {}
            completed = _verified_frames(output, job, digests=verified)
            _record_frame_digests(output, job, completed, digests=verified)
            job["completedRanges"] = _ranges(completed)
            _save_job(output, job)
            raise


def cancel_job(output_dir):
    """Record cancellation; the active worker observes it between polls/batches."""
    output = Path(output_dir).resolve()
    if not (output / "job.json").is_file():
        raise ValueError(f"No render job in {output}")
    with _lock(output, ".manifest.lock"):
        job = _read_job(output)
        if job["state"] == "succeeded":
            return job
        _atomic_json(output / "cancel.requested", {"requestedAt": _now()})
        if job["state"] != "running":
            job["state"] = "cancelled"
        job["cancellationRequested"] = True
        job["updatedAt"] = _now()
        _atomic_json(output / "job.json", job)
        return job
