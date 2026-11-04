import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from film.render_devices import configure_cycles_device, execution_policy, normalize_policy, previous_execution


class Preferences:
    def __init__(self, available):
        self.available = available
        self.devices = []

    def get_devices(self):
        if self.compute_device_type not in self.available:
            raise TypeError('backend not compiled')
        self.devices = [SimpleNamespace(id='cpu', name='CPU', type='CPU', use=True)] + [
            SimpleNamespace(id=key, name=name, type=self.compute_device_type, use=False)
            for key, name in self.available[self.compute_device_type]]


class RenderDevicesTests(unittest.TestCase):
    def scene(self):
        return SimpleNamespace(cycles=SimpleNamespace(device='CPU'))

    def test_auto_uses_detected_metal_without_cpu_hybrid(self):
        scene, preferences = self.scene(), Preferences({'METAL': [('apple', 'Apple M5')]})
        receipt = configure_cycles_device(scene, preferences, 'AUTO', platform='darwin')
        self.assertEqual(scene.cycles.device, 'GPU')
        self.assertEqual(receipt['backend'], 'METAL')
        self.assertEqual([(d.type, d.use) for d in preferences.devices], [('CPU', False), ('METAL', True)])

    def test_auto_uses_available_linux_backend_and_records_exact_devices(self):
        scene, preferences = self.scene(), Preferences({'CUDA': [('gpu-0', 'NVIDIA')]})
        receipt = configure_cycles_device(scene, preferences, 'AUTO', platform='linux')
        self.assertEqual(receipt['backend'], 'CUDA')
        self.assertEqual(receipt['devices'], [{'id': 'gpu-0', 'name': 'NVIDIA', 'type': 'CUDA'}])

    def test_unavailable_gpu_falls_back_before_first_frame_and_cpu_is_explicit(self):
        scene, preferences = self.scene(), Preferences({'METAL': []})
        receipt = configure_cycles_device(scene, preferences, 'AUTO', platform='darwin')
        self.assertEqual(scene.cycles.device, 'CPU')
        self.assertEqual(receipt['backend'], 'CPU')
        self.assertIn('no available device', receipt['fallbackReason'])
        explicit = configure_cycles_device(scene, preferences, 'CPU')
        self.assertEqual({key: explicit[key] for key in ('policy', 'backend', 'devices')}, {'policy': 'CPU', 'backend': 'CPU', 'devices': []})
        self.assertTrue(explicit['system']['version'])

    def test_missing_gpu_after_prior_frames_cannot_mix_cpu_frames(self):
        prior = {'policy': 'AUTO', 'backend': 'METAL', 'devices': [{'id': 'apple', 'name': 'Apple M5', 'type': 'METAL'}]}
        with self.assertRaisesRegex(ValueError, 'device changed'):
            configure_cycles_device(self.scene(), Preferences({}), 'AUTO', previous=prior, platform='darwin')
        with self.assertRaisesRegex(ValueError, 'device changed'):
            configure_cycles_device(self.scene(), Preferences({'METAL': [('other', 'Apple M6')]}), 'AUTO', previous=prior, platform='darwin')

    def test_repeated_batches_keep_exact_device_and_os_identity(self):
        preferences = Preferences({'METAL': [('apple', 'Apple M5')]})
        prior = configure_cycles_device(self.scene(), preferences, 'AUTO', platform='darwin')
        self.assertEqual(configure_cycles_device(self.scene(), preferences, 'AUTO', previous=prior, platform='darwin'), prior)
        prior['system']['version'] += ' changed'
        with self.assertRaisesRegex(ValueError, 'device changed'):
            configure_cycles_device(self.scene(), preferences, 'AUTO', previous=prior, platform='darwin')

    def test_lost_or_invalid_receipt_cannot_mix_new_backend_over_existing_scene_pixels(self):
        frames = [{'frame': 1}, {'frame': 2, 'clip': {'kind': 'image'}}]
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'frames').mkdir()
            # Flat image content can precede the first 3D batch.
            (root / 'frames/000002.png').write_bytes(b'flat image fixture')
            self.assertIsNone(previous_execution(root, frames))
            (root / 'frames/000001.png').write_bytes(b'existing scene fixture')
            for broken in (None, '{}', '{broken json', '{"execution":{"backend":"CPU"}}'):
                if broken is not None:
                    (root / 'render-config.json').write_text(broken)
                with self.assertRaisesRegex(ValueError, 'valid Cycles execution receipt'):
                    previous_execution(root, frames)
            valid = configure_cycles_device(self.scene(), Preferences({}), 'CPU')
            (root / 'render-config.json').write_text(json.dumps({'execution': valid}))
            self.assertEqual(previous_execution(root, frames), valid)

    def test_raw_receipt_also_requires_execution_even_if_png_is_temporarily_missing(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'raw-frame-digests.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'valid Cycles execution receipt'):
                previous_execution(root, [{'frame': 1}])

    def test_denoising_uses_explicit_cpu_oidn_and_is_part_of_resume_identity(self):
        preferences = Preferences({'METAL': [('apple', 'Apple M5')]})
        receipt = configure_cycles_device(self.scene(), preferences, 'AUTO', platform='darwin', denoising=True)
        self.assertEqual(receipt['denoiser'], {'enabled': True, 'algorithm': 'OPENIMAGEDENOISE', 'backend': 'CPU'})
        self.assertEqual(configure_cycles_device(self.scene(), preferences, 'AUTO', platform='darwin', denoising=True, previous=receipt), receipt)
        with self.assertRaisesRegex(ValueError, 'device changed'):
            configure_cycles_device(self.scene(), preferences, 'AUTO', platform='darwin', denoising=False, previous=receipt)
        cpu = configure_cycles_device(self.scene(), preferences, 'CPU', denoising=True)
        self.assertEqual(cpu['backend'], 'CPU')
        self.assertEqual(cpu['denoiser']['backend'], 'CPU')

    def test_job_pins_policy_and_legacy_jobs_keep_portable_profile(self):
        with TemporaryDirectory() as directory:
            env = {'GESSO_CYCLES_DEVICE': 'METAL', 'GESSO_CYCLES_DENOISE': '1'}
            self.assertEqual(execution_policy(directory, env), {'cycles': 'METAL', 'denoising': True})
            job = Path(directory) / 'job.json'
            job.write_text(json.dumps({'renderProfile': {}}))
            self.assertEqual(execution_policy(directory, env), {'cycles': 'CPU', 'denoising': False})
            job.write_text(json.dumps({'renderProfile': {'executionPolicy': {'cycles': 'AUTO', 'denoising': False}}}))
            self.assertEqual(execution_policy(directory, env), {'cycles': 'AUTO', 'denoising': False})
        with self.assertRaises(ValueError):
            normalize_policy('invented')
