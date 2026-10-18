"""Persisted world edits, and the canonical lighting handoff to Blender."""
import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from film.scene import evaluate, scene_digest, validate_scene

ROOT = Path(__file__).resolve().parents[1]

class LightingTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads((ROOT / 'examples/bottle.scene.json').read_text())
        self.rig = {'ambientStrength': .45, 'lights': [{'id': 'key', 'name': 'Key', 'enabled': True, 'positionM': [-.2, .3, .24], 'targetM': [0, .07, 0], 'powerW': 2.6, 'diameterM': .23, 'color': [1, .93, .82]}]}

    def test_missing_lighting_preserves_existing_document_and_digest(self):
        before = copy.deepcopy(self.scene)
        digest = scene_digest(before)
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(self.scene, before)
        self.assertEqual(scene_digest(self.scene), digest)

    def test_valid_lighting_and_plinth_material_roundtrip(self):
        self.scene['lighting'] = copy.deepcopy(self.rig)
        self.scene['environment']['plinth']['material'] = {'baseColor': [.1, .2, .3, 1], 'roughness': .8, 'metallic': .2}
        validate_scene(self.scene)
        self.assertEqual(validate_scene(json.loads(json.dumps(self.scene))), self.scene)

    def test_plinth_edits_keep_product_at_its_declared_contact_offset(self):
        plinth = self.scene['environment']['plinth']
        plinth['sizeM'] = [.3, .12, .4]
        plinth['translationM'] = [.4, .2, -.3]
        self.scene['placement']['translationM'] = [.01, .02, .03]
        validate_scene(self.scene)
        frame = evaluate(self.scene, 1)
        body = frame['components']['bottle-body']['translationM']
        expected = [.41, .2 + .12 / 2 + .02 + .052, -.27]
        for actual, value in zip(body, expected): self.assertAlmostEqual(actual, value)

    def test_invalid_lighting_is_rejected(self):
        changes = [lambda r: r.update(ambientStrength=-1), lambda r: r.update(lights=[]), lambda r: r['lights'].append(copy.deepcopy(r['lights'][0])),
                   lambda r: r['lights'][0].update(enabled='yes'), lambda r: r['lights'][0].update(powerW=-1), lambda r: r['lights'][0].update(diameterM=0),
                   lambda r: r['lights'][0].update(color=[2, 0, 0]), lambda r: r['lights'][0].update(targetM=r['lights'][0]['positionM']),
                   lambda r: r['lights'][0].update(positionM=[0, float('nan'), 0])]
        for change in changes:
            with self.subTest(change=change):
                scene = copy.deepcopy(self.scene); scene['lighting'] = copy.deepcopy(self.rig); change(scene['lighting'])
                with self.assertRaises(ValueError): validate_scene(scene)

    def test_invalid_plinth_material_is_rejected(self):
        self.scene['environment']['plinth']['material'] = {'baseColor': [2, 0, 0, 1], 'roughness': .5, 'metallic': 0}
        with self.assertRaises(ValueError): validate_scene(self.scene)

    def test_blender_receives_exact_values_and_y_up_conversion(self):
        # Execute the real environment builder with a small host adapter. Blender
        # need not be installed to verify the scene-to-export contract.
        source = ast.parse((ROOT / 'scripts/blender_scene.py').read_text())
        fn = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'environment')
        emitted = []
        namespace = {'material': lambda *args: None, 'specified_material': lambda *args: None,
                     'primitive': lambda *args: SimpleNamespace(location=None),
                     'blender_position': lambda p: (p[0], -p[2], p[1]),
                     'area_light': lambda *args: emitted.append(args)}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), '<environment>', 'exec'), namespace)
        self.scene['environment']['kind'] = 'mesh'
        self.scene['lighting'] = copy.deepcopy(self.rig)
        self.scene['lighting']['lights'].append({**self.rig['lights'][0], 'id': 'fill', 'name': 'Fill', 'enabled': False})
        namespace['environment'](self.scene)
        self.assertEqual(emitted, [('Studio / Key', (-.2, -.24, .3), (0, 0, .07), 2.6, .23, [1, .93, .82])])

if __name__ == '__main__': unittest.main()
