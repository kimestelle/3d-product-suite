"""Single-frame snapshot integrity, failure recovery and artifact restoration."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film import jobs, stills
from film.scene import load_scene, scene_digest
from tests.test_jobs import png_bytes

ROOT = Path(__file__).resolve().parents[1]


class StillTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / "still"
        self.source = self.root / "source.json"
        self.scene = load_scene(ROOT / "examples" / "bottle.scene.json")
        self.scene["actions"] = []
        self.scene["render"].update(width=4, height=6, samples=1)
        for index, shot in enumerate(self.scene["shots"]):
            shot.update(startFrame=index * 2 + 1, endFrame=index * 2 + 2)
        self.source.write_text(json.dumps(self.scene))
        renderer = self.root / "renderer.py"
        renderer.write_bytes(jobs._RENDERER.read_bytes())
        renderer_patch = patch.object(jobs, "_RENDERER", renderer)
        renderer_patch.start()
        self.addCleanup(renderer_patch.stop)
        self.commands = []

    def create(self, **kwargs):
        return stills.create_still_job(self.source, self.output, frame=kwargs.pop("frame", 4),
                                      width=kwargs.pop("width", 4), height=kwargs.pop("height", 6), samples=kwargs.pop("samples", 2), **kwargs)

    def manifest(self):
        return jobs._read_job(self.output)

    def render(self, command, output, log_name, **kwargs):
        self.commands.append(command)
        self.assertEqual(log_name, "blender.log")
        self.assertIn("worker_fd", kwargs)
        (output / "frames").mkdir(exist_ok=True)
        (output / "scene.blend").write_bytes(b"BLENDER-v403" + b"single-frame-fixture")
        if "--frames" in command:
            for number in command[command.index("--frames") + 1].split(","):
                (output / "frames" / f"{int(number):06d}.png").write_bytes(png_bytes())

    def run_worker(self, callback=None):
        tool = {"command": "blender", "version": jobs.BLENDER_VERSION, "reported": "Blender 4.3.2"}
        with patch.object(jobs, "_check_tool", return_value=tool) as check, patch.object(jobs, "_run_process", side_effect=callback or self.render):
            result = stills.run_still_job(self.output, ffmpeg="does-not-exist")
        self.tool_checks = check.call_args_list
        return result

    def test_creation_pins_requested_frame_source_and_render_profile(self):
        job = self.create()
        self.assertEqual(job["kind"], "still")
        self.assertEqual(job["frame"], 4)
        self.assertEqual(job["sceneDigest"], scene_digest(self.scene))
        self.assertEqual(job["renderProfile"]["frameCount"], 6)
        self.assertEqual((job["renderProfile"]["width"], job["renderProfile"]["height"], job["renderProfile"]["samples"]), (4, 6, 2))
        self.assertEqual(self.create()["jobId"], job["jobId"])
        self.assertEqual(jobs._verify_snapshots(self.output, job), self.scene)
        with self.assertRaisesRegex(ValueError, "another render request"):
            self.create(frame=5)
        with self.assertRaisesRegex(ValueError, "different source revision or render profile"):
            self.create(width=8)
        self.assertEqual(self.manifest()["frame"], 4)

    def test_default_still_profile_is_high_resolution_and_frame_errors_create_no_job(self):
        default = stills.create_still_job(self.source, self.root / "default")
        self.assertEqual(default["frame"], 1)
        self.assertEqual((default["renderProfile"]["width"], default["renderProfile"]["height"], default["renderProfile"]["samples"]), (540, 960, 32))
        for index, frame in enumerate((0, 7, True, 1.0, "1")):
            output = self.root / f"bad-frame-{index}"
            with self.subTest(frame=frame), self.assertRaises(ValueError):
                stills.create_still_job(self.source, output, frame=frame)
            self.assertFalse((output / "job.json").exists(), "Rejected frame must not leave an actionable reel job")

    def test_reel_and_still_directories_cannot_be_interchanged(self):
        jobs.create_job(self.source, self.output, width=4, height=6, samples=2)
        before = (self.output / "job.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "another render request"):
            self.create()
        with self.assertRaisesRegex(ValueError, "not a single-frame job"):
            self.run_worker()
        self.assertEqual((self.output / "job.json").read_bytes(), before)

    def test_success_renders_only_requested_frame_without_ffmpeg_and_is_idempotent(self):
        self.create()
        result = self.run_worker()
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["completedRanges"], [[4, 4]])
        self.assertEqual(set(result["artifacts"]), {"still.png", "scene.blend"})
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0][self.commands[0].index("--frames") + 1], "4")
        self.assertEqual([call.args[1] for call in self.tool_checks], ["blender"])
        self.assertEqual([path.name for path in (self.output / "frames").iterdir()], ["000004.png"])
        self.assertEqual((self.output / "still.png").read_bytes(), (self.output / "frames" / "000004.png").read_bytes())
        before = (self.output / "job.json").read_bytes()
        self.commands.clear()
        again = self.run_worker()
        self.assertEqual(again, result)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.tool_checks, [])
        self.assertEqual((self.output / "job.json").read_bytes(), before)

    def test_failed_renderer_records_attempt_and_resume_restores_exact_still(self):
        self.create()
        def fail(command, output, log_name, **kwargs):
            self.render(command, output, log_name, **kwargs)
            (output / "frames" / "000004.png").write_bytes(b"incomplete-render")
            raise RuntimeError("simulated still renderer crash")
        with self.assertRaisesRegex(RuntimeError, "simulated still renderer crash"):
            self.run_worker(fail)
        failed = self.manifest()
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["attempts"][0]["state"], "failed")
        self.assertIn("simulated still renderer crash", failed["errors"][-1]["message"])
        self.assertFalse((self.output / "still.png").exists())
        self.commands.clear()
        resumed = self.run_worker()
        self.assertEqual(resumed["state"], "succeeded")
        self.assertEqual([attempt["state"] for attempt in resumed["attempts"]], ["failed", "succeeded"])
        self.assertEqual(self.commands[0][self.commands[0].index("--frames") + 1], "4")
        self.assertEqual(resumed["frameDigests"]["4"], jobs._sha256(self.output / "still.png"))

    def test_missing_export_restores_verified_source_without_rendering_again(self):
        self.create()
        first = self.run_worker()
        (self.output / "still.png").unlink()
        self.commands.clear()
        restored = self.run_worker()
        self.assertEqual(restored["state"], "succeeded")
        self.assertEqual(self.commands, [])
        self.assertEqual(restored["artifacts"], first["artifacts"])
        self.assertEqual(len(restored["attempts"]), 2)

    def test_corrupted_source_and_export_are_rerendered_instead_of_reused(self):
        self.create()
        first = self.run_worker()
        changed = png_bytes(value=99)
        (self.output / "frames" / "000004.png").write_bytes(changed)
        (self.output / "still.png").write_bytes(changed)
        self.commands.clear()
        restored = self.run_worker()
        self.assertEqual(restored["state"], "succeeded")
        self.assertEqual(self.commands[0][self.commands[0].index("--frames") + 1], "4")
        self.assertEqual(restored["artifacts"], first["artifacts"])

    def test_changed_blend_is_rebuilt_without_rerendering_verified_frame(self):
        self.create()
        first = self.run_worker()
        source_digest = jobs._sha256(self.output / "frames" / "000004.png")
        (self.output / "scene.blend").write_bytes(b"BLENDER-v403" + b"modified-scene-fixture")
        self.commands.clear()
        restored = self.run_worker()
        self.assertEqual(restored["state"], "succeeded")
        self.assertEqual(len(self.commands), 1)
        self.assertNotIn("--frames", self.commands[0])
        self.assertEqual(jobs._sha256(self.output / "frames" / "000004.png"), source_digest)
        self.assertEqual(restored["artifacts"], first["artifacts"])

    def test_cancelled_still_is_resumable_and_retains_attempt_history(self):
        self.create()
        def cancel_after_render(command, output, log_name, **kwargs):
            self.render(command, output, log_name, **kwargs)
            jobs.cancel_job(output)
        cancelled = self.run_worker(cancel_after_render)
        self.assertEqual(cancelled["state"], "cancelled")
        self.assertTrue((self.output / "cancel.requested").exists())
        self.assertFalse((self.output / "still.png").exists())
        resumed = self.run_worker()
        self.assertEqual(resumed["state"], "succeeded")
        self.assertFalse((self.output / "cancel.requested").exists())
        self.assertEqual([attempt["state"] for attempt in resumed["attempts"]], ["cancelled", "succeeded"])

    def test_modified_scene_snapshot_fails_before_invoking_render_tool(self):
        self.create()
        changed = copy.deepcopy(self.scene)
        changed["product"]["revisionId"] = "unexpected-revision"
        (self.output / "scene.json").write_text(json.dumps(changed))
        with patch.object(jobs, "_check_tool") as tool, patch.object(jobs, "_run_process") as process:
            with self.assertRaisesRegex(ValueError, "Source revision was modified"):
                stills.run_still_job(self.output)
        tool.assert_not_called()
        process.assert_not_called()
        self.assertEqual(self.manifest()["state"], "failed")


if __name__ == "__main__":
    unittest.main()
