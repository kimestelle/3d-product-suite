"""Worker failure/recovery tests use real small PNGs and mocked subprocesses."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import patch
import zlib

from film import jobs

ROOT = Path(__file__).resolve().parents[1]


def png_bytes(width=4, height=6, *, value=70, raw=None):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    pixels = raw if raw is not None else (b"\0" + bytes([value]) * width * 3) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def versions(command, **kwargs):
    version = "Blender 4.3.2\n" if command[-1] == "--version" else "ffmpeg version 7.1.5-static\n"
    return subprocess.CompletedProcess(command, 0, version)


class JobTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "input.json"
        self.output = self.root / "job"
        self.scene = json.loads((ROOT / "examples" / "bottle.scene.json").read_text())
        self.scene["render"].update(width=4, height=6, samples=1)
        self.scene["actions"] = []
        for index, shot in enumerate(self.scene["shots"]):
            shot.update(startFrame=index * 10 + 1, endFrame=(index + 1) * 10)
        self.source.write_text(json.dumps(self.scene))
        self.commands = []

    def init(self, **kwargs):
        return jobs.create_job(self.source, self.output, **kwargs)

    def manifest(self):
        return json.loads((self.output / "job.json").read_text())

    def process(self, command, output, log_name, **kwargs):
        self.commands.append(command)
        if "--python" in command:
            (output / "scene.blend").write_bytes(b"BLENDER-v403" + b"fixture")
            if "--frames" in command:
                frames = command[command.index("--frames") + 1]
                for frame in map(int, frames.split(",")):
                    (output / "frames" / f"{frame:06d}.png").write_bytes(png_bytes())
        else:
            destination = Path(command[-1])
            destination.write_bytes(b"fixture-video" if destination.suffix == ".mp4" else png_bytes())

    def run_worker(self, callback=None):
        with patch.object(jobs.subprocess, "run", side_effect=versions), patch.object(
                jobs, "_run_process", side_effect=callback or self.process):
            return jobs.run_job(self.output)

    def test_creation_is_idempotent_but_other_sources_or_profiles_are_rejected(self):
        first = self.init()
        self.assertEqual(first, self.init())
        with self.assertRaisesRegex(ValueError, "different source revision or render profile"):
            self.init(width=8)
        self.scene["product"]["revisionId"] = "replacement-v2"
        self.source.write_text(json.dumps(self.scene))
        with self.assertRaisesRegex(ValueError, "different source revision"):
            self.init()
        self.assertEqual(self.manifest()["sceneDigest"], first["sceneDigest"])
        self.assertEqual(first["state"], "queued")

    def test_nonempty_directory_and_invalid_dimensions_are_rejected(self):
        self.output.mkdir()
        (self.output / "precious.txt").write_text("keep")
        with self.assertRaisesRegex(ValueError, "not empty"):
            self.init()
        self.assertEqual((self.output / "precious.txt").read_text(), "keep")
        for width in (3, 0, True, 2.5):
            with self.subTest(width=width), self.assertRaises(ValueError):
                self.init(width=width)

    def test_modified_source_snapshot_fails_before_submitting_a_process(self):
        self.init()
        scene_path = self.output / "scene.json"
        scene = json.loads(scene_path.read_text())
        scene["product"]["revisionId"] = "silently-edited"
        scene_path.write_text(json.dumps(scene))
        with patch.object(jobs.subprocess, "run") as subprocess_run:
            with self.assertRaisesRegex(ValueError, "Source revision was modified"):
                jobs.run_job(self.output)
        subprocess_run.assert_not_called()
        self.assertEqual(self.manifest()["state"], "failed")
        self.assertIn("Source revision", self.manifest()["errors"][-1]["message"])

    def test_changed_renderer_implementation_or_snapshot_is_rejected(self):
        renderer = self.root / "renderer.py"
        renderer.write_bytes(jobs._RENDERER.read_bytes())
        with patch.object(jobs, "_RENDERER", renderer):
            self.init()
            original = renderer.read_bytes()
            renderer.write_bytes(original + b"\n# code change\n")
            with self.assertRaisesRegex(ValueError, "Renderer implementation changed"):
                jobs.run_job(self.output)
            renderer.write_bytes(original)
            (self.output / "renderer.py").write_bytes(original + b"\n# snapshot edit\n")
            with self.assertRaisesRegex(ValueError, "Renderer snapshot was modified"):
                jobs.run_job(self.output)

    def test_modified_sample_snapshot_is_rejected(self):
        self.init()
        samples = json.loads((self.output / "samples.json").read_text())
        samples["frames"][0]["camera"]["focalLengthMm"] = 12
        (self.output / "samples.json").write_text(json.dumps(samples))
        with self.assertRaisesRegex(ValueError, "Sample snapshot does not match"):
            jobs.run_job(self.output)
        self.assertEqual(self.manifest()["state"], "failed")

    def test_wrong_tool_version_is_recorded_as_failed_attempt(self):
        self.init()
        with patch.object(jobs.subprocess, "run", return_value=subprocess.CompletedProcess(
                ["blender"], 0, "Blender 4.4.0\n")), patch.object(jobs, "_run_process") as process:
            with self.assertRaisesRegex(RuntimeError, "Expected blender 4.3.2"):
                jobs.run_job(self.output)
        process.assert_not_called()
        job = self.manifest()
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["attempts"][0]["state"], "failed")

    def test_partial_batch_failure_preserves_verified_frames_and_retry_history(self):
        self.init()
        failed = False
        def fail_second_batch(command, output, log_name, **kwargs):
            nonlocal failed
            if "--frames" in command and command[command.index("--frames") + 1].startswith("13,") and not failed:
                failed = True
                (output / "frames" / "000013.png").write_bytes(png_bytes())
                raise RuntimeError("simulated renderer crash")
            self.process(command, output, log_name)
        with self.assertRaisesRegex(RuntimeError, "simulated renderer crash"):
            self.run_worker(fail_second_batch)
        self.assertEqual(self.manifest()["completedRanges"], [[1, 13]])
        self.commands.clear()
        final = self.run_worker()
        renders = [command for command in self.commands if "--frames" in command]
        requested = [int(frame) for command in renders for frame in command[command.index("--frames") + 1].split(",")]
        self.assertEqual(requested, list(range(14, 31)))
        self.assertEqual(final["completedRanges"], [[1, 30]])
        self.assertEqual([a["state"] for a in final["attempts"]], ["failed", "succeeded"])
        self.assertEqual(final["attempts"][1]["resumedFromRanges"], [[1, 13]])

    def test_resume_rechecks_png_data_and_dimensions(self):
        self.init()
        (self.output / "frames").mkdir()
        (self.output / "frames" / "000001.png").write_bytes(png_bytes())
        (self.output / "frames" / "000002.png").write_bytes(png_bytes()[:-5])
        (self.output / "frames" / "000003.png").write_bytes(png_bytes(width=6))
        self.run_worker()
        renders = [command for command in self.commands if "--frames" in command]
        requested = [int(frame) for command in renders for frame in command[command.index("--frames") + 1].split(",")]
        self.assertEqual(requested, list(range(2, 31)))

    def test_all_frames_revalidated_before_video_encoding(self):
        self.init()
        def corrupt_previously_rendered_frame(command, output, log_name, **kwargs):
            self.process(command, output, log_name)
            if "--frames" in command and command[command.index("--frames") + 1].startswith("25,"):
                (output / "frames" / "000001.png").write_bytes(b"corrupt between batches")
        with self.assertRaisesRegex(RuntimeError, "refusing to encode"):
            self.run_worker(corrupt_previously_rendered_frame)
        self.assertFalse(any("-c:v" in command for command in self.commands))
        self.assertEqual(self.manifest()["completedRanges"], [[2, 30]])

    def test_success_is_idempotent_and_missing_or_changed_exports_are_reassembled(self):
        self.init()
        first = self.run_worker()
        self.assertEqual(first["state"], "succeeded")
        self.assertEqual(len(first["artifacts"]), 6)
        self.assertEqual(first["tools"]["blender"]["version"], "4.3.2")
        self.commands.clear()
        self.assertEqual(self.run_worker(), first)
        self.assertEqual(self.commands, [])
        (self.output / "film.mp4").unlink()
        second = self.run_worker()
        self.assertEqual(len(second["attempts"]), 2)
        self.assertFalse(any("--python" in command for command in self.commands))
        self.commands.clear()
        (self.output / "frames" / "000001.png").write_bytes(png_bytes(value=90))
        third = self.run_worker()
        self.assertEqual(len(third["attempts"]), 3)
        self.assertTrue(any("-c:v" in command for command in self.commands))

    def test_modified_blend_with_valid_header_is_rebuilt_before_success(self):
        self.init()
        self.run_worker()
        blend = self.output / "scene.blend"
        original = blend.read_bytes()
        blend.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        self.assertTrue(jobs._blend_valid(blend))
        self.commands.clear()
        final = self.run_worker()
        builders = [command for command in self.commands if "--python" in command]
        self.assertEqual(len(builders), 1)
        self.assertNotIn("--frames", builders[0])
        self.assertEqual(blend.read_bytes(), original)
        self.assertEqual(final["artifacts"]["scene.blend"]["sha256"], jobs._sha256(blend))

    def test_modified_valid_frame_is_rendered_again_from_approved_source(self):
        self.init()
        first = self.run_worker()
        frame = self.output / "frames" / "000001.png"
        frame.write_bytes(png_bytes(value=90))
        self.commands.clear()
        final = self.run_worker()
        renders = [command for command in self.commands if "--frames" in command]
        self.assertEqual(len(renders), 1)
        self.assertEqual(renders[0][renders[0].index("--frames") + 1], "1")
        self.assertEqual(frame.read_bytes(), png_bytes())
        self.assertEqual(final["frameSequenceDigest"], first["frameSequenceDigest"])
        self.assertEqual(len(final["frameDigests"]), 30)

    def test_legacy_success_with_changed_sequence_renders_all_frames_again(self):
        self.init()
        first = self.run_worker()
        first.pop("frameDigests")
        jobs._atomic_json(self.output / "job.json", first)
        (self.output / "frames" / "000001.png").write_bytes(png_bytes(value=90))
        self.commands.clear()
        self.run_worker()
        renders = [command for command in self.commands if "--frames" in command]
        requested = [int(frame) for command in renders for frame in command[command.index("--frames") + 1].split(",")]
        self.assertEqual(requested, list(range(1, 31)))

    def test_changed_frame_during_ffmpeg_export_cannot_be_marked_successful(self):
        self.init()
        def edit_during_encoding(command, output, log_name, **kwargs):
            self.process(command, output, log_name, **kwargs)
            if "-c:v" in command:
                (output / "frames" / "000001.png").write_bytes(png_bytes(value=99))
        with self.assertRaisesRegex(RuntimeError, "Frame sequence changed during export"):
            self.run_worker(edit_during_encoding)
        self.assertEqual(self.manifest()["state"], "failed")
        self.assertEqual(self.manifest()["completedRanges"], [[2, 30]])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux flock inheritance")
    def test_render_child_retains_worker_lock_after_parent_is_killed(self):
        self.init()
        ready = self.root / "child.pid"
        child_code = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
        parent_code = """
