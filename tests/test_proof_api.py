"""Real HTTP ownership, source and artifact boundary for current-view proofs."""
import copy
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image
from film import jobs, server
from film.scene import scene_digest
from film.hosting import HostedAccess


class NativeProofApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        with patch.object(server.RenderQueue, '_worker', return_value=None):
            self.app = server.Application(self.root/'data', port=0)
            self.app.renders.thread.join(2)
        self.app._render_capabilities = {'blenderAvailable':True, 'ffmpegAvailable':False}
        handler = server.make_handler(self.app)
        handler.log_message = lambda *args:None
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.app.port = self.http.server_port
        self.app.renders.base_url = f'http://127.0.0.1:{self.app.port}'
        self.thread = threading.Thread(target=lambda:self.http.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.scene = copy.deepcopy(self.app.store.bootstrap()['scene'])

    def stop(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join(2)
        if self.app._proofs is not None:self.app.proofs.close()

    def request(self, method, path, body=None, mutate=True):
        headers = {'X-Product-Suite':'1'} if mutate else {}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode(); headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', self.app.port, timeout=5)
        try:
            connection.request(method, path, payload, headers)
            response = connection.getresponse(); result = response.read()
            if response.getheader('Content-Type','').startswith('application/json'):result=json.loads(result)
            return response.status,result,dict(response.getheaders())
        finally:connection.close()

    def submit(self, **changes):
        body = {'scene':self.scene, 'sessionId':'qa-session-1', 'sequence':1,
                'frame':1, 'width':36, 'height':64, 'samples':8, **changes}
        with patch.object(server.NativeProofService, '_worker', return_value=None):
            return self.request('POST','/api/proofs',body)

    def test_bootstrap_is_lazy_and_proof_does_not_save_or_mutate_campaign(self):
        before = self.app.store.list()
        status, bootstrap, _ = self.request('GET','/api/bootstrap')
        self.assertEqual(status,200); self.assertTrue(bootstrap['capabilities']['nativeProofAvailable'])
        self.assertIsNone(self.app._proofs)
        original = copy.deepcopy(self.scene)
        status, proof, headers = self.submit()
        self.assertEqual(status,202,proof); self.assertEqual(proof['sourceDigest'],scene_digest(original))
        self.assertEqual(proof['state'],'queued'); self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(self.app.store.list(),before); self.assertEqual(self.scene,original)
        self.assertEqual(self.app.proofs.base_url(),self.app.renders.base_url)
        self.assertEqual(self.request('GET',f"/api/proofs/{proof['id']}")[1],proof)

    def test_cancel_watermark_rejects_late_aborted_post_and_cancels_current(self):
        status, _, _ = self.request('POST','/api/proofs/session/cancel',{'sessionId':'qa-session-1','sequence':2})
        self.assertEqual(status,200)
        self.assertEqual(self.submit(sequence=1)[0],409)
        self.assertEqual(self.submit(sequence=2)[0],409)
        status, proof, _ = self.submit(sequence=3)
        self.assertEqual(status,202)
        self.assertEqual(self.request('POST',f"/api/proofs/{proof['id']}/cancel",{})[1]['state'],'cancelled')

    def test_newer_view_supersedes_queued_proof(self):
        _, first, _ = self.submit()
        _, second, _ = self.submit(sequence=2,frame=2)
        self.assertEqual(self.request('GET',f"/api/proofs/{first['id']}")[1]['state'],'superseded')
        self.assertEqual(second['frame'],2)
        self.assertEqual(self.request('POST','/api/proofs/session/cancel',{'sessionId':'qa-session-1','sequence':1})[1]['cancelled'],False)
        self.assertEqual(self.request('GET',f"/api/proofs/{second['id']}")[1]['state'],'queued')

    def test_mutation_origin_authentication_and_artifact_routes_share_guards(self):
        self.assertEqual(self.request('POST','/api/proofs',{},mutate=False)[0],403)
        self.app.access = HostedAccess(public_url='https://gesso-studio-gold.vercel.app',
            backend_url='https://gesso-api.example.test',access_key='test-proof-key-at-least-32-characters')
        for method,path,body in [('POST','/api/proofs',{}),('GET','/api/proofs/'+'a'*32,None),
            ('GET','/api/proofs/'+'a'*32+'/image.png',None),
            ('POST','/api/proofs/session/cancel',{})]:
            self.assertEqual(self.request(method,path,body)[0],401)
        self.assertIsNone(self.app._proofs)

    def test_only_valid_unchanged_completed_native_image_is_served(self):
        _, proof, _ = self.submit()
        path = f"/api/proofs/{proof['id']}/image.png"
        self.assertEqual(self.request('GET',path)[0],400)
        record = self.app.proofs.records[proof['id']]
        image = self.app.proofs.directory/proof['id']/'image.png'
        Image.new('RGB',(36,64),(130,120,110)).save(image)
        record.update(state='succeeded',imageUrl=path,imageSha256=jobs._sha256(image))
        self.app.proofs._save(record)
        status, data, headers = self.request('GET',path)
        self.assertEqual(status,200); self.assertEqual(data,image.read_bytes())
        self.assertEqual(headers['Content-Type'],'image/png'); self.assertEqual(headers['Cache-Control'],'no-store')
        Image.new('RGB',(36,64),(150,120,110)).save(image)
        self.assertEqual(self.request('GET',path)[0],400)
        self.assertEqual(self.request('GET',path.replace('image.png','scene.json'))[0],404)

    def test_explicit_camera_is_isolated_and_cannot_choose_files_or_saved_state(self):
        camera={'positionM':[.6,.3,1.0], 'targetM':[0,.1,0], 'focalLengthMm':60}
        status, proof, _ = self.submit(cameraOverride=camera,width=64,height=36)
        self.assertEqual(status,202,proof)
        self.assertEqual(proof['cameraOverride'],camera)
        self.assertEqual(proof['sourceDigest'],scene_digest(self.scene))
        self.assertEqual(self.submit(sequence=2,cameraOverride={**camera,'path':'/private/file'})[0],400)
        self.assertEqual(self.submit(sequence=2,width=35)[0],400)
