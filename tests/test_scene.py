"""Regression checks for canonical transforms and approved scene documents."""

import copy
import json
import math
from pathlib import Path
import unittest

from film.scene import evaluate, load_scene, sample_scene, scene_digest, validate_scene


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "bottle.scene.json"


class SceneTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads(EXAMPLE.read_text())

    def assertVectorAlmostEqual(self, actual, expected, places=10):
        self.assertEqual(len(actual), len(expected))
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=places)

    def assertInvalid(self, scene):
        with self.assertRaises(ValueError):
            validate_scene(scene)

    def component(self, component_id="cap"):
        return next(c for c in self.scene["product"]["components"] if c["id"] == component_id)

    def short_shot(self, frames=3):
        self.scene["actions"] = []
        self.scene["shots"] = [copy.deepcopy(self.scene["shots"][0])]
        self.scene["shots"][0]["endFrame"] = frames
        return self.scene["shots"][0]

    def test_fixture_is_valid_and_loadable(self):
        self.assertEqual(load_scene(EXAMPLE), self.scene)
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(self.scene["shots"][-1]["endFrame"], 360)
        self.assertEqual(self.scene["render"]["fps"], 24)

    def test_hidden_plinth_preserves_support_placement(self):
        self.scene["environment"]["plinth"].update(translationM=[.2, -.115, .3], sizeM=[.4, .07, .4])
        visible = evaluate(self.scene, 1)
        self.scene["environment"]["plinth"]["visible"] = False
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(evaluate(self.scene, 1), visible)
        self.assertAlmostEqual(visible["components"]["bottle-body"]["translationM"][1],
                               self.component("bottle-body")["assembly"]["translationM"][1] - .08)
        self.scene["environment"]["plinth"]["visible"] = True
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(evaluate(self.scene, 1), visible)

    def test_plinth_visibility_must_be_a_boolean(self):
        for value in (None, 0, 1, "false", [], {}):
            with self.subTest(value=value):
                self.scene["environment"]["plinth"]["visible"] = value
                with self.assertRaisesRegex(ValueError, "Plinth visible must be boolean"):
                    validate_scene(self.scene)

    def test_digest_is_canonical_and_detects_revision_changes(self):
        reordered = dict(reversed(list(self.scene.items())))
        self.assertEqual(scene_digest(self.scene), scene_digest(reordered))
        reordered = copy.deepcopy(reordered)
        reordered["product"]["revisionId"] = "changed-revision"
        self.assertNotEqual(scene_digest(self.scene), scene_digest(reordered))

    def test_scrubbing_in_arbitrary_order_is_deterministic_and_immutable(self):
        original = copy.deepcopy(self.scene)
        frames = [1, 120, 121, 130, 166, 202, 240, 241, 360]
        expected = {frame: evaluate(self.scene, frame) for frame in frames}
        for frame in [360, 166, 1, 240, 121, 202, 130, 241, 120, 166]:
            self.assertEqual(evaluate(self.scene, frame), expected[frame])
        self.assertEqual(self.scene, original)
        changed_sample = evaluate(self.scene, 166)
        changed_sample["components"]["cap"]["translationM"][0] = 999
        self.assertEqual(evaluate(self.scene, 166), expected[166])

    def test_sample_scene_contains_every_absolute_frame(self):
        sampled = sample_scene(self.scene)
        self.assertEqual(sampled["scene"], self.scene)
        self.assertEqual(len(sampled["frames"]), 360)
        self.assertEqual([f["frame"] for f in sampled["frames"]], list(range(1, 361)))
        self.assertEqual(sampled["frames"][120], evaluate(self.scene, 121))
        self.assertEqual(sampled["frames"][-1]["timeSeconds"], 359 / 24)

    def test_lift_is_clamped_and_other_parts_remain_stationary(self):
        original_cap = self.component()["assembly"]
        first = evaluate(self.scene, 1)
        before = evaluate(self.scene, 130)  # t=5.375, before the 5.4s start.
        last = evaluate(self.scene, 360)
        self.assertEqual(before["components"]["cap"], first["components"]["cap"])
        self.assertVectorAlmostEqual(
            last["components"]["cap"]["translationM"],
            [0, original_cap["translationM"][1] + 0.055, 0],
        )
        self.assertEqual(last["components"]["cap"]["rotationXyzw"], original_cap["rotationXyzw"])
        for component_id in ("bottle-body", "neck", "label"):
            self.assertEqual(first["components"][component_id], last["components"][component_id])

    def test_lift_axis_is_in_original_component_local_coordinates(self):
        s = math.sqrt(0.5)
        self.component()["assembly"]["rotationXyzw"] = [0, 0, s, s]
        self.scene["placement"]["translationM"] = [1, 2, 3]
        action = self.scene["actions"][0]
        action.update(startSeconds=0, durationSeconds=2, distanceM=0.06)
        validate_scene(self.scene)
        at_half = evaluate(self.scene, 25)["components"]["cap"]
        # Local +Y becomes world -X after the original +90 degree Z rotation.
        self.assertVectorAlmostEqual(at_half["translationM"], [0.97, 2.1245, 3])
        self.assertVectorAlmostEqual(at_half["rotationXyzw"], [0, 0, s, s])

    def test_screw_uses_rotated_local_pivot_and_coupled_progress(self):
        s = math.sqrt(0.5)
        self.component()["assembly"]["rotationXyzw"] = [0, 0, s, s]
        self.scene["placement"]["translationM"] = [1, 2, 3]
        action = self.scene["actions"][0]
        action.pop("distanceM")
        action.update(
            type="screw", startSeconds=0, durationSeconds=2,
            pivotM=[0.01, 0, 0], turns=0.5,
            axialTravelPerRevolutionM=0.008, directionSign=1,
        )
        validate_scene(self.scene)
        before = evaluate(self.scene, 1)["components"]["cap"]
        halfway = evaluate(self.scene, 25)["components"]["cap"]
        after = evaluate(self.scene, 49)["components"]["cap"]
        # At u=.5: rotate 90 degrees around local Y and advance .002m.
        self.assertVectorAlmostEqual(halfway["translationM"], [0.998, 2.1345, 3.01])
        self.assertVectorAlmostEqual(halfway["rotationXyzw"], [-0.5, 0.5, 0.5, 0.5])
        self.assertVectorAlmostEqual(after["translationM"], [0.996, 2.1445, 3])
        self.assertVectorAlmostEqual(before["translationM"], [1, 2.1245, 3])

    def test_screw_direction_reverses_rotation_using_same_lead(self):
        action = self.scene["actions"][0]
        action.pop("distanceM")
        action.update(
            type="screw", startSeconds=0, durationSeconds=2,
            turns=0.5, axialTravelPerRevolutionM=0.008, directionSign=-1,
        )
        validate_scene(self.scene)
        pose = evaluate(self.scene, 25)["components"]["cap"]
        self.assertVectorAlmostEqual(pose["translationM"], [0, 0.1265, 0])
        self.assertVectorAlmostEqual(pose["rotationXyzw"], [0, -math.sqrt(0.5), 0, math.sqrt(0.5)])

    def test_shot_boundaries_select_exact_camera_endpoints(self):
        for shot in self.scene["shots"]:
            for frame, endpoint in ((shot["startFrame"], "from"), (shot["endFrame"], "to")):
                with self.subTest(frame=frame):
                    sample = evaluate(self.scene, frame)
                    self.assertEqual(sample["shotId"], shot["id"])
                    self.assertEqual({key: sample["camera"][key] for key in shot["camera"][endpoint]}, shot["camera"][endpoint])
        self.assertNotEqual(evaluate(self.scene, 120)["camera"], evaluate(self.scene, 121)["camera"])

    def test_single_frame_shot_uses_from_camera(self):
        shot = self.short_shot(frames=1)
        validate_scene(self.scene)
        self.assertEqual({key: evaluate(self.scene, 1)["camera"][key] for key in shot["camera"]["from"]}, shot["camera"]["from"])

    def test_invalid_frame_numbers_are_rejected(self):
        for frame in (0, -1, 361, 1.0, True, None, "1"):
            with self.subTest(frame=frame), self.assertRaises(ValueError):
                evaluate(self.scene, frame)

    def test_unconfirmed_or_unsupported_actions_are_rejected(self):
        for key, value in (("approval", "proposed"), ("approval", "rejected"), ("type", "hinge"), ("axisSpace", "world")):
            with self.subTest(key=key, value=value):
                scene = copy.deepcopy(self.scene)
                scene["actions"][0][key] = value
                self.assertInvalid(scene)

    def test_missing_action_evidence_is_rejected(self):
        for evidence_ids in ([], ["unknown-evidence"], None):
            with self.subTest(evidence_ids=evidence_ids):
                scene = copy.deepcopy(self.scene)
                scene["actions"][0]["evidenceIds"] = evidence_ids
                self.assertInvalid(scene)

    def test_action_evidence_must_be_a_list_of_evidence_ids(self):
        self.scene["evidence"][0]["id"] = "e"
        for evidence_ids in ("e", {"e": 1}):
            with self.subTest(evidence_ids=evidence_ids):
                scene = copy.deepcopy(self.scene)
                scene["actions"][0]["evidenceIds"] = evidence_ids
                self.assertInvalid(scene)

    def test_evidence_needs_a_readable_description(self):
        for description in ("", " ", 123, True, None):
            with self.subTest(description=description):
                scene = copy.deepcopy(self.scene)
                scene["evidence"][0]["description"] = description
                self.assertInvalid(scene)

    def test_actions_cannot_transfer_to_replaced_component_ids(self):
        scene = copy.deepcopy(self.scene)
        next(c for c in scene["product"]["components"] if c["id"] == "cap")["id"] = "replacement-cap"
        scene["product"]["revisionId"] = "replacement-product-v2"
        self.assertInvalid(scene)
        for key in ("componentId", "relativeTo"):
            with self.subTest(key=key):
                scene = copy.deepcopy(self.scene)
                scene["actions"][0][key] = "old-revision-component"
                self.assertInvalid(scene)

    def test_action_cannot_reference_itself_or_an_animated_parent(self):
        scene = copy.deepcopy(self.scene)
        scene["actions"][0]["relativeTo"] = "cap"
        self.assertInvalid(scene)
        scene = copy.deepcopy(self.scene)
        body_action = copy.deepcopy(scene["actions"][0])
        body_action.update(actionId="body-action", componentId="bottle-body", relativeTo="neck")
        scene["actions"].append(body_action)
        self.assertInvalid(scene)

    def test_duplicate_component_and_action_ids_are_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene["product"]["components"].append(copy.deepcopy(scene["product"]["components"][0]))
        self.assertInvalid(scene)
        scene = copy.deepcopy(self.scene)
        scene["actions"].append(copy.deepcopy(scene["actions"][0]))
        self.assertInvalid(scene)

    def test_multiple_actions_for_one_component_are_rejected(self):
        action = copy.deepcopy(self.scene["actions"][0])
        action["actionId"] = "second-cap-action"
        self.scene["actions"].append(action)
        self.assertInvalid(self.scene)

    def test_malformed_action_parameters_are_rejected(self):
        for key, value in (
            ("axis", [0, 2, 0]), ("axis", [0, 0, 0]), ("axis", [0, 1]),
            ("pivotM", [0, float("inf"), 0]), ("distanceM", -0.1),
            ("startSeconds", -1), ("durationSeconds", 0),
            ("durationSeconds", float("nan")), ("distanceM", True),
        ):
            with self.subTest(key=key, value=value):
                scene = copy.deepcopy(self.scene)
                scene["actions"][0][key] = value
                self.assertInvalid(scene)
        scene = copy.deepcopy(self.scene)
        del scene["actions"][0]["distanceM"]
        self.assertInvalid(scene)

    def test_malformed_screw_parameters_are_rejected(self):
        action = self.scene["actions"][0]
        action.pop("distanceM")
        action.update(type="screw", turns=2, axialTravelPerRevolutionM=0.002, directionSign=1)
        for key, value in (
            ("turns", -1), ("turns", float("nan")),
            ("axialTravelPerRevolutionM", 0), ("axialTravelPerRevolutionM", -0.01),
            ("directionSign", 0), ("directionSign", True), ("directionSign", "1"),
        ):
            with self.subTest(key=key, value=value):
                scene = copy.deepcopy(self.scene)
                scene["actions"][0][key] = value
                self.assertInvalid(scene)

    def test_action_must_finish_within_last_evaluated_time(self):
        last_time = 359 / 24
        action = self.scene["actions"][0]
        action.update(startSeconds=last_time - 2, durationSeconds=2)
        validate_scene(self.scene)
        action["durationSeconds"] += 1 / 24
        self.assertInvalid(self.scene)

    def test_action_shot_and_evidence_ids_are_nonempty_strings(self):
        for collection, key in (("actions", "actionId"), ("shots", "id"), ("evidence", "id")):
            for value in ("", " ", 123, True):
                with self.subTest(collection=collection, value=value):
                    scene = copy.deepcopy(self.scene)
                    scene[collection][0][key] = value
                    if collection == "evidence":
                        scene["actions"][0]["evidenceIds"] = [value]
                    self.assertInvalid(scene)

    def test_shot_ranges_must_be_ordered_nonoverlapping_integer_frames(self):
        for index, key, value in (
            (0, "startFrame", 0), (0, "endFrame", 0),
            (1, "startFrame", 120),
            (1, "endFrame", 119), (0, "startFrame", True),
            (0, "endFrame", 120.0),
        ):
            with self.subTest(index=index, key=key, value=value):
                scene = copy.deepcopy(self.scene)
                scene["shots"][index][key] = value
                self.assertInvalid(scene)
        self.scene["shots"][1]["id"] = self.scene["shots"][0]["id"]
        self.assertInvalid(self.scene)

    def test_coordinate_convention_cannot_be_guessed(self):
        for key, value in (("units", "millimeters"), ("handedness", "left"), ("up", "Z")):
            with self.subTest(key=key):
                scene = copy.deepcopy(self.scene)
                scene["coordinates"][key] = value
                self.assertInvalid(scene)

    def test_nonfinite_and_malformed_transforms_are_rejected(self):
        for key, value in (
            ("translationM", [0, float("inf"), 0]),
            ("translationM", [0, True, 0]),
            ("translationM", [0, 0]),
            ("rotationXyzw", [0, 0, 0, 2]),
            ("rotationXyzw", [0, 0, 0, 0]),
            ("rotationXyzw", [0, 0, float("nan"), 1]),
        ):
            with self.subTest(key=key, value=value):
                scene = copy.deepcopy(self.scene)
                scene["product"]["components"][0]["assembly"][key] = value
                self.assertInvalid(scene)
        for size in ([0, 0.1, 0.1], [-0.1, 0.1, 0.1], [0.1, float("inf"), 0.1]):
            with self.subTest(size=size):
                scene = copy.deepcopy(self.scene)
                scene["product"]["dimensionsM"] = size
                self.assertInvalid(scene)

    def test_cylinder_diameter_must_match_and_label_target_must_exist(self):
        self.component()["sizeM"][0] = 0.04
        self.assertInvalid(self.scene)
        self.scene = json.loads(EXAMPLE.read_text())
        self.scene["product"]["label"]["componentId"] = "stale-label"
        self.assertInvalid(self.scene)

    def test_nonfinite_metadata_is_rejected_before_serializing(self):
        self.scene["experiment"] = {"waitingSeconds": float("nan")}
        self.assertInvalid(self.scene)

    def test_unsupported_worlds_and_missing_contact_surface_are_rejected(self):
        self.scene["environment"]["kind"] = "generated"
        self.assertInvalid(self.scene)
        self.scene["environment"]["kind"] = "authored"
        self.scene["placement"]["restsOn"] = "missing-surface"
        self.assertInvalid(self.scene)

    def test_camera_must_have_nonvertical_view_and_positive_focal_length(self):
        for position, target, focal in (
            ([0, 0, 0], [0, 0, 0], 50),
            ([0, 1, 0], [0, 0, 0], 50),
            ([1, 1, 1], [0, 0, 0], 0),
            ([1, float("nan"), 1], [0, 0, 0], 50),
        ):
            with self.subTest(position=position, focal=focal):
                scene = copy.deepcopy(self.scene)
                scene["shots"][0]["camera"]["from"].update(
                    positionM=position, targetM=target, focalLengthMm=focal,
                )
                self.assertInvalid(scene)

    def test_camera_interpolation_cannot_cross_target_or_vertical_direction(self):
        for y in (0, 1):
            with self.subTest(y=y):
                self.scene = json.loads(EXAMPLE.read_text())
                shot = self.short_shot(frames=3)
                shot["camera"]["from"].update(positionM=[1, y, 0], targetM=[0, 0, 0])
                shot["camera"]["to"].update(positionM=[-1, y, 0], targetM=[0, 0, 0])
                self.assertInvalid(self.scene)

    def test_malformed_scene_containers_raise_valueerror(self):
        for scene in (None, [], {}, {"schemaVersion": 2}, {"schemaVersion": 1}):
            with self.subTest(scene=scene):
                self.assertInvalid(scene)


