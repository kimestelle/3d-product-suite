"""Device requests remain immutable when a worker's environment changes."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film import jobs

ROOT = Path(__file__).resolve().parents[1]


class ExecutionPolicyTests(unittest.TestCase):
    def test_new_jobs_default_to_auto_without_enabling_denoising(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(jobs.execution_policy(), {'cycles': 'AUTO', 'capture': 'auto', 'denoising': False})

    def test_invalid_device_policy_fails_before_job_creation(self):
        with patch.dict(os.environ, {'GESSO_CYCLES_DEVICE': 'mystery'}):
            with self.assertRaisesRegex(ValueError, 'execution policy'):
                jobs.execution_policy()
        for policy in ({'cycles': 'AUTO', 'capture': 'auto'},
                       {'cycles': 'CPU', 'capture': 'auto', 'denoising': 1}):
            with self.assertRaises(ValueError):
                jobs.execution_policy(policy)

    def test_worker_environment_does_not_change_a_snapshot_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = json.loads((ROOT / 'examples/bottle.scene.json').read_text())
            source = root / 'source.json'
            source.write_text(json.dumps(scene))
            with patch.dict(os.environ, {'GESSO_CYCLES_DEVICE': 'METAL', 'GESSO_CAPTURE_DEVICE': 'hardware', 'GESSO_CYCLES_DENOISE': '0'}):
                job = jobs.create_job(source, root / 'job')
            with patch.dict(os.environ, {'GESSO_CYCLES_DEVICE': 'CPU', 'GESSO_CAPTURE_DEVICE': 'software', 'GESSO_CYCLES_DENOISE': '1'}):
                self.assertEqual(jobs._verify_snapshots(root / 'job', job), scene)
            self.assertEqual(job['renderProfile']['executionPolicy'], {'cycles': 'METAL', 'capture': 'hardware', 'denoising': False})
