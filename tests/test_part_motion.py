"""Source identities, physical parent inheritance and deterministic node samples."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest

from film.part_motion import IDENTITY, multiply, point
from film.products import product_source_nodes, validate_product_source_nodes, hydrate_product_nodes
from film.scene import evaluate, validate_scene
from tests.test_products import product_glb

ROOT = Path(__file__).resolve().parents[1]


def fixture():
    scene = json.loads((ROOT / 'examples/bottle.scene.json').read_text())
    scene['actions'] = []
    component = copy.deepcopy(scene['product']['components'][0])
    component.update(id='product', shape='mesh', asset={'format':'glb','path':'assets/'+'a'*64+'.glb','sha256':'a'*64,'sourceUp':'Y'}, bevelM=0)
    component['assembly']={'translationM':[0,0,0],'rotationXyzw':[0,0,0,1]}
    component['sourceNodes'] = [
        {'nodeIndex':0,'parentIndex':None,'name':'Body','localMatrix':IDENTITY.copy(),'boundsM':[[-1,-1,-1],[1,1,1]],'drawable':True,'hasMesh':True},
        {'nodeIndex':1,'parentIndex':0,'name':'Cap','localMatrix':[ *IDENTITY[:12],0,2,0,1 ],'boundsM':[[-.5,-.5,-.5],[.5,.5,.5]],'drawable':True,'hasMesh':True},
        {'nodeIndex':2,'parentIndex':1,'name':'Print','localMatrix':IDENTITY.copy(),'boundsM':[[0,0,0],[.2,.1,.1]],'drawable':True,'hasMesh':True},
    ]
    scene['product']['components']=[component]
    scene['product'].pop('label',None)
    return scene


def motion(target, kind='move', amount=.2, axis='y'):
    return {'id':'part-motion','target':target,'kind':kind,'amount':amount,'axis':axis,'startFrame':1,'durationFrames':25,'easing':'linear','enabled':True}


class PartMotionTests(unittest.TestCase):
    def test_child_motion_leaves_parent_fixed_and_carries_descendant(self):
        scene=fixture(); scene['shots'][0]['motions']=[motion('product::node:1')]
        validate_scene(scene)
        first,last=evaluate(scene,1),evaluate(scene,25)
        self.assertEqual(first['parts']['product::node:0'],last['parts']['product::node:0'])
        for identifier in ('product::node:1','product::node:2'):
            self.assertAlmostEqual(last['parts'][identifier]['centerM'][1]-first['parts'][identifier]['centerM'][1],.2)
        self.assertEqual(evaluate(scene,25),last)
        self.assertEqual(evaluate(scene,1),first)

    def test_rotation_uses_measured_parent_space_centre(self):
        scene=fixture(); scene['shots'][0]['motions']=[motion('product::node:1','rotate',90,'z')]
        validate_scene(scene)
        before,after=evaluate(scene,1)['parts'],evaluate(scene,25)['parts']
        self.assertEqual(before['product::node:1']['centerM'],after['product::node:1']['centerM'])
        self.assertAlmostEqual(after['product::node:2']['centerM'][0],-.05)
        self.assertAlmostEqual(after['product::node:2']['centerM'][1],2.1)
        self.assertEqual(after['product::node:1']['localMatrix'],multiply(after['product::node:1']['deltaMatrix'],scene['product']['components'][0]['sourceNodes'][1]['localMatrix']))

    def test_custom_pivot_and_nonuniform_source_matrix_survive(self):
        scene=fixture(); c=scene['product']['components'][0]
        c['sourceNodes'][1]['localMatrix'][0]=2
        c['partTransforms']={'1':{'translationM':[.1,0,0],'rotationXyzw':[0,0,0,1],'scale':1,'pivotM':[0,0,0]}}
        scene['shots'][0]['motions']=[motion('product::node:1','rotate',90,'z')]
        validate_scene(scene)
        part=evaluate(scene,25)['parts']['product::node:1']
        self.assertAlmostEqual(part['centerM'][0],-1.9)
        self.assertAlmostEqual(math.hypot(*part['localMatrix'][:3]),2)

    def test_uniform_scale_and_parent_motion_combine_without_changing_source(self):
        scene=fixture(); c=scene['product']['components'][0]; original=copy.deepcopy(c['sourceNodes'])
        scene['shots'][0]['motions']=[motion('product::node:0','move',.5,'x'),{**motion('product::node:1','scale',2),'id':'scale'}]
        validate_scene(scene)
        part=evaluate(scene,25)['parts']['product::node:1']
        self.assertEqual(part['centerM'],[.5,2,0])
        self.assertAlmostEqual(part['localMatrix'][0],2)
        self.assertEqual(c['sourceNodes'],original)

    def test_source_part_and_spot_motion_share_one_deterministic_sample(self):
        from tests.test_film_motions import spot_rig
        scene = fixture()
        scene['lighting'] = spot_rig()
        scene['shots'][0]['motions'] = [motion('product::node:1'),
            {**motion('$light:spot', 'orbit', 90), 'id': 'light-sweep'}]
        validate_scene(scene)
        first, last = evaluate(scene, 1), evaluate(scene, 25)
        self.assertEqual(last['parts']['product::node:0'], first['parts']['product::node:0'])
        self.assertAlmostEqual(last['parts']['product::node:1']['centerM'][1], 2.2)
        self.assertAlmostEqual(last['lights'][0]['positionM'][0], 0)
        self.assertAlmostEqual(last['lights'][0]['positionM'][2], -1)
        self.assertEqual(evaluate(scene, 25), last)
        self.assertEqual(evaluate(scene, 1), first)

    def test_custom_transform_keys_target_imported_part(self):
        scene=fixture();scene['animation']={'tracks':[{'id':'k','componentId':'product::node:1','property':'position.z','enabled':True,'keys':[{'frame':1,'value':0,'interpolation':'linear'},{'frame':25,'value':.3,'interpolation':'linear'}]}]}
        validate_scene(scene)
        self.assertAlmostEqual(evaluate(scene,13)['parts']['product::node:1']['centerM'][2],.15)

    def test_editorial_parent_is_not_physical_parent(self):
        scene=fixture(); scene['editorHierarchy']={'version':1,'overrides':{'product::node:1':{'parentId':None,'status':'edited'}}}
        scene['shots'][0]['motions']=[motion('product::node:0')]
        validate_scene(scene)
        self.assertAlmostEqual(evaluate(scene,25)['parts']['product::node:1']['centerM'][1],2.2)

    def test_unknown_or_malformed_targets_are_rejected(self):
        for target in ('product::node:99','product::node:01'):
            scene=fixture();scene['shots'][0]['motions']=[motion(target)]
            with self.assertRaisesRegex(ValueError,'target does not exist'):validate_scene(scene)
        scene=fixture();scene['product']['components'][0]['sourceNodes'][0]['parentIndex']=1
        with self.assertRaisesRegex(ValueError,'hierarchy'):validate_scene(scene)

    def test_old_campaign_hydrates_without_rewriting_saved_revision(self):
        from film.products import create_product_scene
        from film.store import ProjectStore
        from tests.test_worlds import PROVENANCE
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.glb'
            source.write_bytes(product_glb())
            scene = create_product_scene(source, root, name='Legacy bottle', provenance=PROVENANCE)
            scene['product']['components'][0].pop('sourceNodes')
            store = ProjectStore(root)
            project = store.create('Legacy bottle', scene)
            revision = root / 'projects' / project['id'] / 'revisions' / (project['revisionId'] + '.json')
            original = revision.read_bytes()
            opened = store.get(project['id'])
            self.assertTrue(opened['scene']['product']['components'][0]['sourceNodes'])
            self.assertNotIn('sourceNodes', json.loads(original)['scene']['product']['components'][0])
            self.assertEqual(revision.read_bytes(), original)
            opened['scene']['shots'][0]['motions'] = [motion('product::node:0')]
            saved = store.save(project['id'], opened['scene'], opened['revisionId'])
            reopened = store.get(saved['id'])
            self.assertEqual(evaluate(reopened['scene'], 25), evaluate(opened['scene'], 25))
            self.assertEqual(revision.read_bytes(), original)

    def test_catalog_comes_from_bytes_and_forged_matrix_is_rejected(self):
        payload=product_glb();nodes=product_source_nodes(payload)
        self.assertTrue(nodes[0]['hasMesh']);self.assertTrue(nodes[0]['drawable'])
        self.assertEqual(nodes[0]['parentIndex'],None)
        validate_product_source_nodes({'sourceNodes':nodes},payload)
        nodes[0]['localMatrix'][12]=.1
        with self.assertRaisesRegex(ValueError,'immutable'):validate_product_source_nodes({'sourceNodes':nodes},payload)


if __name__ == '__main__':unittest.main()
