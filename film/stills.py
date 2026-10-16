"""Single-frame Cycles jobs using the same immutable snapshots as reels."""

from pathlib import Path
import shutil

from . import jobs
from .scene import evaluate


def create_still_job(scene_path, output_dir, *, frame=1, width=540, height=960, samples=32):
    evaluate(jobs.load_scene(scene_path), frame)
    output = Path(output_dir).resolve()
    if (output / "job.json").exists():
        existing = jobs._read_job(output)
        if existing.get("kind") != "still" or existing.get("frame") != frame:
            raise ValueError("Output directory belongs to another render request")
    job = jobs.create_job(scene_path, output, width=width, height=height, samples=samples)
    scene = jobs.load_scene(output / "scene.json")
    job.update(kind="still", frame=frame)
    jobs._save_job(output, job)
    return job


def _valid_outputs(output, job):
    artifacts = job.get("artifacts", {})
    for name in ("still.png", "scene.blend"):
        record = artifacts.get(name, {})
        path = output / name
        if not path.is_file() or path.stat().st_size != record.get("bytes") or jobs._sha256(path) != record.get("sha256"):
            return False
    profile = job["renderProfile"]
    return jobs.validate_png(output / "still.png", profile["width"], profile["height"]) and jobs._blend_valid(output / "scene.blend")


def run_still_job(output_dir, *, blender="blender", ffmpeg="ffmpeg", reset_cancellation=True):
    output = Path(output_dir).resolve()
    with jobs._lock(output, ".worker.lock", blocking=False) as worker_lock:
        with jobs._lock(output, ".manifest.lock"):
            job = jobs._read_job(output)
            if reset_cancellation:
                (output / "cancel.requested").unlink(missing_ok=True)
        if job.get("kind") != "still":
            raise ValueError("This is not a single-frame job")
        attempt = None
        try:
            jobs._check_cancel(output)
            scene = jobs._verify_snapshots(output, job)
            frame = job["frame"]
            evaluate(scene, frame)
            if scene["environment"]["kind"] == "splat":
                jobs.validate_plate_inputs(output, job, [frame])
            if job["state"] == "succeeded" and _valid_outputs(output, job):
                return job
            for prior in job["attempts"]:
                if prior.get("state") == "running":
                    prior.update(state="failed", endedAt=jobs._now(), error="Worker interrupted")
            attempt = {"attempt": len(job["attempts"]) + 1, "state": "running", "startedAt": jobs._now(), "tools": {}}
            job["attempts"].append(attempt)
            job["state"] = "running"
            jobs._save_job(output, job)
            job["tools"]["blender"] = jobs._check_tool(blender, "blender", jobs.BLENDER_VERSION)
            attempt["tools"] = dict(job["tools"])
            profile = job["renderProfile"]
            path = output / "frames" / f"{frame:06d}.png"
            recorded = job.get("frameDigests", {}).get(str(frame))
            needs_frame = not jobs.validate_png(path, profile["width"], profile["height"])
            if recorded and path.is_file() and jobs._sha256(path) != recorded:
                needs_frame = True
            if needs_frame or jobs._blend_needs_rebuild(output, job):
                jobs._run_process(jobs._render_command(blender, output, profile, [frame] if needs_frame else []),
                                  output, "blender.log", worker_fd=worker_lock.fileno())
            jobs._check_cancel(output)
            if not jobs.validate_png(path, profile["width"], profile["height"]) or not jobs._blend_valid(output / "scene.blend"):
                raise RuntimeError("Renderer did not produce a valid still and saved scene")
            source_hash = jobs._sha256(path)
            temporary = output / ".still.partial.png"
            shutil.copyfile(path, temporary)
            temporary.replace(output / "still.png")
            if jobs._sha256(path) != source_hash or jobs._sha256(output / "still.png") != source_hash:
                raise RuntimeError("Still frame changed during export")
            job["frameDigests"] = {str(frame): source_hash}
            job["completedRanges"] = [[frame, frame]]
            job["artifacts"] = {name: {"bytes": (output / name).stat().st_size, "sha256": jobs._sha256(output / name)}
                                for name in ("still.png", "scene.blend")}
            jobs._check_cancel(output)
            job["state"] = attempt["state"] = "succeeded"
            attempt["endedAt"] = jobs._now()
            jobs._save_job(output, job)
            return job
        except jobs._Cancelled:
            job["state"] = "cancelled"
            if attempt:
                attempt.update(state="cancelled", endedAt=jobs._now())
            jobs._save_job(output, job)
            return job
        except BaseException as error:
            message = f"{type(error).__name__}: {error}"
            job["state"] = "failed"
            if attempt:
                attempt.update(state="failed", endedAt=jobs._now(), error=message)
            job["errors"].append({"time": jobs._now(), "message": message, "attempt": attempt["attempt"] if attempt else None})
            jobs._save_job(output, job)
            raise
