"""Authored property tracks share the deterministic preview/export scene sampler."""

import copy
import hashlib
import json
import math
from pathlib import Path
import unittest

from film.scene import evaluate, sample_scene, scene_digest, validate_scene
from tests import test_editor_api

ROOT = Path(__file__).resolve().parents[1]


def track(prop, values, *, target="cap", enabled=True, interpolation="linear"):
    return {"id": f"{target}:{prop}", "componentId": target, "property": prop, "enabled": enabled,
            "keys": [{"frame": frame, "value": value, "interpolation": interpolation} for frame, value in values]}


def quat_xyz(x, y, z):
    # Compose independent rotations rather than repeating the engine's formula.
    def mul(a, b):
        x, y, z, w = a
        X, Y, Z, W = b
        return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z]
    def axis(index, angle):
        result = [0, 0, 0, math.cos(math.radians(angle)/2)]
        result[index] = math.sin(math.radians(angle)/2)
        return result
    return mul(mul(axis(0, x), axis(1, y)), axis(2, z))


class KeyframeTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads((ROOT / "examples/bottle.scene.json").read_text())
        self.cap = next(c for c in self.scene["product"]["components"] if c["id"] == "cap")

    def animate(self, *tracks):
        self.scene["animation"] = {"tracks": list(tracks)}
        validate_scene(self.scene)

    def pose(self, frame, target="cap"):
        return evaluate(self.scene, frame)["components"][target]

    def assertVectorAlmostEqual(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=10)

    def test_existing_reel_is_byte_identical_without_animation(self):
        # Recorded from the previous sampler: includes all 360 frames, cameras,
        # action timing and numeric JSON representations, not just endpoints.
        frames = sample_scene(self.scene)["frames"]
        legacy_frames = copy.deepcopy(frames)
        for frame in legacy_frames:
            self.assertFalse(frame["camera"].pop("depthOfField")["enabled"])
        digest = hashlib.sha256(json.dumps(legacy_frames, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(digest, "42445ce05754f1b8ed067ddac9e63e0133e54c05d2a187eb677180dc31920498")
        self.animate()
        self.assertEqual(sample_scene(self.scene)["frames"], frames)

    def test_disabled_tracks_preserve_keys_and_all_static_and_action_values(self):
        expected = sample_scene(self.scene)["frames"]
        self.animate(track("position.x", [(1, 2), (120, 4)], enabled=False),
                     track("motion", [(1, 1), (120, 0)], enabled=False),
                     track("scale", [(1, 3)], target="$product", enabled=False))
        before = copy.deepcopy(self.scene)
        self.assertEqual(sample_scene(self.scene)["frames"], expected)
        self.assertEqual(self.scene, before)

    def test_linear_track_holds_ends_and_uses_absolute_reel_frames(self):
        self.animate(track("position.x", [(100, .1), (140, .5)]))
        for frame, expected in ((1, .1), (100, .1), (110, .2), (120, .3), (121, .31), (140, .5), (360, .5)):
            with self.subTest(frame=frame):
                self.assertAlmostEqual(self.pose(frame)["translationM"][0], expected)
        self.assertNotEqual(evaluate(self.scene, 120)["shotId"], evaluate(self.scene, 121)["shotId"])

    def test_hold_changes_at_exact_key_and_interpolation_is_outgoing(self):
        authored = track("position.x", [(10, 1), (30, 5), (50, 9)], interpolation="hold")
        authored["keys"][1]["interpolation"] = "linear"
        self.animate(authored)
        for frame, expected in ((1, 1), (29, 1), (30, 5), (40, 7), (50, 9)):
            self.assertEqual(self.pose(frame)["translationM"][0], expected)

    def test_ease_is_smoothstep_and_one_key_is_constant(self):
        self.animate(track("position.x", [(1, 0), (101, 1)], interpolation="ease"),
                     track("position.z", [(70, -.4)]))
        for frame, expected in ((1, 0), (26, .15625), (51, .5), (76, .84375), (101, 1)):
            self.assertAlmostEqual(self.pose(frame)["translationM"][0], expected)
            self.assertEqual(self.pose(frame)["translationM"][2], -.4)

    def test_keyed_base_rotation_inherits_unkeyed_xyz_axes(self):
        self.scene["actions"] = []
        self.cap["assembly"]["rotationXyzw"] = quat_xyz(23, -31, 47)
        self.animate(track("rotation.y", [(1, -31), (101, 41)]))
        self.assertVectorAlmostEqual(self.pose(1)["rotationXyzw"], quat_xyz(23, -31, 47))
        self.assertVectorAlmostEqual(self.pose(51)["rotationXyzw"], quat_xyz(23, 5, 47))
        self.assertVectorAlmostEqual(self.pose(101)["rotationXyzw"], quat_xyz(23, 41, 47))

    def test_rotation_keys_retain_full_turns_instead_of_shortest_quaternion_path(self):
        self.scene["actions"] = []
        self.animate(track("rotation.z", [(1, 0), (101, 720)]))
        self.assertVectorAlmostEqual(self.pose(26)["rotationXyzw"], quat_xyz(0, 0, 180))
        self.assertVectorAlmostEqual(self.pose(51)["rotationXyzw"], quat_xyz(0, 0, 360))
        self.assertVectorAlmostEqual(self.pose(101)["rotationXyzw"], quat_xyz(0, 0, 720))

    def test_gimbal_lock_matches_three_xyz_convention(self):
        self.scene["actions"] = []
        self.cap["assembly"]["rotationXyzw"] = quat_xyz(20, 90, 30)
        # Three exposes this quaternion as [50, 90, 0]; changing Y preserves
        # those displayed X/Z values rather than guessing the original Euler.
        self.animate(track("rotation.y", [(1, 45)]))
        self.assertVectorAlmostEqual(self.pose(1)["rotationXyzw"], quat_xyz(50, 45, 0))

    def test_animated_placement_and_part_scale_preserve_support_coordinate_rules(self):
        self.scene["environment"]["plinth"].update(translationM=[4, 5, 6], sizeM=[.4, .4, .4])
        self.scene["placement"]["translationM"] = [1, 2, 3]
        self.cap["assembly"]["translationM"] = [.1, .2, .3]
        self.animate(track("position.x", [(1, .4)]), track("scale", [(1, 3)]),
                     track("position.y", [(1, 4)], target="$product"),
                     track("scale", [(1, 2)], target="$product"))
        self.assertVectorAlmostEqual(self.pose(1)["translationM"], [5.8, 9.6, 9.6])
        self.assertEqual(self.pose(1)["scale"], 6)

    def test_motion_curve_lifts_pauses_continues_and_returns(self):
        self.animate(track("motion", [(1, 0), (101, .5), (151, .5), (251, 1), (351, 0)]))
        initial = self.cap["assembly"]["translationM"][1]
        for frame, progress in ((1, 0), (51, .25), (101, .5), (130, .5), (151, .5), (201, .75), (251, 1), (301, .5), (360, 0)):
            self.assertAlmostEqual(self.pose(frame)["translationM"][1], initial + .055 * progress)

    def test_motion_is_applied_after_keyed_rotation_and_scale(self):
        self.animate(track("rotation.z", [(1, 90)]), track("motion", [(1, .5)]),
                     track("scale", [(1, 3)]), track("scale", [(1, 2)], target="$product"))
        self.assertVectorAlmostEqual(self.pose(1)["translationM"], [-.165, .249, 0])
        self.assertVectorAlmostEqual(self.pose(1)["rotationXyzw"], quat_xyz(0, 0, 90))
        self.assertEqual(self.pose(1)["scale"], 6)

    def test_screw_motion_preserves_pivot_and_coupled_lead(self):
        action = self.scene["actions"][0]
        action.pop("distanceM")
        action.update(type="screw", pivotM=[.01, 0, 0], turns=.5,
                      axialTravelPerRevolutionM=.008, directionSign=1)
        self.animate(track("motion", [(1, .5)]), track("scale", [(1, 2)]))
        self.assertVectorAlmostEqual(self.pose(1)["translationM"], [.02, .1285, .02])
        self.assertVectorAlmostEqual(self.pose(1)["rotationXyzw"], quat_xyz(0, 90, 0))

    def test_motion_can_reverse_and_overshoot(self):
        self.animate(track("motion", [(1, -.5), (101, 1.5)]))
        self.assertAlmostEqual(self.pose(1)["translationM"][1], .1245 - .0275)
        self.assertAlmostEqual(self.pose(101)["translationM"][1], .1245 + .0825)

    def test_scrubbing_and_sampling_do_not_mutate_or_accumulate(self):
        self.animate(track("motion", [(1, 0), (120, 1), (360, 0)], interpolation="ease"),
                     track("rotation.x", [(1, 0), (360, 720)]), track("scale", [(1, 1), (360, .5)]))
        before = copy.deepcopy(self.scene)
        digest = scene_digest(self.scene)
        frames = sample_scene(self.scene)["frames"]
        for frame in (360, 1, 166, 241, 120, 166):
            self.assertEqual(evaluate(self.scene, frame), frames[frame-1])
        self.assertEqual(self.scene, before)
        self.assertEqual(scene_digest(self.scene), digest)

    def test_reel_coordinates_survive_shot_repartition_and_fps_change(self):
        self.scene["actions"] = []
        self.animate(track("position.x", [(1, 0), (360, 1)]))
        poses = [self.pose(frame) for frame in (1, 120, 121, 240, 360)]
        self.scene["shots"][0]["endFrame"] = 100
        self.scene["shots"][1].update(startFrame=101, endFrame=260)
        self.scene["shots"][2]["startFrame"] = 261
        self.scene["render"]["fps"] = 60
        validate_scene(self.scene)
        self.assertEqual([self.pose(frame) for frame in (1, 120, 121, 240, 360)], poses)
        self.assertEqual(evaluate(self.scene, 121)["timeSeconds"], 2)

    def test_invalid_track_schema_and_targets_are_rejected(self):
        invalid_tracks = [None, {}, {**track("position.x", [(1, 0)]), "id": " "},
                          track("opacity", [(1, 0)]), track("rotation.x", [(1, 0)], target="$product"),
                          track("position.x", [(1, 0)], target="missing"),
                          track("motion", [(1, 0)], target="neck"),
                          {**track("scale", [(1, 1)]), "enabled": 1}, track("position.x", [])]
        for candidate in invalid_tracks:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                self.scene["animation"] = {"tracks": [candidate]}
                validate_scene(self.scene)
        for animation in (None, [], {}, {"tracks": None}):
            with self.subTest(animation=animation), self.assertRaises(ValueError):
                self.scene["animation"] = animation
                validate_scene(self.scene)

    def test_enabled_part_tracks_cannot_move_a_dependent_action_reference(self):
        for prop in ("position.x", "rotation.y", "scale"):
            with self.subTest(prop=prop), self.assertRaisesRegex(ValueError, "reference for another part's movement"):
                self.animate(track(prop, [(1, 1)], target="bottle-body"))
        self.animate(track("position.x", [(1, 1)], target="bottle-body", enabled=False),
                     track("position.x", [(1, 1)], target="$product"))
        # A whole-product track carries both reference and moving part together;
        # disabled part keys remain available without changing this relation.
        self.assertEqual(self.pose(1, "bottle-body")["translationM"][0], 1)
        self.assertEqual(self.pose(1)["translationM"][0], 1)
        self.scene["actions"] = []
        self.scene["animation"]["tracks"][0]["enabled"] = True
        validate_scene(self.scene)
        self.assertEqual(self.pose(1, "bottle-body")["translationM"][0], 2)

    def test_key_frames_are_sorted_unique_integer_and_in_reel(self):
        for keys in ([(0, 0)], [(361, 0)], [(1.0, 0)], [(True, 0)], [(10, 0), (5, 1)], [(10, 0), (10, 1)]):
            with self.subTest(keys=keys), self.assertRaisesRegex(ValueError, "frames"):
                self.animate(track("position.x", keys))

    def test_key_values_and_interpolation_are_validated_even_when_disabled(self):
        for prop, values in (("position.x", [None, True, "1", math.inf, -math.inf, math.nan]),
                             ("scale", [0, .009, 101]), ("motion", [-101, 101])):
            for value in values:
                with self.subTest(prop=prop, value=value), self.assertRaises(ValueError):
                    self.animate(track(prop, [(1, value)], enabled=False))
        with self.assertRaisesRegex(ValueError, "interpolation"):
            self.animate(track("position.x", [(1, 0)], interpolation="bezier"))

    def test_duplicate_ids_and_channels_are_rejected(self):
        a = track("position.x", [(1, 0)])
        b = track("position.y", [(1, 0)])
        b["id"] = a["id"]
        with self.assertRaisesRegex(ValueError, "IDs"):
            self.animate(a, b)
        b = copy.deepcopy(a)
        b["id"] = "another-id"
        b["enabled"] = False
        with self.assertRaisesRegex(ValueError, "component/property"):
            self.animate(a, b)


class KeyframeApiTests(unittest.TestCase):
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_save_reopen_and_single_frame_preview_keep_authored_keys(self):
        project = self.bootstrap()["project"]
        route = f"/api/projects/{project['id']}"
        scene = copy.deepcopy(project["scene"])
        scene["animation"] = {"tracks": [track("motion", [(1, 0), (120, 1), (360, 0)]),
                                             track("scale", [(1, .8)], enabled=False)]}
        status, saved, _ = self.request("PUT", route, {"scene": scene, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.request("GET", route)[1]["scene"], scene)
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": 160})
        self.assertEqual(status, 200, sampled)
        self.assertEqual(sampled["sample"], evaluate(scene, 160))
        self.assertEqual(sampled["scene"]["animation"], scene["animation"])
        invalid = copy.deepcopy(scene)
        invalid["animation"]["tracks"][0]["keys"][-1]["frame"] = 361
        status, rejected, _ = self.request("PUT", route, {"scene": invalid, "expectedRevisionId": saved["revisionId"]})
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.request("GET", route)[1]["scene"], scene)


if __name__ == "__main__":
    unittest.main()
