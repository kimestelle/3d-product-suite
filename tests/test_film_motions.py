"""Bounded motion ownership and time survive editorial operations."""
import copy
import math
from pathlib import Path
import unittest

from film.scene import evaluate, load_scene, sample_scene, validate_scene
from tests import test_editor_api

EXAMPLE = Path(__file__).resolve().parents[1] / 'examples/bottle.scene.json'


def motion(kind='move', target='$product', **changes):
    return dict(id='move-1', target=target, kind=kind, axis='y', amount=.1,
                startFrame=1, durationFrames=25, easing='linear', enabled=True, **changes)


def arrange(shots):
    start = 1
    for shot in shots:
        duration = shot['endFrame'] - shot['startFrame'] + 1
        shot['startFrame'], shot['endFrame'] = start, start + duration - 1
        start += duration


class FilmMotionTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(EXAMPLE)

    def pose(self, frame, target='bottle-body'):
        # The bottle fixture's stationary body is the mechanism reference.
        return evaluate(self.scene, frame)['components'][target]

    def test_empty_or_disabled_motions_preserve_every_legacy_sample(self):
        expected = sample_scene(self.scene)['frames']
        self.scene['motions'] = []
        for shot in self.scene['shots']:
            shot['motions'] = [{**motion(), 'enabled': False}]
        self.assertEqual(sample_scene(self.scene)['frames'], expected)

    def test_local_motion_starts_at_each_shots_local_frame_and_holds(self):
        self.scene['shots'][1]['motions'] = [motion()]
        validate_scene(self.scene)
        before = self.pose(1)['translationM'][1]
        for frame, offset in ((120, 0), (121, 0), (133, .05), (145, .1), (240, .1), (241, 0)):
            self.assertAlmostEqual(self.pose(frame)['translationM'][1], before + offset)

    def test_reorder_and_duplicate_carry_the_same_local_performance(self):
        shot = self.scene['shots'][1]
        shot['motions'] = [motion()]
        expected = self.pose(133)
        self.scene['shots'][0], self.scene['shots'][1] = self.scene['shots'][1], self.scene['shots'][0]
        arrange(self.scene['shots']); validate_scene(self.scene)
        self.assertEqual(self.pose(13), expected)
        duplicate = copy.deepcopy(self.scene['shots'][0]); duplicate['id'] = 'copy'
        self.scene['shots'].insert(1, duplicate); arrange(self.scene['shots']); validate_scene(self.scene)
        self.assertEqual(self.pose(133), expected)

    def test_shared_motion_keeps_reel_clock_across_cuts(self):
        self.scene['motions'] = [{**motion(), 'durationFrames': 241}]
        validate_scene(self.scene)
        base = self.pose(1)['translationM'][1]
        self.assertAlmostEqual(self.pose(120)['translationM'][1] - base, .1 * 119/240)
        self.assertAlmostEqual(self.pose(121)['translationM'][1] - base, .05)
        self.assertAlmostEqual(self.pose(241)['translationM'][1] - base, .1)

    def test_local_owner_overrides_shared_not_adds_to_it(self):
        self.scene['motions'] = [{**motion(), 'amount': .8}]
        self.scene['shots'][1]['motions'] = [{**motion(), 'id': 'local', 'amount': .2}]
        validate_scene(self.scene)
        base = self.pose(1)['translationM'][1]
        self.assertAlmostEqual(self.pose(120)['translationM'][1] - base, .8)
        self.assertAlmostEqual(self.pose(121)['translationM'][1] - base, 0)
        self.assertAlmostEqual(self.pose(145)['translationM'][1] - base, .2)
        self.assertAlmostEqual(self.pose(241)['translationM'][1] - base, .8)

    def test_trimming_hides_source_without_retiming_or_destroying_keys(self):
        shot = self.scene['shots'][0]
        shot['motions'] = [{**motion(), 'keys': [{'frame': 1, 'value': 0, 'interpolation': 'linear'}, {'frame': 25, 'value': 1, 'interpolation': 'linear'}]}]
        source = copy.deepcopy(shot['motions'])
        shot['endFrame'] = 13; arrange(self.scene['shots']); validate_scene(self.scene)
        base = self.pose(1)['translationM'][1]
        self.assertAlmostEqual(self.pose(13)['translationM'][1] - base, .05)
        self.assertEqual(shot['motions'], source)
        shot['endFrame'] = 120; arrange(self.scene['shots']); validate_scene(self.scene)
        self.assertAlmostEqual(self.pose(25)['translationM'][1] - base, .1)

    def test_camera_orbit_follows_arc_and_preserves_optics(self):
        shot = self.scene['shots'][0]
        shot['camera']['from'].update(positionM=[1, .5, 0], targetM=[0, .5, 0], focalLengthMm=50)
        shot['camera']['depthOfField'] = {'enabled': True, 'fStop': 2}
        shot['motions'] = [{**motion('orbit', '$camera'), 'amount': 180}]
        validate_scene(self.scene)
        middle = evaluate(self.scene, 13)['camera']
        self.assertAlmostEqual(middle['positionM'][0], 0)
        self.assertAlmostEqual(middle['positionM'][2], -1)
        self.assertAlmostEqual(math.dist(middle['positionM'], middle['targetM']), 1)
        self.assertEqual(middle['depthOfField'], {'enabled': True, 'fStop': 2, 'focusDistanceM': 1.0})
        self.assertAlmostEqual(evaluate(self.scene, 25)['camera']['positionM'][0], -1)

    def test_camera_dolly_preserves_target_and_rejects_lens_crossing(self):
        shot = self.scene['shots'][0]
        shot['camera']['from'].update(positionM=[1, .5, 0], targetM=[0, .5, 0], focalLengthMm=50)
        shot['camera']['depthOfField'] = {'enabled': True, 'fStop': 2}
        shot['motions'] = [{**motion('dolly', '$camera'), 'amount': .5}]
        validate_scene(self.scene)
        camera = evaluate(self.scene, 25)['camera']
        self.assertEqual(camera['positionM'], [.5, .5, 0]); self.assertEqual(camera['targetM'], [0, .5, 0])
        self.assertEqual(camera['depthOfField']['focusDistanceM'], .5)
        shot['motions'][0]['amount'] = .99
        with self.assertRaisesRegex(ValueError, 'stop before'): validate_scene(self.scene)

    def test_orbit_rejects_impossible_automatic_focus_at_its_fixed_radius(self):
        shot = self.scene['shots'][0]
        shot['camera']['from'] = {'positionM': [.1, 0, 0], 'targetM': [0, 0, 0], 'focalLengthMm': 50}
        shot['camera']['to'] = {'positionM': [1, 0, 0], 'targetM': [0, 0, 0], 'focalLengthMm': 200}
        shot['camera']['depthOfField'] = {'enabled': True, 'fStop': 2.8}
        validate_scene(self.scene)  # The original outward dolly stays in focus.
        shot['motions'] = [{**motion('orbit', '$camera'), 'amount': 90}]
        with self.assertRaisesRegex(ValueError, 'focus plane'): validate_scene(self.scene)

    def test_camera_source_time_survives_trim_stretch_and_one_frame_hold(self):
        shot = self.scene['shots'][0]
        expected = {frame: evaluate(self.scene, frame)['camera'] for frame in (1, 30, 60)}
        shot['camera']['durationFrames'] = 120
        shot['endFrame'] = 60
        arrange(self.scene['shots']); validate_scene(self.scene)
        for frame in (1, 30, 60): self.assertEqual(evaluate(self.scene, frame)['camera'], expected[frame])
        shot['camera']['durationFrames'] = 239
        shot['endFrame'] = 119
        arrange(self.scene['shots']); validate_scene(self.scene)
        self.assertEqual(evaluate(self.scene, 59)['camera'], expected[30])
        shot['camera']['durationFrames'] = 1
        self.assertEqual(evaluate(self.scene, 1)['camera'], evaluate(self.scene, 100)['camera'])

    def test_camera_source_duration_and_visible_motion_ids_are_validated(self):
        shot = self.scene['shots'][0]
        for invalid in (0, 1.5, True, '120', float('inf'), 9007199254740992):
            shot['camera']['durationFrames'] = invalid
            with self.subTest(value=invalid), self.assertRaisesRegex(ValueError, 'source duration'):
                validate_scene(self.scene)
        del shot['camera']['durationFrames']
        shot['motions'] = [motion()]
        self.scene['motions'] = [motion('orbit', '$camera')]
        with self.assertRaisesRegex(ValueError, 'distinct IDs'): validate_scene(self.scene)

    def test_mechanical_action_uses_existing_confirmed_axis_pitch_and_pivot(self):
        action = self.scene['actions'][0]
        target = action['componentId']
        self.scene['shots'][0]['motions'] = [{**motion('mechanical', target), 'amount': 1}]
        validate_scene(self.scene)
        initial = evaluate(self.scene, 1)['components'][target]
        final = evaluate(self.scene, 25)['components'][target]
        expected_scene = copy.deepcopy(self.scene); expected_scene['shots'][0]['motions'] = []
        expected_scene['animation'] = {'tracks': [{'id': 'm', 'componentId': target, 'property': 'motion', 'enabled': True,
            'keys': [{'frame': 1, 'value': 1, 'interpolation': 'linear'}]}]}
        self.assertNotEqual(initial, final)
        self.assertEqual(final, evaluate(expected_scene, 25)['components'][target])

    def test_spatial_owner_suppresses_legacy_mechanism_fallback(self):
        target = self.scene['actions'][0]['componentId']
        self.scene['motions'] = [{**motion('mechanical', target), 'amount': 1}]
        self.scene['shots'][1]['motions'] = [{**motion('move', target), 'id': 'custom', 'axis': 'x', 'amount': .1}]
        validate_scene(self.scene)
        source = next(part for part in self.scene['product']['components'] if part['id'] == target)['assembly']['translationM']
        result = evaluate(self.scene, 240)['components'][target]['translationM']
        self.assertAlmostEqual(result[1], source[1])
        self.assertAlmostEqual(result[0], source[0] + .1)
        self.assertNotEqual(evaluate(self.scene, 241)['components'][target]['translationM'][1], source[1])

    def test_spatial_owner_overrides_global_motion_keys_and_disable_restores_them(self):
        target = self.scene['actions'][0]['componentId']
        self.scene['animation'] = {'tracks': [{'id': 'legacy', 'componentId': target, 'property': 'motion', 'enabled': True,
            'keys': [{'frame': 1, 'value': 1, 'interpolation': 'linear'}]}]}
        legacy = evaluate(self.scene, 25)
        self.scene['shots'][0]['motions'] = [{**motion('rotate', target), 'amount': 30}]
        validate_scene(self.scene)
        transformed = evaluate(self.scene, 25)
        self.assertNotEqual(transformed['components'][target]['translationM'], legacy['components'][target]['translationM'])
        self.scene['shots'][0]['motions'][0]['enabled'] = False
        self.assertEqual(evaluate(self.scene, 25), legacy)

    def test_product_rotation_preserves_assembly_distances(self):
        self.scene['shots'][0]['motions'] = [{**motion('rotate'), 'amount': 90}]
        validate_scene(self.scene)
        initial, final = evaluate(self.scene, 1)['components'], evaluate(self.scene, 25)['components']
        # Freeze the legacy mechanism by evaluating only early samples before its start.
        ids = list(initial)
        for left in ids:
            for right in ids:
                self.assertAlmostEqual(math.dist(initial[left]['translationM'], initial[right]['translationM']),
                                       math.dist(final[left]['translationM'], final[right]['translationM']))

    def test_custom_curve_hold_and_linear_progress_are_canonical(self):
        self.scene['shots'][0]['motions'] = [{**motion(), 'keys': [
            {'frame': 1, 'value': 0, 'interpolation': 'hold'},
            {'frame': 13, 'value': .5, 'interpolation': 'linear'},
            {'frame': 25, 'value': 1, 'interpolation': 'ease'}]}]
        validate_scene(self.scene)
        base = self.pose(1)['translationM'][1]
        for frame, offset in ((12, 0), (13, .05), (19, .075), (25, .1)):
            self.assertAlmostEqual(self.pose(frame)['translationM'][1] - base, offset)
        before = copy.deepcopy(self.scene)
        for frame in (25, 1, 19, 13, 12): evaluate(self.scene, frame)
        self.assertEqual(self.scene, before)

    def test_ownership_validation_and_malformed_values(self):
        self.scene['shots'][0]['motions'] = [motion(), {**motion(), 'id': 'second'}]
        with self.assertRaisesRegex(ValueError, 'competing owners'): validate_scene(self.scene)
        self.scene['shots'][0]['motions'][1]['enabled'] = False; validate_scene(self.scene)
        invalid = [{'durationFrames': 1}, {'startFrame': 0}, {'amount': float('inf')}, {'enabled': 1},
                   {'target': 'missing'}, {'kind': 'mechanical'}, {'kind': 'orbit', 'target': '$camera', 'axis': 'x'},
                   {'kind': 'scale', 'amount': 0}, {'easing': 'spring'},
                   {'keys': [{'frame': 1, 'value': 2, 'interpolation': 'ease'}]},
                   {'keys': [{'frame': 26, 'value': 1, 'interpolation': 'ease'}]}]
        for patch in invalid:
            with self.subTest(patch=patch):
                self.scene['shots'][0]['motions'] = [{**motion(), **patch}]
                with self.assertRaises(ValueError): validate_scene(self.scene)


class FilmMotionApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_save_reopen_and_live_evaluate_use_identical_bounded_motion(self):
        project = self.bootstrap()['project']
        route = f"/api/projects/{project['id']}"
        scene = copy.deepcopy(project['scene'])
        scene['shots'][0]['motions'] = [{**motion('orbit', '$camera'), 'amount': 90}]
        status, saved, _ = self.request('PUT', route, {'scene': scene, 'expectedRevisionId': project['revisionId']})
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.request('GET', route)[1]['scene'], scene)
        for frame in (1, 13, 25):
            status, sampled, _ = self.request('POST', '/api/evaluate', {'scene': scene, 'frame': frame})
            self.assertEqual(status, 200, sampled)
            self.assertEqual(sampled['sample'], evaluate(scene, frame))
        invalid = copy.deepcopy(scene)
        invalid['shots'][0]['motions'].append({**invalid['shots'][0]['motions'][0], 'id': 'competing'})
        status, rejected, _ = self.request('PUT', route, {'scene': invalid, 'expectedRevisionId': saved['revisionId']})
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.request('GET', route)[1]['scene'], scene)


if __name__ == '__main__': unittest.main()
