"""Material generation uses mock provider traffic; tests never submit paid jobs."""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import zlib

from film.material_assets import MAP_TYPES, validate_png, validate_image_asset
from film.materials import MaterialLibrary, PatinaClient, MaterialProviderError, _api_url, _download_url
from film.scene import load_scene, scene_digest, validate_scene
from film.store import ProjectStore
from film.worlds import bundle_assets
from tests import test_editor_api

ROOT=Path(__file__).resolve().parents[1]


def png(color=(128,128,255), width=2, height=2):
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    raw=b''.join(b'\0'+bytes(color)*width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')


def asset_for(payload):
    digest=hashlib.sha256(payload).hexdigest()
    return {'path':f'assets/{digest}.png','sha256':digest,'format':'png'}


class FakeProvider:
    def __init__(self):
        self.submitted=[];self.cancelled=[];self.downloads=[]
        self.fail_download=False
    def submit(self,prompt):
        self.submitted.append(prompt)
        return {'requestId':'request-1','urls':{'status':'https://queue.fal.run/fal-ai/patina/requests/request-1/status',
                'result':'https://queue.fal.run/fal-ai/patina/requests/request-1','cancel':'https://queue.fal.run/fal-ai/patina/requests/request-1/cancel'}}
    def status(self,submission):
        return {'status':'COMPLETED'}
    def result(self,submission):
        return {'images':[{'url':'https://v3.fal.media/preview.png'}]+[{'map_type':kind,'url':f'https://v3.fal.media/{kind}.png'} for kind in MAP_TYPES], 'seed':42,'prompt':'ignored'}
    def download(self,url):
        self.downloads.append(url)
        if self.fail_download:
            return b'not a png'
        return png()
    def cancel(self,submission):
        self.cancelled.append(submission['requestId'])
        return {'status':'CANCELLATION_REQUESTED'}


class MaterialAssetTests(unittest.TestCase):
    def test_bounded_png_and_exact_asset_path(self):
        payload=png()
        self.assertEqual(validate_png(payload)['width'],2)
        self.assertEqual(validate_image_asset(asset_for(payload)),asset_for(payload))
        bad=bytearray(payload);bad[-1]^=1
        for invalid in (b'not png',bytes(bad),payload[:-3],payload+b'\0'):
            with self.subTest(size=len(invalid)),self.assertRaises(ValueError):
                validate_png(invalid)
        for path in ('../escape.png','https://fal.media/file.png','assets/'+ '0'*64+'.png'):
            with self.assertRaises(ValueError):
                validate_image_asset({**asset_for(payload),'path':path})

    def test_scene_save_and_render_bundle_keep_maps_and_detect_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=ProjectStore(root/'source');payload=png();asset=asset_for(payload)
            (store.root/asset['path']).write_bytes(payload)
            scene=load_scene(ROOT/'examples/bottle.scene.json')
            material=scene['product']['components'][0]['material']
            material.update(textures={'normal':asset},textureRepeat=[2,3],normalScale=.75,heightScaleM=0)
            project=store.create('Material test',scene)
            self.assertEqual(store.get(project['id'])['scene'],scene)
            records=bundle_assets(scene,store.root,root/'bundle')
            self.assertEqual(records[0]['format'],'png')
            self.assertEqual((root/'bundle'/asset['path']).read_bytes(),payload)
            (store.root/asset['path']).write_bytes(png((1,2,3)))
            with self.assertRaisesRegex(ValueError,'hash'):
                store.get(project['id'])

    def test_texture_scalar_and_map_validation(self):
        scene=load_scene(ROOT/'examples/bottle.scene.json')
        for change in ({'textures':{'invalid':asset_for(png())}},{'textureRepeat':[0,1]}, {'normalScale':float('nan')}, {'heightScaleM':.02}):
            bad=copy.deepcopy(scene);bad['product']['components'][0]['material'].update(change)
            with self.subTest(change=change),self.assertRaises(ValueError):
                validate_scene(bad)


class MaterialPresetTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(ROOT/'examples/bottle.scene.json')
        self.component = self.scene['product']['components'][0]
        self.preset = {'id':'bottle-finish', 'name':'Bottle finish', 'type':'plastic',
                       'material':copy.deepcopy(self.component['material'])}
        self.scene['product']['materialPresets'] = [self.preset]
        self.component['materialPresetId'] = self.preset['id']

    def test_old_scene_validation_keeps_its_document_and_digest(self):
        old = load_scene(ROOT/'examples/bottle.scene.json')
        original = copy.deepcopy(old)
        digest = scene_digest(old)
        self.assertIs(validate_scene(old), old)
        self.assertEqual(old, original)
        self.assertEqual(scene_digest(old), digest)
        self.assertNotIn('materialPresets', old['product'])
        self.assertTrue(all('materialPresetId' not in component for component in old['product']['components']))

    def test_shared_and_unassigned_presets_are_valid_without_mutation(self):
        second = self.scene['product']['components'][1]
        second['materialPresetId'] = self.preset['id']
        second['material'] = copy.deepcopy(self.preset['material'])
        self.scene['product']['materialPresets'].append({**copy.deepcopy(self.preset), 'id':'unused'})
        original = copy.deepcopy(self.scene)
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(self.scene, original)
        # Updating a preset and every bound snapshot yields a new canonical revision.
        digest = scene_digest(self.scene)
        self.preset['material']['roughness'] = .6
        for component in (self.component, second):
            component['material'] = copy.deepcopy(self.preset['material'])
        validate_scene(self.scene)
        self.assertNotEqual(scene_digest(self.scene), digest)
        self.assertEqual(original['product']['materialPresets'][0]['material']['roughness'], .26)

    def test_missing_preset_reference_is_rejected_without_changing_snapshot(self):
        for reference in ('missing', '', None, 42, []):
            with self.subTest(reference=reference):
                scene = copy.deepcopy(self.scene)
                scene['product']['components'][0]['materialPresetId'] = reference
                original = copy.deepcopy(scene)
                with self.assertRaisesRegex(ValueError, 'preset does not exist'):
                    validate_scene(scene)
                self.assertEqual(scene, original)
        self.scene['product'].pop('materialPresets')
        with self.assertRaisesRegex(ValueError, 'preset does not exist'):
            validate_scene(self.scene)

    def test_divergent_component_material_is_rejected(self):
        for change in ({'roughness':.9}, {'textureRepeat':[2,2]}, {'textures':{'normal':asset_for(png())}}):
            with self.subTest(change=change):
                scene = copy.deepcopy(self.scene)
                scene['product']['components'][0]['material'].update(change)
                original = copy.deepcopy(scene)
                with self.assertRaisesRegex(ValueError, 'must match its referenced preset'):
                    validate_scene(scene)
                self.assertEqual(scene, original)

    def test_preset_ids_names_types_and_collection_are_validated(self):
        invalid = [('id',value) for value in ('', ' ', 'x'*121, None, 1, [])]
        invalid += [('name',value) for value in ('', ' ', ' padded', 'padded ', 'x'*141, None, 1)]
        invalid += [('type',value) for value in ('wood', '', None, 1, [])]
        for key,value in invalid:
            with self.subTest(key=key,value=value):
                scene = copy.deepcopy(self.scene)
                scene['product']['materialPresets'][0][key] = value
                with self.assertRaises(ValueError):
                    validate_scene(scene)
        self.scene['product']['materialPresets'].append(copy.deepcopy(self.preset))
        with self.assertRaisesRegex(ValueError, 'unique'):
            validate_scene(self.scene)
        for value in (None, {}, 'presets', [None]):
            with self.subTest(value=value):
                scene = copy.deepcopy(self.scene)
                scene['product']['materialPresets'] = value
                with self.assertRaises(ValueError):
                    validate_scene(scene)

    def test_supported_preset_types_and_maximum_lengths(self):
        self.preset['id'] = 'p'*120
        self.preset['name'] = 'n'*140
        self.component['materialPresetId'] = self.preset['id']
        for material_type in ('glass','plastic','metal','ceramic','rubber','paper','custom'):
            with self.subTest(material_type=material_type):
                self.preset['type'] = material_type
                validate_scene(self.scene)

    def test_unused_preset_material_cannot_bypass_material_validation(self):
        self.component.pop('materialPresetId')
        for change in ({'roughness':2}, {'baseColor':[1,1,1]}, {'textures':{'unknown':asset_for(png())}}):
            with self.subTest(change=change):
                scene = copy.deepcopy(self.scene)
                scene['product']['materialPresets'][0]['material'].update(change)
                with self.assertRaises(ValueError):
                    validate_scene(scene)

    def test_mesh_binding_requires_explicit_material_override(self):
        self.component.update(shape='mesh', bevelM=0,
            asset={'sha256':'a'*64, 'path':'assets/'+'a'*64+'.glb', 'format':'glb', 'sourceUp':'Y'})
        for override in (None, False):
            if override is None:
                self.component.pop('materialOverride', None)
            else:
                self.component['materialOverride'] = override
            with self.subTest(override=override), self.assertRaisesRegex(ValueError, 'requires materialOverride'):
                validate_scene(self.scene)
        self.component['materialOverride'] = True
        validate_scene(self.scene)
        self.component.pop('materialPresetId')
        self.component['materialOverride'] = False
        validate_scene(self.scene)

    def test_unused_preset_maps_survive_save_revisions_and_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ProjectStore(root/'source')
            payload = png((180,120,40))
            asset = asset_for(payload)
            (store.root/asset['path']).write_bytes(payload)
            self.component.pop('materialPresetId')
            self.preset['material']['textures'] = {'basecolor':asset, 'roughness':asset}
            project = store.create('Preset campaign', self.scene)
            original = copy.deepcopy(self.scene)
            self.preset['name'] = 'Renamed finish'
            saved = store.save(project['id'], self.scene, project['revisionId'])
            self.assertEqual(store.get(project['id'])['scene'], self.scene)
            self.assertEqual(store.get(project['id'], project['revisionId'])['scene'], original)
            records = bundle_assets(saved['scene'], store.root, root/'bundle')
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]['path'], asset['path'])
            self.assertEqual((root/'bundle'/asset['path']).read_bytes(), payload)
            # An unused preset still pins its bytes; corrupting them invalidates reads.
            (store.root/asset['path']).write_bytes(png((1,2,3)))
            with self.assertRaisesRegex(ValueError, 'hash'):
                store.get(project['id'])

    def test_missing_unused_preset_map_fails_before_project_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProjectStore(Path(directory)/'source')
            self.component.pop('materialPresetId')
            self.preset['material']['textures'] = {'normal':asset_for(png())}
            with self.assertRaises(ValueError):
                store.create('Missing preset map', self.scene)
            self.assertEqual(store.list(), [])


class MaterialQueueTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.provider=FakeProvider()
        self.library=MaterialLibrary(self.root,client_factory=lambda:self.provider,start_worker=False,poll_interval=0)

    def test_generate_import_and_restart_are_durable_without_resubmission(self):
        job=self.library.create({'prompt':'Brushed brass'})
        self.assertEqual(job['state'],'queued')
        self.library._run(job['id'])
        done=self.library.get(job['id'])
        self.assertEqual(done['state'],'succeeded',done)
        self.assertEqual(set(done['material']['material']['textures']),set(MAP_TYPES))
        self.assertEqual(len(self.provider.downloads),5)
        reopened=MaterialLibrary(self.root,client_factory=lambda:self.provider,start_worker=False)
        self.assertEqual(reopened.list()['materials'][0]['id'],job['id'])
        self.assertEqual(self.provider.submitted,['Brushed brass'])
        self.assertEqual(reopened.get(job['id']),done)

    def test_resume_known_request_never_posts_again_and_uncertain_post_fails(self):
        job=self.library.create({'prompt':'Sand'})
        self.library._update(job['id'],state='running',phase='generating',submission=self.provider.submit('Sand'))
        reopened=MaterialLibrary(self.root,client_factory=lambda:self.provider,start_worker=False,poll_interval=0)
        reopened._run(job['id'])
        self.assertEqual(self.provider.submitted,['Sand'])
        unknown=self.library.create({'prompt':'Clay'})
        self.library._update(unknown['id'],state='running',phase='submitting')
        again=MaterialLibrary(self.root,client_factory=lambda:self.provider,start_worker=False)
        self.assertEqual(again.get(unknown['id'])['state'],'failed')
        self.assertIn('Check fal',again.get(unknown['id'])['error'])
        self.assertEqual(self.provider.submitted,['Sand'])

    def test_cancel_before_submission_and_during_remote_generation(self):
        job=self.library.create({'prompt':'Steel'})
        self.assertEqual(self.library.cancel(job['id'])['state'],'cancelled')
        self.library._run(job['id']);self.assertEqual(self.provider.submitted,[])
        another=self.library.create({'prompt':'Steel'})
        self.library._update(another['id'],state='running',submission=self.provider.submit('Steel'))
        self.library.cancel(another['id'])
        self.assertEqual(self.provider.cancelled,['request-1'])
        self.library._run(another['id']);self.assertEqual(self.library.list()['materials'],[])

    def test_invalid_provider_output_does_not_enter_library(self):
        self.provider.fail_download=True
        job=self.library.create({'prompt':'Paper'})
        self.library._run(job['id'])
        self.assertEqual(self.library.get(job['id'])['state'],'failed')
        self.assertEqual(self.library.list()['materials'],[])
        self.assertFalse((self.root/'assets').exists())

    def test_missing_key_has_no_job_or_network_request(self):
        with patch.dict('os.environ',{'FAL_KEY':''}):
            library=MaterialLibrary(self.root/'missing',start_worker=False)
            self.assertFalse(library.list()['configured'])
            with self.assertRaisesRegex(MaterialProviderError,'Set FAL_KEY'):
                library.create({'prompt':'Copper'})
            self.assertEqual(library.list()['jobs'],[])


