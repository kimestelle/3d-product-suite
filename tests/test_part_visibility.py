"""Removal changes rendered membership, never source geometry or saved motion."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from film.part_visibility import removed_part_ids
from film.scene import evaluate, load_scene, scene_digest, validate_scene
from film.store import ProjectStore
from tests.test_part_motion import fixture, motion

ROOT = Path(__file__).resolve().parents[1]


class PartVisibilityTests(unittest.TestCase):
    def test_missing_or_empty_removal_keeps_legacy_samples_and_restores_exactly(self):
        scene = fixture()
        scene['shots'][0]['motions'] = [motion('product::node:1')]
        before = [evaluate(scene, frame) for frame in (1, 13, 25)]
        original = copy.deepcopy(scene)
        scene['product']['removedPartIds'] = ['product::node:1']
        validate_scene(scene)
        for frame, base in zip((1, 13, 25), before):
            removed = evaluate(scene, frame)
            self.assertEqual(removed.pop('removedPartIds'), ['product::node:1', 'product::node:2'])
            self.assertEqual(removed, base)
        scene['product'].pop('removedPartIds')
        self.assertEqual(scene, original)
        self.assertEqual([evaluate(scene, frame) for frame in (1, 13, 25)], before)
        scene['product']['removedPartIds'] = []
        validate_scene(scene)
        self.assertEqual([evaluate(scene, frame) for frame in (1, 13, 25)], before)

    def test_native_children_follow_removed_parent_even_with_editorial_reparenting(self):
        scene = fixture()
        scene['editorHierarchy'] = {'version': 1, 'overrides': {
            'product::node:2': {'parentId': None, 'status': 'edited'}}}
        scene['product']['removedPartIds'] = ['product::node:1']
        validate_scene(scene)
        self.assertEqual(removed_part_ids(scene), ['product::node:1', 'product::node:2'])
        self.assertNotIn('product::node:0', removed_part_ids(scene))

    def test_component_removal_suppresses_whole_source_with_stable_order(self):
        scene = fixture()
        scene['product']['removedPartIds'] = ['product::node:2', 'product']
        validate_scene(scene)
        self.assertEqual(removed_part_ids(scene), ['product', 'product::node:0', 'product::node:1', 'product::node:2'])
        scene['product']['removedPartIds'].reverse()
        self.assertEqual(removed_part_ids(scene), ['product', 'product::node:0', 'product::node:1', 'product::node:2'])

    def test_non_drawable_transform_nodes_do_not_break_inheritance(self):
        scene = fixture()
        middle = scene['product']['components'][0]['sourceNodes'][1]
        middle['drawable'] = False
        middle['hasMesh'] = False
        scene['product']['removedPartIds'] = ['product::node:0']
        validate_scene(scene)
        self.assertEqual(removed_part_ids(scene), ['product::node:0', 'product::node:2'])
        scene['product']['removedPartIds'] = ['product::node:1']
        with self.assertRaisesRegex(ValueError, 'target does not exist'):
            validate_scene(scene)

    def test_deep_catalog_expansion_does_not_use_python_recursion(self):
        scene = fixture()
        component = scene['product']['components'][0]
        template = component['sourceNodes'][0]
        component['sourceNodes'] = [{**template, 'nodeIndex': index,
            'parentIndex': index - 1 if index else None} for index in range(1500)]
        # Exercise expansion independently of the scene validator's depth cap.
        # Reverse catalog order also prevents relying on parent-first input.
        component['sourceNodes'].reverse()
        scene['product']['removedPartIds'] = ['product::node:1']
        self.assertEqual(removed_part_ids(scene),
                         [f'product::node:{index}' for index in range(1499, 0, -1)])

    def test_bad_removal_records_are_rejected(self):
        for value in (None, 'product', {}, ['product'] * 100001, ['product', 'product'],
                      ['product::node:99'], ['product::node:01'], [1], [{}]):
            scene = fixture()
            scene['product']['removedPartIds'] = value
            with self.subTest(value=str(value)[:100]), self.assertRaisesRegex(ValueError, 'Removed part'):
                validate_scene(scene)

    def test_removal_is_saved_as_revision_and_changes_export_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            scene = load_scene(ROOT / 'examples/bottle.scene.json')
            original = copy.deepcopy(scene)
            before_digest = scene_digest(scene)
            store = ProjectStore(Path(directory))
            first = store.create('Remove label', scene)
            scene['product']['removedPartIds'] = [scene['product']['label']['componentId']]
            changed = store.save(first['id'], scene, first['revisionId'])
            reopened = store.get(changed['id'])['scene']
            self.assertNotEqual(scene_digest(reopened), before_digest)
            self.assertEqual(reopened['product']['removedPartIds'], scene['product']['removedPartIds'])
            self.assertEqual(reopened['product']['components'], original['product']['components'])
            self.assertEqual(reopened['product']['label'], original['product']['label'])
            self.assertEqual(reopened['actions'], original['actions'])
            old = json.loads((Path(directory) / 'projects' / first['id'] / 'revisions' / (first['revisionId'] + '.json')).read_text())
            self.assertEqual(old['scene'], original)

    def test_all_parts_can_be_removed_without_invalidating_motion_and_camera(self):
        scene = load_scene(ROOT / 'examples/bottle.scene.json')
        scene['product']['removedPartIds'] = [component['id'] for component in scene['product']['components']]
        validate_scene(scene)
        for frame in (1, 120, 240):
            sample = evaluate(scene, frame)
            self.assertEqual(set(sample['removedPartIds']), set(sample['components']))
            self.assertIn('camera', sample)
