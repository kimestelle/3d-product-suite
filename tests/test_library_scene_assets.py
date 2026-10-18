"""Imported prop/HDRI records survive saves, sizing and render asset pinning."""
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film.scene import load_scene, validate_scene
from film.store import ProjectStore
from film.worlds import bundle_assets
from tests.test_product_mesh_blender import write_product_glb
from tests import test_editor_api
from tests.test_materials import png, asset_for

ROOT=Path(__file__).resolve().parents[1]


class LibrarySceneAssetTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        self.store=ProjectStore(self.root/'source')
        self.scene=load_scene(ROOT/'examples/bottle.scene.json')
        path=self.store.root/'assets/prop.glb';digest=write_product_glb(path);path.rename(path.with_name(digest+'.glb'))
        asset={'path':f'assets/{digest}.glb','sha256':digest,'format':'glb','sourceUp':'Y','sourceDimensionsM':[.06,.04,.02]}
        self.prop={'id':'library-prop','shape':'mesh','asset':asset,'sizeM':[.12,.08,.04],
                   'translationM':[.1,.2,.3],'rotationXyzw':[0,0,0,1],'materialOverride':False,'bevelM':0,
                   'material':{'baseColor':[1,1,1,1],'roughness':.5,'metallic':0}}
        self.scene['environment']['props']=[self.prop]
        payload=b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n'+bytes((128,96,64,129))*8
        digest=hashlib.sha256(payload).hexdigest()
        hdr={'path':f'assets/{digest}.hdr','sha256':digest,'format':'hdr'}
        (self.store.root/hdr['path']).write_bytes(payload)
        self.scene['lighting']={'ambientStrength':.45,'lights':[],
            'hdri':{'asset':hdr,'name':'Library light','sourceUrl':'https://polyhaven.com/a/test','intensity':1.5,'rotationDeg':45}}

    def test_resized_mesh_prop_and_hdri_roundtrip_and_bundle(self):
        validate_scene(self.scene)
        saved=self.store.create('Library scene',self.scene)
        self.assertEqual(self.store.get(saved['id'])['scene'],self.scene)
        records=bundle_assets(self.scene,self.store.root,self.root/'bundle')
        self.assertEqual({item['format'] for item in records},{'glb','hdr'})
        self.assertTrue(all((self.root/'bundle'/item['path']).is_file() for item in records))
        # Changing current size leaves the source dimensions/hashes immutable.
        resized=copy.deepcopy(self.scene);resized['environment']['props'][0]['sizeM']=[.24,.16,.08]
        second=self.store.save(saved['id'],resized,saved['revisionId'])
        self.assertEqual(second['scene']['environment']['props'][0]['asset'],self.prop['asset'])

    def test_false_source_dimensions_and_bad_hdri_fail_before_save(self):
        bad=copy.deepcopy(self.scene);bad['environment']['props'][0]['asset']['sourceDimensionsM']=[1,1,1]
        with self.assertRaisesRegex(ValueError,'dimensions'):
            self.store.create('Bad dimensions',bad)
        bad=copy.deepcopy(self.scene);bad['lighting']['hdri']['intensity']=11
        with self.assertRaisesRegex(ValueError,'intensity'):
            validate_scene(bad)
        bad=copy.deepcopy(self.scene);bad['environment']['props'][0]['bevelM']=.001
        with self.assertRaisesRegex(ValueError,'beveled'):
            validate_scene(bad)
        path=self.store.root/self.scene['lighting']['hdri']['asset']['path'];path.write_bytes(b'broken')
        with self.assertRaisesRegex(ValueError,'hash'):
            self.store.create('Bad HDRI',self.scene)


class LibraryApiTests(unittest.TestCase):
    setUp=test_editor_api.EditorApiTests.setUp
    stop_server=test_editor_api.EditorApiTests.stop_server
    request=test_editor_api.EditorApiTests.request
    def test_catalog_and_import_routes_use_kind_and_id(self):
        result={'assets':[],'total':0,'offset':12,'hasMore':False}
        with patch.object(self.app.polyhaven,'list_assets',return_value=result) as catalog:
            status,response,_=self.request('GET','/api/polyhaven/assets?kind=models&q=stone&offset=12&limit=6')
            self.assertEqual((status,response),(200,result))
            catalog.assert_called_once_with('models',query='stone',offset=12,limit=6)
        result={'kind':'textures','entry':{'id':'demo'}}
        with patch.object(self.app.polyhaven,'import_asset',return_value=result) as import_:
            status,response,_=self.request('POST','/api/polyhaven/import',{'kind':'textures','id':'wood'})
            self.assertEqual((status,response),(201,result))
            import_.assert_called_once_with('textures','wood')

    def test_immutable_png_endpoint_serves_only_verified_bytes(self):
        payload=png();asset=asset_for(payload);(self.app.store.root/asset['path']).write_bytes(payload)
        route='/api/assets/'+Path(asset['path']).name
        status,response,headers=self.request('GET',route)
        self.assertEqual((status,response),(200,payload))
        self.assertEqual(headers['Content-Type'],'image/png')
        (self.app.store.root/asset['path']).write_bytes(b'bad')
        self.assertEqual(self.request('GET',route)[0],400)