class PatinaTransportTests(unittest.TestCase):
    def test_credentials_only_reach_exact_queue_host_and_response_errors_are_safe(self):
        for url in ('https://queue.fal.run.attacker.invalid/fal-ai/patina/material','https://queue.fal.run@attacker.invalid/fal-ai/patina/material','http://queue.fal.run/fal-ai/patina/material'):
            with self.assertRaises(MaterialProviderError):
                _api_url(url)
        for url in ('https://127.0.0.1/a.png','https://fal.media.attacker.invalid/a.png','https://fal.media@localhost/a.png'):
            with self.assertRaises(MaterialProviderError):
                _download_url(url)
        class Opener:
            def __init__(self):self.requests=[]
            def open(self,request,timeout):
                self.requests.append(request)
                raise urllib.error.HTTPError(request.full_url,401,'secret-key-provider-body',{},io.BytesIO(b'secret-key'))
        opener=Opener();client=PatinaClient('secret-key',opener=opener)
        with self.assertRaises(MaterialProviderError) as error:
            client.submit('Test')
        self.assertNotIn('secret-key',str(error.exception))
        self.assertEqual(opener.requests[0].get_header('Authorization'),'Key secret-key')
        request=json.loads(opener.requests[0].data)
        self.assertEqual(request['maps'],list(MAP_TYPES))
        self.assertFalse(request['enable_prompt_expansion'])
        self.assertEqual(request['upscale_factor'],'0')


class MaterialApiTests(unittest.TestCase):
    setUp=test_editor_api.EditorApiTests.setUp
    stop_server=test_editor_api.EditorApiTests.stop_server
    request=test_editor_api.EditorApiTests.request
    def test_missing_key_state_and_post_error_are_actionable_without_creating_job(self):
        with patch.dict('os.environ',{'FAL_KEY':''}):
            status,data,_=self.request('GET','/api/materials')
            self.assertEqual(status,200);self.assertFalse(data['configured'])
            status,error,_=self.request('POST','/api/materials/generate',{'prompt':'Copper'})
            self.assertEqual(status,400);self.assertIn('FAL_KEY',error['error'])
            self.assertEqual(self.request('GET','/api/materials')[1]['jobs'],[])
