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
        emitted, namespace = self.environment_adapter()
        self.scene['environment']['kind'] = 'mesh'
        self.scene['lighting'] = copy.deepcopy(self.rig)
        self.scene['lighting']['lights'].append({**self.rig['lights'][0], 'id': 'fill', 'name': 'Fill', 'enabled': False})
        namespace['environment'](self.scene)
        self.assertEqual(emitted, [('Studio / Key', (-.2, -.24, .3), (0, 0, .07), 2.6, .23, [1, .93, .82])])

    def environment_adapter(self):
        source = ast.parse((ROOT / 'scripts/blender_scene.py').read_text())
        fn = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'environment')
        emitted = []
        # Light builders return the host object the adapter tags with the scene ID.
        def builder(kind):
            def build(*args):
                emitted.append(args if kind == 'area' else (kind, *args))
                return {}
            return build
        namespace = {'material': lambda *args: None, 'specified_material': lambda *args: None,
                     'primitive': lambda *args: SimpleNamespace(location=None),
                     'blender_position': lambda p: (p[0], -p[2], p[1]),
                     'area_light': builder('area'), 'spot_light': builder('spot')}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), '<environment>', 'exec'), namespace)
        return emitted, namespace

    def test_blender_receives_spot_cone_blend_radius_and_scene_id(self):
        emitted, namespace = self.environment_adapter()
        built = {}
        namespace['spot_light'] = lambda *args: built.setdefault(args[0], {'args': args})
        self.scene['lighting'] = {'ambientStrength': .15, 'ambientColor': [.3, .2, .2], 'lights': [
            {'id': 'spot', 'name': 'Spot', 'type': 'spot', 'enabled': True, 'positionM': [-.1, .42, .28], 'targetM': [0, .054, 0],
             'powerW': 12, 'diameterM': .05, 'color': [1, .86, .7], 'coneDeg': 35, 'blend': .4},
            {'id': 'bare', 'name': 'Bare spot', 'type': 'spot', 'enabled': True, 'positionM': [.3, .3, 0], 'targetM': [0, 0, 0],
             'powerW': 4, 'diameterM': .1, 'color': [1, 1, 1]}]}
        validate_scene(self.scene)
        self.scene['environment']['kind'] = 'mesh'  # Skip the authored sweep in the host adapter.
        namespace['environment'](self.scene)
        self.assertEqual(emitted, [])
        self.assertEqual(built['Studio / Spot']['args'], ('Studio / Spot', (-.1, -.28, .42), (0, 0, .054), 12, 35, .4, .025, [1, .86, .7]))
        self.assertEqual(built['Studio / Spot']['gesso_light_id'], 'spot')
        # Absent cone and blend fall back to the documented defaults at handoff, not in the saved scene.
        self.assertEqual(built['Studio / Bare spot']['args'][4:7], (40, .3, .05))
        self.assertNotIn('coneDeg', self.scene['lighting']['lights'][1])

    def test_spot_and_ambient_fields_validate_only_when_present(self):
        self.scene['lighting'] = copy.deepcopy(self.rig)
        validate_scene(self.scene)
        self.assertNotIn('type', self.scene['lighting']['lights'][0])
        spot = {**self.rig['lights'][0], 'id': 'spot', 'name': 'Spot', 'type': 'spot', 'coneDeg': 170, 'blend': 1}
        self.scene['lighting']['lights'].append(spot)
        self.scene['lighting']['ambientColor'] = [0, 0, 1]
        validate_scene(self.scene)
        self.assertEqual(validate_scene(json.loads(json.dumps(self.scene))), self.scene)
        for change in (lambda l: l['lights'][1].update(type='point'), lambda l: l['lights'][1].update(coneDeg=.5),
                       lambda l: l['lights'][1].update(coneDeg=171), lambda l: l['lights'][1].update(blend=-.1),
                       lambda l: l['lights'][1].update(blend=1.5), lambda l: l['lights'][0].update(coneDeg='wide'),
                       lambda l: l.update(ambientColor=[1, 1, 2]), lambda l: l.update(ambientColor=[0, 0]),
                       lambda l: l.update(ambientColor='warm')):
            with self.subTest(change=change):
                scene = copy.deepcopy(self.scene); change(scene['lighting'])
                with self.assertRaises(ValueError): validate_scene(scene)

if __name__ == '__main__': unittest.main()
