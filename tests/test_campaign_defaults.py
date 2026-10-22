"""Starter resizing preserves source identity and canonical animation."""

import copy
from pathlib import Path
import tempfile
import unittest

from film.campaign_defaults import PLINTH_SIZE_M, STUDIO_SIZE_M, resize_campaign_defaults
from film.scene import evaluate, load_scene, sample_scene
from film.store import ProjectStore
from tests.test_keyframes import track
from tests.test_film_motions import motion


ROOT = Path(__file__).resolve().parents[1]


class CampaignDefaultsTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(ROOT / 'examples/bottle.scene.json')

    def test_same_studio_and_fitted_size_for_tiny_and_huge_source_models(self):
        for source_factor in (.01, 1, 1000):
            scene = copy.deepcopy(self.scene)
            scene['product']['dimensionsM'] = [value * source_factor for value in scene['product']['dimensionsM']]
            for part in scene['product']['components']:
                part['sizeM'] = [value * source_factor for value in part['sizeM']]
                part['assembly']['translationM'] = [value * source_factor for value in part['assembly']['translationM']]
                part['bevelM'] *= source_factor
            before = copy.deepcopy(scene)
            resized = resize_campaign_defaults(scene)
            self.assertEqual(scene, before)
            self.assertEqual(resized['product'], before['product'])
            self.assertEqual(resized['environment']['studioSizeM'], STUDIO_SIZE_M)
            self.assertEqual(resized['environment']['plinth']['sizeM'], list(PLINTH_SIZE_M))
            self.assertAlmostEqual(max(resized['product']['dimensionsM']) * resized['placement']['scale'], STUDIO_SIZE_M)

    def test_camera_support_and_motion_resize_but_part_local_values_do_not(self):
        source = self.scene
        source['animation'] = {'tracks': [track('scale', [(1, 1), (360, 2)], target='$product'),
                                           track('position.x', [(1, .01), (360, .02)], target='$product', enabled=False)]}
        source['shots'][0]['motions'] = [{**motion('dolly', '$camera'), 'amount': .01}]
        resized = resize_campaign_defaults(source)
        ratio = STUDIO_SIZE_M / max(source['product']['dimensionsM'])
        self.assertEqual(resized['actions'], source['actions'])
        self.assertEqual(resized['product'], source['product'])
        self.assertEqual(resized['animation']['tracks'][0]['keys'][1]['value'], 2 * ratio)
        self.assertEqual(resized['animation']['tracks'][1]['keys'][1]['value'], .02 * ratio)
        self.assertEqual(resized['shots'][0]['motions'][0]['amount'], .01 * ratio)
        for frame in (1, 60, 166, 240, 360):
            before = evaluate(source, frame)
            after = evaluate(resized, frame)
            for identifier, part in after['components'].items():
                for actual, original in zip(part['translationM'], before['components'][identifier]['translationM']):
                    self.assertAlmostEqual(actual, original * ratio)
                self.assertAlmostEqual(part['scale'], before['components'][identifier]['scale'] * ratio)
            for field in ('positionM', 'targetM'):
                for actual, original in zip(after['camera'][field], before['camera'][field]):
                    self.assertAlmostEqual(actual, original * ratio)
        # Export and the preview evaluate the same authored state.
        self.assertEqual(sample_scene(resized)['frames'][165], evaluate(resized, 166))

    def test_resizing_repairs_legacy_manual_scale_without_keeping_huge_camera(self):
        source = self.scene
        source['placement']['scale'] = .02
        resized = resize_campaign_defaults(source)
        ratio = STUDIO_SIZE_M / max(source['product']['dimensionsM'])
        self.assertAlmostEqual(resized['placement']['scale'], ratio)
        self.assertEqual(resized['shots'][0]['camera']['from']['positionM'],
                         [value * ratio for value in source['shots'][0]['camera']['from']['positionM']])

    def test_saved_revision_can_be_restored_and_resize_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = ProjectStore(temporary)
            original = store.create('Existing default', self.scene)
            resized = resize_campaign_defaults(original['scene'])
            saved = store.save(original['id'], resized, original['revisionId'])
            self.assertNotEqual(saved['revisionId'], original['revisionId'])
            self.assertEqual(store.get(original['id'], original['revisionId'])['scene'], self.scene)
            self.assertEqual(resize_campaign_defaults(resized), resized)
            resized['placement']['scale'] *= .75
            self.assertEqual(resize_campaign_defaults(resized), resized)

    def test_new_default_uses_shared_stage_while_duplicate_keeps_manual_size(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = ProjectStore(temporary)
            created = store.create()
            self.assertEqual(created['scene']['environment']['studioSizeM'], STUDIO_SIZE_M)
            created['scene']['placement']['scale'] *= .6
            duplicate = store.create('Duplicate', created['scene'])
            self.assertEqual(duplicate['scene'], created['scene'])


if __name__ == '__main__':
    unittest.main()
