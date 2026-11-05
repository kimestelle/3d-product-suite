"""Raw render equivalence, cache admission and real job integration boundaries."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from film import jobs, stills
from film.render_reuse import RawMasterCache
from tests.test_jobs import png_bytes, versions

ROOT = Path(__file__).resolve().parents[1]


def execution(backend="CPU"):
    return {"policy": "AUTO", "backend": backend,
        "devices": [] if backend == "CPU" else [{"id": "device", "name": "Test GPU", "type": backend}],
        "system": {"platform": "linux", "release": "test", "version": "test", "architecture": "x86_64"},
        "denoiser": {"enabled": False, "algorithm": None, "backend": None}}


def config(job, backend="CPU"):
    profile = job["renderProfile"]
    return {**{key: profile[key] for key in ("width", "height", "samples", "seed", "fps", "engine", "blenderVersion")},
        "adapterVersion": 3, "execution": execution(backend), "denoising": False,
        "viewTransform": "AgX", "look": "AgX - Medium High Contrast", "cameraGate": {"fit": "VERTICAL", "heightMm": 36}}


class RawRenderReuseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.blender = self.root / "test-blender"
        self.blender.write_text("fixture native renderer identity")
        self.blender.chmod(0o700)
        self.scene = json.loads((ROOT / "examples/bottle.scene.json").read_text())
        self.scene["render"].update(width=4, height=6, samples=1)
        self.scene["actions"] = []
        for index, shot in enumerate(self.scene["shots"]):
            shot.update(startFrame=index + 1, endFrame=index + 1)
        self.commands = []

    def job(self, name, scene=None, export_format="png-sequence", still=False):
        scene = copy.deepcopy(self.scene if scene is None else scene)
        source = self.root / (name + ".json")
        source.write_text(json.dumps(scene))
        output = self.root / name
        job = (stills.create_still_job(source, output, frame=1, width=4, height=6, samples=1, export_format=export_format)
               if still else jobs.create_job(source, output, export_format=export_format))
        job["tools"]["blender"] = {"command": str(self.blender)}
        jobs._save_job(output, job)
        return output, job, scene

    def prepare_raw(self, name="first", scene=None, backend="CPU"):
        output, job, scene = self.job(name, scene)
        (output / "frames").mkdir()
        (output / "frames/000001.png").write_bytes(png_bytes())
        (output / "render-config.json").write_text(json.dumps(config(job, backend)))
        cache = self.cache(output, job, scene)
        cache.store([1])
        return output, job, scene, cache

    def cache(self, output, job, scene):
        return RawMasterCache(output, job, scene, str(self.blender), inspect_png=jobs._inspect_png)

    def native(self, command, output, log_name, **kwargs):
        self.commands.append(command)
        if "--python" not in command:
            Path(command[-1]).write_bytes(b"RIFF" + b"\x10\0\0\0" + b"WEBPfixture pixels")
            return
        manifest = jobs._read_job(output)
        (output / "scene.blend").write_bytes(b"BLENDER-v403fixture")
        (output / "render-config.json").write_text(json.dumps(config(manifest)))
        if "--frames" in command:
            (output / "frames").mkdir(exist_ok=True)
            for frame in map(int, command[command.index("--frames") + 1].split(",")):
                (output / "frames" / f"{frame:06d}.png").write_bytes(png_bytes())

    def run_job(self, output, still=False):
        with patch.object(jobs, "_run_process", side_effect=self.native), patch.object(jobs.subprocess, "run", side_effect=versions):
            return (stills.run_still_job(output, blender=str(self.blender)) if still
                    else jobs.run_job(output, blender=str(self.blender)))

    def test_grade_changes_reuse_raw_pixels_and_finish_them_once_for_new_job(self):
        from PIL import Image
        first = copy.deepcopy(self.scene)
        first["postProcessing"] = {"enabled": True, "exposureEV": 1}
        output, job, _, cache = self.prepare_raw(scene=first)
        # The previous deliverable can change without mutating the raw master.
        jobs._post_process_scene_frames(output, job, [1])
        with Image.open(output / "frames/000001.png") as image:
            self.assertEqual(image.getpixel((0, 0)), (140, 140, 140))
        next_scene = copy.deepcopy(first)
        next_scene["postProcessing"]["exposureEV"] = -1
        other, manifest, scene = self.job("second", next_scene)
        (other / "render-config.json").write_text(json.dumps(config(manifest)))
        other_cache = self.cache(other, manifest, scene)
        self.assertTrue(other_cache.has_candidates([1]))
        self.assertEqual(other_cache.restore([1]), [1])
        jobs._post_process_scene_frames(other, manifest, [1])
        with Image.open(other / "frames/000001.png") as image:
            self.assertEqual(image.getpixel((0, 0)), (35, 35, 35))
        masters = list(cache.root.glob("*/*/raw.png"))
        self.assertEqual(len(masters), 1)
        with Image.open(masters[0]) as image:
            self.assertEqual(image.getpixel((0, 0)), (70, 70, 70))
        self.assertFalse((other / "raw-frame-digests.json").exists())

    def test_actual_execution_must_match_even_when_both_requests_are_auto(self):
        _, _, _, first = self.prepare_raw()
        other, manifest, scene = self.job("gpu")
        (other / "render-config.json").write_text(json.dumps(config(manifest, "CUDA")))
        cache = self.cache(other, manifest, scene)
        self.assertTrue(cache.has_candidates([1]))
        self.assertEqual(cache.restore([1]), [])
        self.assertEqual(len(list(first.root.glob("*/*/raw.png"))), 1)

    def test_request_without_actual_runtime_cannot_restore(self):
        self.prepare_raw()
        other, manifest, scene = self.job("unproved")
        cache = self.cache(other, manifest, scene)
        self.assertTrue(cache.has_candidates([1]))
        self.assertEqual(cache.restore([1]), [])
        self.assertFalse((other / "frames/000001.png").exists())

    def test_material_light_camera_seed_and_samples_invalidate_affected_frame(self):
        self.prepare_raw()
        mutations = [
            lambda scene: scene["product"]["components"][0]["material"].update(roughness=.99),
            lambda scene: scene["environment"].update(worldColor=[.3, .3, .3]),
            lambda scene: scene["shots"][0]["camera"]["from"].update(focalLengthMm=60),
            lambda scene: scene["render"].update(seed=123),
            lambda scene: scene["render"].update(samples=2),
            lambda scene: scene["placement"].update(scale=.8),
        ]
        for index, edit in enumerate(mutations):
            scene = copy.deepcopy(self.scene)
            edit(scene)
            other, job, scene = self.job("physical" + str(index), scene)
            self.assertFalse(self.cache(other, job, scene).has_candidates([1]), index)

    def test_editorial_change_reuses_unaffected_frame_but_not_changed_camera(self):
        self.prepare_raw()
        scene = copy.deepcopy(self.scene)
        scene["shots"][2]["camera"]["from"]["positionM"][0] += .2
        other, job, scene = self.job("editorial", scene)
        (other / "render-config.json").write_text(json.dumps(config(job)))
        cache = self.cache(other, job, scene)
        self.assertTrue(cache.has_candidates([1]))
        self.assertEqual(cache.restore([1]), [1])
        self.assertFalse(cache.has_candidates([3]))

    def test_corrupt_valid_png_is_rejected_and_original_entry_is_not_overwritten(self):
        _, _, _, cache = self.prepare_raw()
        master = next(cache.root.glob("*/*/raw.png"))
        master.write_bytes(png_bytes(value=99))
        other, job, scene = self.job("corrupt")
        (other / "render-config.json").write_text(json.dumps(config(job)))
        other_cache = self.cache(other, job, scene)
        self.assertEqual(other_cache.restore([1]), [])
        (other / "frames").mkdir(exist_ok=True)
        (other / "frames/000001.png").write_bytes(png_bytes())
        other_cache.store([1])
        self.assertEqual(master.read_bytes(), png_bytes(value=99))

    def test_different_renderer_binary_or_dependency_prevents_reuse(self):
        self.prepare_raw()
        self.blender.write_text("different native build, same advertised version")
        other, job, scene = self.job("build")
        self.assertFalse(self.cache(other, job, scene).has_candidates([1]))
        # The implementation and every pinned helper participate independently.
        job["rendererDependencies"]["render_devices.py"] = "0" * 64
        self.assertFalse(self.cache(other, job, scene).has_candidates([1]))

    def test_low_space_or_zero_budget_never_deletes_prior_masters(self):
        _, _, _, cache = self.prepare_raw()
        master = next(cache.root.glob("*/*/raw.png"))
        before = master.read_bytes()
        other, job, scene = self.job("lowspace")
        (other / "render-config.json").write_text(json.dumps(config(job)))
        (other / "frames").mkdir()
        (other / "frames/000002.png").write_bytes(png_bytes())
        with patch("film.render_reuse.shutil.disk_usage") as usage:
            usage.return_value.free = 1
            other_cache = self.cache(other, job, scene)
            other_cache.store([2])
            self.assertEqual(job["renderReuse"]["admissionSkipped"], 1)
        with patch.dict("os.environ", {"GESSO_RAW_RENDER_CACHE_MAX_MIB": "0"}):
            self.assertFalse(self.cache(other, job, scene).enabled)
        self.assertEqual(master.read_bytes(), before)

    def test_symlink_cache_root_and_frame_entries_are_not_traversed(self):
        output, job, scene = self.job("source")
        (output / "render-config.json").write_text(json.dumps(config(job)))
        private = self.root / "private"
        private.mkdir()
        cache = self.cache(output, job, scene)
        cache.root.symlink_to(private, target_is_directory=True)
        self.assertFalse(cache.has_candidates([1]))
        self.assertEqual(cache.restore([1]), [])
        self.assertEqual(list(private.iterdir()), [])

    def test_abandoned_staging_and_unknown_cache_contents_count_against_budget(self):
        _, _, _, cache = self.prepare_raw()
        stage = cache.root / ".stage-interrupted"
        stage.mkdir()
        (stage / "raw.png").write_bytes(b"pending")
        self.assertGreaterEqual(cache._usage()[0], len(b"pending"))
        unknown = next(cache.root.glob("*/*/receipt.json")).parent / "unknown"
        unknown.mkdir()
        self.assertEqual(cache._usage(), (cache.limit, 4096))
        other, job, scene = self.job("unknown-storage")
        (other / "render-config.json").write_text(json.dumps(config(job)))
        (other / "frames").mkdir()
        (other / "frames/000002.png").write_bytes(png_bytes())
        self.cache(other, job, scene).store([2])
        self.assertEqual(job["renderReuse"]["admissionSkipped"], 1)
        self.assertTrue(unknown.is_dir())
        self.assertEqual((stage / "raw.png").read_bytes(), b"pending")

    def test_reel_regrade_builds_new_native_scene_but_skips_unchanged_frame_render(self):
        first, _, _ = self.job("original")
        self.run_job(first)
        self.commands.clear()
        scene = copy.deepcopy(self.scene)
        scene["postProcessing"] = {"enabled": True, "exposureEV": 1}
        other, _, _ = self.job("regrade", scene)
        finished = self.run_job(other)
        self.assertEqual(finished["state"], "succeeded")
        self.assertEqual(finished["renderReuse"]["restoredFrames"], 3)
        self.assertEqual(len(self.commands), 1)
        self.assertNotIn("--frames", self.commands[0])
        self.assertTrue(jobs._blend_valid(other / "scene.blend"))
        self.assertNotEqual(jobs._sha256(first / "frames/000001.png"), jobs._sha256(other / "frames/000001.png"))

    def test_still_format_revision_uses_same_master_without_new_frame_render(self):
        first, _, _ = self.job("still-a", export_format="png", still=True)
        self.run_job(first, still=True)
        self.commands.clear()
        other, _, _ = self.job("still-b", export_format="webp", still=True)
        finished = self.run_job(other, still=True)
        self.assertEqual(finished["renderReuse"]["restoredFrames"], 1)
        native = [command for command in self.commands if "--python" in command]
        self.assertEqual(len(native), 1)
        self.assertNotIn("--frames", native[0])
        self.assertEqual((first / "frames/000001.png").read_bytes(), (other / "frames/000001.png").read_bytes())
        self.assertTrue((other / "still.webp").is_file())

    def test_clean_native_yield_finishes_only_complete_prefix_then_continues(self):
        from PIL import Image
        scene = copy.deepcopy(self.scene)
        scene["postProcessing"] = {"enabled": True, "exposureEV": 1}
        output, _, _ = self.job("yielding", scene)
        yielded = False
        def partial(command, output, log_name, **kwargs):
            nonlocal yielded
            requested = [int(value) for value in command[command.index("--frames") + 1].split(",")]
            if not yielded and len(requested) > 1:
                yielded = True
                prefix = [requested[0]]
                shortened = list(command)
                shortened[shortened.index("--frames") + 1] = str(prefix[0])
                self.native(shortened, output, log_name, **kwargs)
                return {"yieldedFrames": prefix}
            return self.native(command, output, log_name, **kwargs)
        with patch.object(jobs, "_run_process", side_effect=partial), patch.object(jobs.subprocess, "run", side_effect=versions):
            finished = jobs.run_job(output, blender=str(self.blender))
        self.assertEqual(finished["state"], "succeeded")
        self.assertEqual(finished["completedRanges"], [[1, 3]])
        rendered = [int(value) for command in self.commands if "--frames" in command
                    for value in command[command.index("--frames") + 1].split(",")]
        self.assertEqual(rendered, [1, 2, 3])
        self.assertEqual(finished["renderReuse"]["storedFrames"], 3)
        for number in rendered:
            with Image.open(output / "frames" / f"{number:06d}.png") as image:
                self.assertEqual(image.getpixel((0, 0)), (140, 140, 140))

    def test_yield_receipt_binds_current_child_source_requested_prefix_and_png(self):
        output, job, _, _ = self.prepare_raw()
        command = [str(self.blender), "--python", "renderer.py", "--frames", "1,2,3"]
        valid = {"schemaVersion": 1, "token": "current-child", "sourceDigest": job["sceneDigest"],
            "rendererDigest": job["rendererDigest"], "completed": [{"frame": 1, "sha256": jobs._sha256(output / "frames/000001.png")}]}
        receipt = output / "render-yield.json"
        for change in (
                {"token": "older-child"}, {"sourceDigest": "0" * 64},
                {"rendererDigest": "0" * 64}, {"completed": [{"frame": 2, "sha256": "0" * 64}]},
                {"completed": [{"frame": 1, "sha256": "0" * 64}]}, {"completed": []}):
            receipt.write_text(json.dumps({**valid, **change}))
            with self.assertRaisesRegex(RuntimeError, "yield receipt"):
                jobs._validated_render_yield(output, command, "current-child")
        receipt.write_text(json.dumps(valid))
        self.assertEqual(jobs._validated_render_yield(output, command, "current-child"), [1])
        self.assertFalse(receipt.exists())


if __name__ == "__main__":
    unittest.main()
