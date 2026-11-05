"""Native proof ownership and source isolation; pixels use the real PNG validator."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from film import jobs
from film.proofs import NativeProofService, proof_profile, _camera, TERMINAL
from film.proof_inputs import warm_scene_key, non_optical_sample
from film.scene import load_scene, scene_digest
from film.store import ConflictError
from tests.test_jobs import png_bytes

ROOT = Path(__file__).resolve().parents[1]


class ProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scene = load_scene(ROOT/'examples/bottle.scene.json')
        self.scene['actions'] = []
        self.scene['shots'] = self.scene['shots'][:1]
        self.scene['shots'][0].update(startFrame=1, endFrame=3)
        self.scene['render'].update(width=4, height=6)
        self.service = NativeProofService(self.root, base_url='http://127.0.0.1:8787')
        self.addCleanup(self.service.close)

    def request(self, sequence=1, **kwargs):
        return {'scene':self.scene, 'frame':1, 'sessionId':'test_session', 'sequence':sequence, **kwargs}

    def wait(self, proof_id):
        deadline = time.monotonic()+2
        while time.monotonic() < deadline:
            result = self.service.summary(proof_id)
            if result['state'] in TERMINAL:
                return result
            time.sleep(.005)
        self.fail('Proof worker did not settle')

    def test_rejects_stale_request_and_cancel_watermark_survives_unknown_id(self):
        # No native process or worker thread is needed for cancelled HTTP submissions.
        self.service.cancel_session('test_session', 3)
        with self.assertRaises(ConflictError):
            self.service.submit(self.request(3))
        with patch.object(self.service, '_execute', side_effect=RuntimeError('fixture failure')):
            latest = self.service.submit(self.request(4))
            self.assertEqual(self.wait(latest['id'])['state'], 'failed')
        self.assertFalse(self.service.cancel_session('test_session', 2)['cancelled'])
        self.assertEqual(self.service.sessions['test_session']['sequence'], 4)

    def test_latest_request_cancels_running_work_without_erasing_last_good(self):
        entered, release = threading.Event(), threading.Event()
        def execute(record):
            if record['sequence'] == 2:
                entered.set(); release.wait(1); self.service._check(record)
            destination = self.root/'proofs'/record['id']/'image.png'
            destination.write_bytes(png_bytes())
            return {'imageUrl':f"/api/proofs/{record['id']}/image.png", 'imageSha256':jobs._sha256(destination)}
        with patch.object(self.service, '_execute', side_effect=execute):
            first = self.service.submit(self.request(1)); self.assertEqual(self.wait(first['id'])['state'], 'succeeded')
            second = self.service.submit(self.request(2)); self.assertTrue(entered.wait(1))
            third = self.service.submit(self.request(3))
            self.assertEqual(self.service.summary(second['id'])['state'], 'superseded')
            self.assertTrue(self.service.artifact(first['id']).is_file())
            self.assertEqual(self.service.sessions['test_session']['lastGood'], first['id'])
            release.set(); self.assertEqual(self.wait(third['id'])['state'], 'succeeded')
        self.assertEqual(self.service.sessions['test_session']['lastGood'], third['id'])
        self.assertFalse((self.root/'projects').exists(), 'Proofs never save or rewrite campaigns')
        self.assertEqual(self.service.summary(first['id'])['sourceDigest'], scene_digest(self.scene))

    def test_bundle_source_and_camera_override_are_separate(self):
        override = {'positionM':[0,.2,.6], 'targetM':[0,.07,0], 'focalLengthMm':55}
        with patch.object(self.service, '_worker'):
            result = self.service.submit(self.request(cameraOverride=override, width=6, height=4))
        record = self.service.records[result['id']]
        directory, sampled = self.service._bundle(record, self.scene)
        self.assertEqual(sampled['frames'][0]['camera'], override)
        self.assertEqual(json.loads((directory/'scene.json').read_text()), self.scene)
        self.assertEqual(result['sourceDigest'], scene_digest(self.scene))
        self.assertEqual(result['cameraScope'], 'explicit-view')
        self.assertEqual(result['width'], 6)

    def test_profile_and_camera_validation_do_not_start_work(self):
        for data in ({'width':5,'height':6}, {'width':4,'height':6,'samples':7}, {'width':1536,'height':1536}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.service.submit(self.request(**data))
        for value in ({'positionM':[0,0,0], 'targetM':[0,0,0], 'focalLengthMm':50},
                      {'positionM':[0,0,1], 'targetM':[0,0,0], 'focalLengthMm':float('nan')}):
            with self.assertRaises(ValueError): _camera(value)
        self.assertIsNone(self.service.thread)
        self.assertEqual(self.service.records, {})

    def test_corrupt_artifact_and_interrupted_restart_are_explicit(self):
        with patch.object(self.service, '_worker'):
            result = self.service.submit(self.request())
        restarted = NativeProofService(self.root, base_url='http://127.0.0.1:8787')
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.summary(result['id'])['state'], 'failed')
        with self.assertRaises(ValueError): restarted.artifact(result['id'])

    def test_abandoned_terminal_sessions_expire_beyond_request_lifetime(self):
        self.service.cancel_session('test_session', 1)
        self.service.sessions['test_session']['touched'] = time.monotonic()-601
        self.service._expire_sessions()
        self.assertNotIn('test_session', self.service.sessions)

    def test_cross_device_asset_copies_are_owned_and_require_budget_before_writing(self):
        source = self.root/'assets'/'fixture.glb'; source.parent.mkdir(); source.write_bytes(b'asset'*12000)
        with patch.object(self.service, '_worker'):
            result = self.service.submit(self.request())
        record = self.service.records[result['id']]
        self.service.cache_bytes = 40000
        with patch('film.proofs.verify_scene_assets', return_value=[{'path':'assets/fixture.glb'}]), patch('film.proofs.os.link', side_effect=OSError('cross-device')):
            with self.assertRaisesRegex(ValueError, 'proof storage'):
                self.service._bundle(record, self.scene)
            target = self.root/'proofs'/record['id']/'assets'/'fixture.glb'
            self.assertFalse(target.exists())
            self.service.cache_bytes = 1024*1024
            directory, _ = self.service._bundle(record, self.scene)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertGreaterEqual(self.service._used_bytes(directory), source.stat().st_size)

    def test_safe_warm_key_keeps_physical_changes_and_discards_camera_finish_lights(self):
        camera = copy.deepcopy(self.scene); camera['shots'][0]['camera']['from']['positionM'][0] += .01
        camera['postProcessing'] = {'enabled':True, 'exposureEV':1}
        camera['lighting'] = {'ambientStrength':.8}
        self.assertEqual(warm_scene_key(camera), warm_scene_key(self.scene))
        physical = copy.deepcopy(self.scene); physical['product']['components'][0]['material']['roughness'] += .1
        self.assertNotEqual(warm_scene_key(physical), warm_scene_key(self.scene))
        self.assertEqual(non_optical_sample({'camera':{},'lights':[], 'product':[1]}), {'product':[1]})
