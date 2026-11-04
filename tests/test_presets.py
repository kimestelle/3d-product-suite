"""Scoped setup presets keep unselected values and saved campaigns intact."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from film.presets import PresetLibrary
from film.scene import load_scene
from tests import test_editor_api

ROOT = Path(__file__).resolve().parents[1]


class PresetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.library = PresetLibrary(self.root)
        self.scene = load_scene(ROOT / 'examples/bottle.scene.json')

    def test_light_and_finish_save_only_selected_sections_and_restore_absence(self):
        source = copy.deepcopy(self.scene)
        source['postProcessing'] = {'enabled': True, 'exposureEV': .5}
        saved = self.library.create('Image finish', ['lighting', 'finish'], source)
        record = self.library.get(saved['id'])
        self.assertEqual(set(record['values']), {'lighting', 'finish'})
        target = copy.deepcopy(self.scene)
        target['postProcessing'] = {'enabled': True, 'exposureEV': -1}
        target['environment']['worldColor'] = [.1, .2, .3]
        before = copy.deepcopy(target)
        result = self.library.apply(saved['id'], ['finish'], target)['scene']
        self.assertEqual(result['postProcessing'], source['postProcessing'])
        self.assertEqual(result['product'], target['product'])
        self.assertEqual(result['environment'], target['environment'])
        self.assertEqual(target, before)
        neutral = self.library.create('No finishing', ['finish'], self.scene)
        self.assertNotIn('postProcessing', self.library.apply(neutral['id'], ['finish'], result)['scene'])

    def test_entire_setup_roundtrip_preserves_destination_identity_and_render_quality(self):
        scopes = ['product', 'materials', 'stage', 'lighting', 'film', 'finish']
        saved = self.library.create('Entire setup', scopes, self.scene)
        target = copy.deepcopy(self.scene)
        target['sceneId'] = 'another-campaign-scene'
        target['environment']['worldColor'] = [.8, .4, .2]
        target['product']['components'][0]['material']['roughness'] = .9
        target['render']['samples'] = 32
        result = self.library.apply(saved['id'], scopes, target)['scene']
        self.assertEqual(result['sceneId'], target['sceneId'])
        self.assertEqual(result['render']['samples'], 32)
        for key in ('product', 'placement', 'environment', 'evidence', 'shots', 'actions'):
            self.assertEqual(result[key], self.scene[key])

    def test_material_compatibility_and_invalid_combinations_do_not_mutate_destination(self):
        saved = self.library.create('Materials', ['materials'], self.scene)
        other = copy.deepcopy(self.scene)
        other['product']['components'][0]['sizeM'][0] *= 2
        before = copy.deepcopy(other)
        self.assertFalse(self.library.list(other)[0]['sameProduct'])
        with self.assertRaisesRegex(ValueError, 'different product'):
            self.library.apply(saved['id'], ['materials'], other)
        self.assertEqual(other, before)
        for scopes in ([], ['product'], ['lighting', 'lighting'], ['unknown'], [{}]):
            with self.subTest(scopes=scopes), self.assertRaises(ValueError):
                self.library.create('Invalid', scopes, self.scene)
        with self.assertRaisesRegex(ValueError, 'does not contain'):
            self.library.apply(saved['id'], ['film'], self.scene)

    def test_presets_are_deduplicated_and_tamper_checked(self):
        saved = self.library.create('One', ['finish'], self.scene)
        self.assertEqual(self.library.create('One', ['finish'], self.scene), saved)
        self.assertEqual(len(self.library.list()), 1)
        path = self.library.directory / (saved['id'] + '.json')
        modified = json.loads(path.read_text()); modified['values']['finish'] = {'enabled': True}
        path.write_text(json.dumps(modified))
        with self.assertRaisesRegex(ValueError, 'modified'):
            self.library.get(saved['id'])


class PresetApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_save_list_load_and_apply_keep_campaign_revision_unchanged(self):
        project = self.bootstrap()['project']
        status, saved, _ = self.request('POST', '/api/presets', {
            'name': 'Saved finish', 'scopes': ['finish'], 'scene': project['scene']})
        self.assertEqual(status, 201)
        status, listed, _ = self.request('POST', '/api/presets/query', {'scene': project['scene']})
        self.assertEqual(status, 200); self.assertEqual(listed, [saved])
        status, applied, _ = self.request('POST', f'/api/presets/{saved["id"]}/apply', {
            'scene': project['scene'], 'scopes': ['finish']})
        self.assertEqual(status, 200); self.assertEqual(applied['scene'], project['scene'])
        self.assertEqual(self.app.store.get(project['id'])['revisionId'], project['revisionId'])
        self.assertEqual(self.request('POST', '/api/presets', {'name': 'Missing scopes', 'scene': project['scene']})[0], 400)
        self.assertEqual(self.request('POST', '/api/presets', {'scene': project['scene']}, mutate=False)[0], 403)
