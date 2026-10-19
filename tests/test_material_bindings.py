"""Section materials are canonical preset references, validated against source bytes."""
import copy
from pathlib import Path
import tempfile
import unittest

from film import products, worlds
from film.scene import validate_scene
from film.store import ProjectStore
from tests.test_products import product_glb
from tests.test_worlds import PROVENANCE
from tests.test_materials import png, asset_for


class MaterialBindingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        def hierarchy(document):
            document['nodes'] = [
                {'name':'repeated name', 'children':[1,2,3]},
                {'name':'repeated name', 'mesh':0},
                {'name':'repeated name', 'mesh':0},
                {'name':'empty section'},
            ]
            document['scenes'] = [{'nodes':[0]}]
        self.payload = product_glb(change=hierarchy)
        source = self.root/'source.glb'
        source.write_bytes(self.payload)
        self.scene = products.create_product_scene(source, self.root, name='Sections', provenance=PROVENANCE)
        self.component = self.scene['product']['components'][0]
        self.preset = {'id':'finish', 'name':'Finish', 'type':'metal',
                       'material':{'baseColor':[.1,.2,.3,1], 'roughness':.4, 'metallic':.8}}
        self.scene['product']['materialPresets'] = [self.preset]
        self.component['materialBindings'] = [{'nodeIndex':1, 'materialPresetId':'finish'}]

    def test_binding_without_whole_component_override_preserves_native_source_and_schema(self):
        before = copy.deepcopy(self.scene)
        self.assertIs(validate_scene(self.scene), self.scene)
        worlds.verify_scene_assets(self.scene, self.root)
        self.assertEqual(self.scene, before)
        self.assertFalse(self.component['materialOverride'])
        self.assertNotIn('materialPresetId', self.component)
        self.assertEqual((self.root/self.component['asset']['path']).read_bytes(), self.payload)
        self.component['materialBindings'] = [{'nodeIndex':0, 'materialPresetId':'finish'}]
        worlds.verify_scene_assets(self.scene, self.root)

    def test_rejects_invalid_binding_schema_atomically(self):
        invalid = [None, {}, 'nodes', [None],
                   [{'nodeIndex':True,'materialPresetId':'finish'}],
                   [{'nodeIndex':-1,'materialPresetId':'finish'}],
                   [{'nodeIndex':100000,'materialPresetId':'finish'}],
                   [{'nodeIndex':'1','materialPresetId':'finish'}],
                   [{'nodeIndex':1,'materialPresetId':'missing'}],
                   [{'nodeIndex':1,'materialPresetId':[]}],
                   [{'nodeIndex':1,'materialPresetId':'finish','material':self.preset['material']}],
                   [{'nodeIndex':1,'materialPresetId':'finish'}]*2]
        for bindings in invalid:
            scene = copy.deepcopy(self.scene)
            scene['product']['components'][0]['materialBindings'] = bindings
            before = copy.deepcopy(scene)
            with self.subTest(bindings=bindings), self.assertRaises(ValueError):
                validate_scene(scene)
            self.assertEqual(scene, before)
        primitive = copy.deepcopy(self.scene)
        component = primitive['product']['components'][0]
        component['shape']='box'
        del component['asset'], component['materialOverride']
        with self.assertRaisesRegex(ValueError, 'imported mesh'):
            validate_scene(primitive)

    def test_source_validation_rejects_missing_or_empty_nodes(self):
        for index in (3, 4, 99999):
            self.component['materialBindings'][0]['nodeIndex'] = index
            validate_scene(self.scene)
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, 'existing source node'):
                worlds.verify_scene_assets(self.scene, self.root)
        self.component['materialBindings'][0]['nodeIndex']=1
        path=self.root/self.component['asset']['path']
        path.write_bytes(self.payload[:-1]+b'x')
        with self.assertRaisesRegex(ValueError, 'hash'):
            worlds.verify_scene_assets(self.scene, self.root)

    def test_bindings_and_preset_maps_persist_and_bundle_without_material_snapshot(self):
        image = png((50,80,120))
        asset = asset_for(image)
        (self.root/asset['path']).write_bytes(image)
        self.preset['material']['textures']={'basecolor':asset}
        store=ProjectStore(self.root/'store')
        saved=store.create('Sections', self.scene, source_dir=self.root)
        self.assertEqual(store.get(saved['id'])['scene'], self.scene)
        records=worlds.bundle_assets(self.scene, self.root, self.root/'bundle')
        self.assertEqual({record['path'] for record in records}, {asset['path'], self.component['asset']['path']})
        self.assertEqual((self.root/'bundle'/asset['path']).read_bytes(), image)
        changed=copy.deepcopy(self.scene)
        changed['product']['materialPresets'][0]['material']['roughness']=.9
        revised=store.save(saved['id'], changed, saved['revisionId'])
        self.assertEqual(store.get(saved['id'], saved['revisionId'])['scene'], self.scene)
        self.assertEqual(revised['scene'], changed)
        bad=copy.deepcopy(changed)
        bad['product']['components'][0]['materialBindings'][0]['nodeIndex']=999
        with self.assertRaisesRegex(ValueError, 'existing source node'):
            store.save(saved['id'], bad, revised['revisionId'])
        self.assertEqual(store.get(saved['id'])['revisionId'], revised['revisionId'])
