"""Formats retain frozen render inputs, verified frames and resumable outputs."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

from film import jobs, server, stills
from film.export_formats import primary_artifact
from tests import test_editor_api as editor_api
from tests import test_jobs as job_tests
from tests.test_jobs import png_bytes
from tests import test_stills as still_tests


class VideoFormatTests(unittest.TestCase):
    setUp = job_tests.JobTests.setUp
    init = job_tests.JobTests.init
    manifest = job_tests.JobTests.manifest
    process = job_tests.JobTests.process
    run_worker = job_tests.JobTests.run_worker

    def test_prores_encodes_hq_422_and_keeps_format_when_resuming(self):
        self.init(export_format="prores")
        result = self.run_worker()
        self.assertEqual(primary_artifact(result), "film.mov")
        encode = next(command for command in self.commands if command[-1].endswith(".mov"))
        self.assertEqual(encode[encode.index("-c:v") + 1], "prores_ks")
        self.assertEqual(encode[encode.index("-profile:v") + 1], "3")
        self.assertEqual(encode[encode.index("-pix_fmt") + 1], "yuv422p10le")
        self.assertNotIn("film.mp4", result["artifacts"])
        with self.assertRaisesRegex(ValueError, "different source revision or render profile"):
            self.init(export_format="mp4")
        self.commands.clear()
        self.assertEqual(self.run_worker(), result)
        self.assertEqual(self.commands, [])

    def test_sequence_packages_exact_verified_frames_with_native_timing_without_ffmpeg(self):
        self.init(export_format="png-sequence")
        with patch.object(jobs, "_check_tool", return_value={}) as checks, patch.object(jobs, "_run_process", side_effect=self.process):
            result = jobs.run_job(self.output, ffmpeg="does-not-exist")
        self.assertEqual([call.args[1] for call in checks.call_args_list], ["blender"])
        self.assertEqual(set(result["artifacts"]), {"frames.zip", "scene.blend"})
        with zipfile.ZipFile(self.output / "frames.zip") as archive:
            self.assertEqual(len(archive.namelist()), 31)
            manifest = json.loads(archive.read("sequence.json"))
            self.assertEqual(manifest["fps"], self.scene["render"]["fps"])
            self.assertEqual(manifest["frameCount"], 30)
            self.assertEqual(archive.read("frames/000012.png"), (self.output / "frames/000012.png").read_bytes())
        self.commands.clear()
        self.assertEqual(self.run_worker(), result)
        self.assertEqual(self.commands, [])
        (self.output / "frames.zip").write_bytes(b"corrupt")
        repaired = self.run_worker()
        self.assertEqual(repaired["state"], "succeeded")
        self.assertEqual(self.commands, [], "Archive repair must not render already verified frames")
        self.assertTrue(zipfile.is_zipfile(self.output / "frames.zip"))

    def test_modified_export_format_is_rejected_before_running_tools(self):
        self.init(export_format="mp4")
        job = self.manifest()
        job["renderProfile"]["format"] = "prores"
        jobs._atomic_json(self.output / "job.json", job)
        with patch.object(jobs, "_check_tool") as check, self.assertRaisesRegex(ValueError, "profile was modified"):
            jobs.run_job(self.output)
        check.assert_not_called()

    def test_archive_rechecks_sources_before_success_and_remains_resumable(self):
        self.init(export_format="png-sequence")
        original = jobs._frame_digest
        calls = 0
        def changed(output, count):
            nonlocal calls
            calls += 1
            if calls == 2:
                (output / "frames" / "000001.png").write_bytes(png_bytes(value=99))
            return original(output, count)
        with patch.object(jobs, "_frame_digest", side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, "Frame sequence changed during export"):
                self.run_worker()
        self.assertEqual(self.manifest()["state"], "failed")
        self.assertFalse((self.output / ".frames.partial.zip").exists())
        self.assertEqual(self.run_worker()["state"], "succeeded")


class StillFormatTests(unittest.TestCase):
    setUp = still_tests.StillTests.setUp
    create = still_tests.StillTests.create
    manifest = still_tests.StillTests.manifest
    render = still_tests.StillTests.render

    def encode(self, command, output, log_name, **kwargs):
        if "--python" in command:
            return self.render(command, output, log_name, **kwargs)
        self.commands.append(command)
        target = Path(command[-1])
        target.write_bytes(b"\xff\xd8" + b"image-fixture" + b"\xff\xd9" if target.suffix == ".jpg"
                           else b"RIFF" + b"\x10\x00\x00\x00" + b"WEBP" + b"image-fixture")

    def worker(self, callback=None):
        with patch.object(jobs, "_check_tool", return_value={}), patch.object(jobs, "_run_process", side_effect=callback or self.encode):
            return stills.run_still_job(self.output)

    def test_jpeg_and_webp_encode_the_requested_still_and_restore_missing_output(self):
        for export_format, extension, encoder in (("jpeg", ".jpg", "mjpeg"), ("webp", ".webp", "libwebp")):
            with self.subTest(format=export_format):
                self.output = self.root / export_format
                self.commands.clear()
                self.create(export_format=export_format)
                result = self.worker()
                self.assertEqual(set(result["artifacts"]), {"still" + extension, "scene.blend"})
                command = self.commands[-1]
                self.assertEqual(command[command.index("-c:v") + 1], encoder)
                self.assertIn("000004.png", command[command.index("-i") + 1])
                self.commands.clear()
                self.assertEqual(self.worker(), result)
                self.assertEqual(self.commands, [])
                (self.output / ("still" + extension)).unlink()
                self.assertEqual(self.worker()["state"], "succeeded")
                self.assertEqual(len(self.commands), 1, "Only conversion should repeat")

    def test_corrupt_encoder_output_is_rejected(self):
        self.create(export_format="webp")
        def invalid(command, output, log_name, **kwargs):
            self.encode(command, output, log_name, **kwargs)
            if log_name == "ffmpeg.log":
                Path(command[-1]).write_bytes(b"bad-output")
        with self.assertRaisesRegex(RuntimeError, "valid still image"):
            self.worker(invalid)
        self.assertEqual(self.manifest()["state"], "failed")

    def test_source_mutation_during_conversion_prevents_success(self):
        self.create(export_format="jpeg")
        def changed(command, output, log_name, **kwargs):
            self.encode(command, output, log_name, **kwargs)
            if log_name == "ffmpeg.log":
                (output / "frames" / "000004.png").write_bytes(png_bytes(value=99))
        with self.assertRaisesRegex(RuntimeError, "Still frame changed during export"):
            self.worker(changed)
        self.assertEqual(self.manifest()["state"], "failed")

    def test_video_format_cannot_create_still_job(self):
        with self.assertRaisesRegex(ValueError, "still export format"):
            self.create(export_format="mp4")
        self.assertFalse(self.output.exists())


class ExportApiTests(unittest.TestCase):
    setUp = editor_api.EditorApiTests.setUp
    stop_server = editor_api.EditorApiTests.stop_server
    request = editor_api.EditorApiTests.request
    bootstrap = editor_api.EditorApiTests.bootstrap

    def test_format_filename_and_verified_download_with_header(self):
        scene = self.bootstrap()["project"]["scene"]
        status, result, _ = self.request("POST", "/api/renders", {"scene": scene, "kind": "still", "frame": 4,
            "width": 4, "height": 6, "samples": 1, "format": "jpeg", "filename": "../lamp\r\nHeader: broken.jpg"})
        self.assertEqual(status, 202)
        self.assertEqual(result["format"], "jpeg")
        self.assertEqual(result["filename"], "lamp-Header- broken")
        directory = self.app.renders.directory(result["id"])
        job = jobs._read_job(directory)
        payload = b"\xff\xd8" + b"image-fixture" + b"\xff\xd9"
        (directory / "still.jpg").write_bytes(payload)
        job.update(state="succeeded", artifacts={"still.jpg": {"sha256": jobs._sha256(directory / "still.jpg"), "bytes": len(payload)}})
        jobs._save_job(directory, job)
        self.app.renders.active.discard(result["id"])
        status, summary, _ = self.request("GET", f"/api/jobs/{result['id']}")
        artifact = summary["artifacts"][0]
        self.assertEqual(artifact["downloadName"], "lamp-Header- broken.jpg")
        self.assertEqual(artifact["bytes"], len(payload))
        status, downloaded, headers = self.request("GET", artifact["url"] + "?download=1")
        self.assertEqual((status, downloaded), (200, payload))
        self.assertEqual(headers["Content-Disposition"], 'attachment; filename="lamp-Header- broken.jpg"')
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        (directory / "still.jpg").write_bytes(b"changed")
        self.assertEqual(self.request("GET", artifact["url"] + "?download=1")[0], 400)

    def test_invalid_format_is_rejected_before_creating_any_job(self):
        scene = self.bootstrap()["project"]["scene"]
        for kind, export_format in (("still", "mp4"), ("reel", "jpeg"), ("still", "pdf"), ("still", {})):
            status, error, _ = self.request("POST", "/api/renders", {"scene": scene, "kind": kind, "format": export_format})
            self.assertEqual(status, 400)
            self.assertIn("export format", error["error"])
        self.assertEqual(self.request("GET", "/api/jobs")[1], [])

    def test_comparison_explicitly_restricts_unsupported_export(self):
        from tests.test_comparison_api import paired_scene
        scene = paired_scene(self.app.store)
        status, error, _ = self.request("POST", "/api/comparison-renders", {"scene": scene, "kind": "still", "format": "webp"})
        self.assertEqual(status, 400)
        self.assertIn("PNG stills or MP4 video", error["error"])
        self.assertEqual(self.request("GET", "/api/jobs")[1], [])


if __name__ == "__main__":
    unittest.main()
