"""Frozen render jobs carry the geometry code used by decals and PBR surfaces."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from film import jobs

ROOT = Path(__file__).resolve().parents[1]


class RendererBundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source.json"
        self.source.write_bytes((ROOT / "examples/bottle.scene.json").read_bytes())
        self.output = self.root / "job"

    def test_frozen_renderer_loads_geometry_without_repository_or_pythonpath(self):
        manifest = jobs.create_job(self.source, self.output)
        helper = self.output / "decal_geometry.py"
        self.assertEqual(manifest["rendererDependencies"],
                         {name: jobs._sha256(self.output / name) for name in jobs._RENDERER_DEPENDENCIES})
        # Import the actual frozen renderer with only Blender's import surface
        # stubbed. -I and a temporary cwd remove repository/PYTHONPATH access.
        code = '''
import pathlib, runpy, sys, types
sys.modules["bpy"] = types.ModuleType("bpy")
mathutils = types.ModuleType("mathutils")
mathutils.Matrix = mathutils.Vector = object
mathutils.Quaternion = lambda *args: None
sys.modules["mathutils"] = mathutils
renderer = runpy.run_path(sys.argv[1])
geometry = renderer["decal_geometry"]()
assert pathlib.Path(geometry.__file__).resolve().parent == pathlib.Path(sys.argv[1]).resolve().parent
assert "film" not in sys.modules
triangles = list(geometry.primitive_triangles({"shape":"box","sizeM":[.06,.1,.04]}))
assert len(triangles) == 12
assert renderer["decal_geometry"]() is geometry
'''
        result = subprocess.run([sys.executable, "-I", "-c", code, str(self.output / "renderer.py")],
                                cwd=self.root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_changed_helper_implementation_is_rejected_before_process_launch(self):
        helper = self.root / "decal_geometry.py"
        helper.write_bytes(jobs._RENDERER_DEPENDENCIES["decal_geometry.py"].read_bytes())
        with patch.object(jobs, "_RENDERER_DEPENDENCIES", {"decal_geometry.py": helper}):
            jobs.create_job(self.source, self.output)
            helper.write_bytes(helper.read_bytes() + b"\n# implementation change\n")
            with patch.object(jobs.subprocess, "run") as process:
                with self.assertRaisesRegex(ValueError, "dependency implementation changed"):
                    jobs.run_job(self.output)
                process.assert_not_called()

    def test_changed_or_missing_snapshot_is_rejected_before_process_launch(self):
        jobs.create_job(self.source, self.output)
        helper = self.output / "decal_geometry.py"
        original = helper.read_bytes()
        for content in (original + b"\n# snapshot edit\n", None):
            with self.subTest(missing=content is None):
                if content is None:
                    helper.unlink()
                else:
                    helper.write_bytes(content)
                with patch.object(jobs.subprocess, "run") as process:
                    with self.assertRaisesRegex(ValueError, "dependency snapshot was modified or is missing"):
                        jobs.run_job(self.output)
                    process.assert_not_called()

    def test_removed_dependency_manifest_cannot_bypass_verification(self):
        manifest = jobs.create_job(self.source, self.output)
        manifest.pop("rendererDependencies")
        (self.output / "job.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "dependency implementation changed"):
            jobs.run_job(self.output)