from pathlib import Path
import sys
from film import jobs
output, ready, child_code = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
with jobs._lock(output, '.worker.lock', blocking=False) as handle:
    jobs._run_process([sys.executable, '-c', child_code, ready], output, 'child.log', worker_fd=handle.fileno())
"""
        parent = subprocess.Popen([sys.executable, "-c", parent_code, str(self.output), str(ready), child_code],
                                  cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        child_pid = None
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and parent.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            if not ready.exists():
                parent.kill()
                _, errors = parent.communicate(timeout=5)
                self.fail(f"Render child did not become ready: {errors!r}")
            child_pid = int(ready.read_text())
            parent.kill()
            parent.wait(timeout=5)
            with self.assertRaisesRegex(RuntimeError, "Another worker"):
                with jobs._lock(self.output, ".worker.lock", blocking=False):
                    pass
            os.kill(child_pid, 15)
            deadline = time.monotonic() + 5
            acquired = False
            while time.monotonic() < deadline:
                try:
                    with jobs._lock(self.output, ".worker.lock", blocking=False):
                        acquired = True
                    break
                except RuntimeError:
                    time.sleep(0.01)
            self.assertTrue(acquired, "Child exit did not release the inherited worker lock")
        finally:
            if parent.poll() is None:
                parent.kill()
            parent.communicate(timeout=5)
            if child_pid is not None:
                try:
                    os.kill(child_pid, 9)
                except ProcessLookupError:
                    pass

    def test_cancelled_job_can_resume_and_succeeded_job_ignores_cancel(self):
        self.init()
        self.assertEqual(jobs.cancel_job(self.output)["state"], "cancelled")
        result = self.run_worker()
        self.assertEqual(result["state"], "succeeded")
        self.assertFalse((self.output / "cancel.requested").exists())
        self.assertEqual(jobs.cancel_job(self.output)["state"], "succeeded")

    def test_queue_dispatch_honors_cancellation_without_reset(self):
        self.init()
        jobs.cancel_job(self.output)
        with patch.object(jobs.subprocess, "run") as tool, patch.object(jobs, "_run_process") as process:
            result = jobs.run_job(self.output, reset_cancellation=False)
        tool.assert_not_called()
        process.assert_not_called()
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(result["attempts"], [])
        self.assertTrue((self.output / "cancel.requested").exists())

    def test_cancellation_arriving_during_frame_reconciliation_is_preserved(self):
        self.init()
        original_frames = jobs._frames
        calls = 0
        def reconcile(output, profile):
            nonlocal calls
            calls += 1
            if calls == 1:
                jobs.cancel_job(output)
            return original_frames(output, profile)
        with patch.object(jobs, "_frames", side_effect=reconcile), patch.object(jobs.subprocess, "run") as tool:
            result = jobs.run_job(self.output)
        tool.assert_not_called()
        self.assertEqual(result["state"], "cancelled")

    def test_cancellation_terminates_an_active_process_and_records_state(self):
        self.init()
        class Process:
            returncode = None
            terminated = False
            def poll(self):
                return self.returncode
            def terminate(self):
                self.terminated = True
                self.returncode = -15
            def wait(self, timeout=None):
                return self.returncode
        process = Process()
        def cancel(_):
            jobs.cancel_job(self.output)
        with patch.object(jobs.subprocess, "run", side_effect=versions), patch.object(
                jobs.subprocess, "Popen", return_value=process), patch.object(jobs.time, "sleep", side_effect=cancel):
            result = jobs.run_job(self.output)
        self.assertTrue(process.terminated)
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(result["attempts"][0]["state"], "cancelled")
        self.assertEqual(result["completedRanges"], [])

    def test_single_worker_lock_prevents_duplicate_work(self):
        self.init()
        with jobs._lock(self.output, ".worker.lock"):
            with self.assertRaisesRegex(RuntimeError, "Another worker"):
                jobs.run_job(self.output)
        self.assertEqual(self.manifest()["state"], "queued")

    def test_interrupted_attempt_is_reconciled_before_retry(self):
        self.init()
        job = self.manifest()
        job["state"] = "running"
        job["attempts"] = [{"attempt": 1, "state": "running", "startedAt": "old-process"}]
        jobs._atomic_json(self.output / "job.json", job)
        final = self.run_worker()
        self.assertEqual(final["attempts"][0]["state"], "failed")
        self.assertIn("interrupted", final["attempts"][0]["error"])
        self.assertEqual(final["attempts"][1]["state"], "succeeded")


class PngValidationTests(unittest.TestCase):
    def test_truncation_crc_pixel_stream_and_dimensions_are_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "image.png"
            path.write_bytes(png_bytes())
            self.assertTrue(jobs.validate_png(path, 4, 6))
            self.assertFalse(jobs.validate_png(path, 6, 4))
            variants = [png_bytes()[:-1], png_bytes() + b"trailing", b"not PNG",
                        png_bytes(raw=b"\0"), png_bytes(raw=(b"\5" + b"a" * 12) * 6)]
            corrupt_crc = bytearray(png_bytes())
            corrupt_crc[-1] ^= 1
            variants.append(bytes(corrupt_crc))
            for index, invalid in enumerate(variants):
                with self.subTest(index=index):
                    path.write_bytes(invalid)
                    self.assertFalse(jobs.validate_png(path))


if __name__ == "__main__":
    unittest.main()