class LightMotionSchemaTests(unittest.TestCase):
    """Spot lights and light motions are additive: absent fields keep the saved rig."""

    def setUp(self):
        self.scene = json.loads(EXAMPLE.read_text())
        self.scene["lighting"] = {"ambientStrength": .15, "lights": [
            {"id": "spot", "name": "Spot", "type": "spot", "enabled": True, "coneDeg": 35, "blend": .4,
             "positionM": [1, .5, 0], "targetM": [0, .5, 0], "powerW": 12, "diameterM": .05, "color": [1, .86, .7]},
            {"id": "off", "name": "Off", "enabled": False,
             "positionM": [0, 1, 0], "targetM": [0, 0, 0], "powerW": 1, "diameterM": .1, "color": [1, 1, 1]}]}

    def light_motion(self, kind="orbit", target="$light:spot", **changes):
        return {"id": "light-1", "target": target, "kind": kind, "axis": "y", "amount": 60,
                "startFrame": 1, "durationFrames": 25, "easing": "ease", "enabled": True, **changes}

    def test_spot_light_validates_and_survives_a_json_roundtrip(self):
        validate_scene(self.scene)
        self.assertEqual(validate_scene(json.loads(json.dumps(self.scene))), self.scene)
        del self.scene["lighting"]["lights"][0]["type"]
        validate_scene(self.scene)
        self.assertNotIn("type", self.scene["lighting"]["lights"][0])

    def test_light_motions_accept_orbit_move_and_aim_on_enabled_lights(self):
        self.scene["shots"][0]["motions"] = [self.light_motion(), self.light_motion("move", id="rise", axis="y", amount=.1),
                                             self.light_motion("move", id="slide", axis="x", amount=.1),
                                             self.light_motion("aim", id="aim", axis="z", amount=.05)]
        validate_scene(self.scene)
        self.scene["motions"] = [self.light_motion(id="shared", durationFrames=241)]
        validate_scene(self.scene)
        self.assertEqual(scene_digest(validate_scene(json.loads(json.dumps(self.scene)))), scene_digest(self.scene))

    def test_light_motion_rejections(self):
        invalid = [{"target": "$light:missing"}, {"target": "$light:off"}, {"kind": "rotate"}, {"kind": "scale"},
                   {"kind": "dolly"}, {"kind": "mechanical"}, {"axis": "x"}, {"kind": "aim", "target": "$product"},
                   {"kind": "aim", "target": "$camera"}, {"kind": "aim", "target": "cap"}, {"target": "$light:"}]
        for patch in invalid:
            with self.subTest(patch=patch):
                scene = copy.deepcopy(self.scene)
                scene["shots"][0]["motions"] = [{**self.light_motion(), **patch}]
                with self.assertRaises(ValueError):
                    validate_scene(scene)
        competing = [[self.light_motion(), self.light_motion(id="again")],
                     [self.light_motion("aim", axis="z"), self.light_motion("aim", id="again", axis="z")],
                     [self.light_motion("move", axis="x"), self.light_motion("move", id="again", axis="x")]]
        for motions in competing:
            with self.subTest(motions=motions):
                scene = copy.deepcopy(self.scene)
                scene["shots"][0]["motions"] = motions
                with self.assertRaisesRegex(ValueError, "competing owners"):
                    validate_scene(scene)
        scene = copy.deepcopy(self.scene)
        del scene["lighting"]
        scene["shots"][0]["motions"] = [self.light_motion()]
        with self.assertRaisesRegex(ValueError, "light does not exist"):
            validate_scene(scene)

    def test_validation_never_inserts_lighting_defaults(self):
        before = copy.deepcopy(self.scene)
        validate_scene(self.scene)
        self.assertEqual(self.scene, before)
        legacy = json.loads(EXAMPLE.read_text())
        validate_scene(legacy)
        self.assertNotIn("lighting", legacy)


if __name__ == "__main__":
    unittest.main()
