"""Scene-object relationships preserve contact, spacing and a valid DAG."""

import copy
import json
import math
from pathlib import Path
import unittest

from film.scene import evaluate, validate_scene
from film.scene_objects import resolve_scene_objects


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "bottle.scene.json"


class SceneObjectTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads(EXAMPLE.read_text())

    def assertVectorAlmostEqual(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=10)

    def prop(self, identity="table", **changes):
        value = {"id": identity, "name": identity.title(), "shape": "box", "sizeM": [0.4, 0.2, 0.3],
                 "translationM": [0.3, 0.1, -0.2], "rotationXyzw": [0, 0, 0, 1],
                 "material": copy.deepcopy(self.scene["product"]["components"][0]["material"])}
        value.update(changes)
        self.scene["environment"].setdefault("props", []).append(value)
        return value

    def no_plinth(self):
        self.scene["environment"]["plinth"]["visible"] = False
        self.scene["environment"]["floorY"] = 0
        self.scene["placement"]["restsOn"] = "floor"

    def mesh_world(self):
        sha = "a" * 64
        self.scene["environment"].update(kind="mesh", displayName="Test room", reviewStatus="unreviewed",
            asset={"sha256": sha, "path": f"assets/{sha}.glb", "format": "glb", "sourceUp": "Y",
                   "scaleToMeters": 1, "translationM": [0, 0, 0], "rotationXyzw": [0, 0, 0, 1]})

    def test_legacy_support_and_absolute_props_keep_their_exact_poses(self):
        prop = self.prop()
        self.scene["environment"]["plinth"]["translationM"] = [0.4, 0.165, -0.3]
        self.scene["placement"]["translationM"] = [0.01, 0.02, 0.03]
        before = copy.deepcopy(self.scene)
        result = resolve_scene_objects(self.scene)
        self.assertVectorAlmostEqual(result["product"]["translationM"], [0.41, 0.22, -0.27])
        self.assertVectorAlmostEqual(result["supportOriginM"], [0.4, 0.2, -0.3])
        self.assertAlmostEqual(result["floorY"], 0.13)
        self.assertEqual(result["props"]["table"]["translationM"], prop["translationM"])
        self.assertEqual(result["props"]["table"]["rotationXyzw"], prop["rotationXyzw"])
        self.assertEqual(self.scene, before)

    def test_hidden_plinth_is_never_a_prop_target_or_the_floor_support(self):
        self.no_plinth()
        self.scene["environment"]["plinth"]["translationM"] = [4, 7, 9]
        validate_scene(self.scene)
        result = resolve_scene_objects(self.scene)
        self.assertEqual(result["floorY"], 0)
        self.assertVectorAlmostEqual(result["product"]["translationM"], [0, 0, 0])
        self.prop("vase", relationship={"type": "on", "targetId": "plinth"})
        with self.assertRaisesRegex(ValueError, "Hidden plinth"):
            validate_scene(self.scene)

    def test_legacy_hidden_contact_plinth_keeps_the_product_in_place(self):
        # D93 campaigns rest on a hidden plinth. The merge keeps them valid: the
        # hidden plinth is an invisible floor at its top, the product contact.
        self.scene["environment"]["plinth"].update(visible=False, translationM=[0.2, -0.05, 0.1], sizeM=[0.3, 0.1, 0.3])
        visible = copy.deepcopy(self.scene)
        visible["environment"]["plinth"]["visible"] = True
        validate_scene(self.scene)
        hidden_result, visible_result = resolve_scene_objects(self.scene), resolve_scene_objects(visible)
        self.assertEqual(hidden_result["supportOriginM"], [0.2, 0.0, 0.1])
        self.assertEqual(hidden_result["product"], visible_result["product"])
        self.assertAlmostEqual(hidden_result["floorY"], 0)
        self.assertAlmostEqual(visible_result["floorY"], -0.1)
        self.assertEqual(evaluate(self.scene, 1)["components"], evaluate(visible, 1)["components"])

    def test_floor_height_is_explicit_or_falls_back_to_visible_plinth_bottom(self):
        self.scene["placement"]["restsOn"] = "floor"
        result = resolve_scene_objects(self.scene)
        self.assertAlmostEqual(result["floorY"], -0.07)
        self.assertAlmostEqual(result["product"]["translationM"][1], -0.07)
        self.scene["environment"]["floorY"] = 0.25
        result = resolve_scene_objects(self.scene)
        self.assertAlmostEqual(result["product"]["translationM"][1], 0.25)
        del self.scene["environment"]["floorY"]
        self.scene["environment"]["plinth"]["visible"] = False
        self.assertEqual(resolve_scene_objects(self.scene)["floorY"], 0)

    def test_product_follows_a_support_prop_which_follows_the_floor(self):
        self.no_plinth()
        table = self.prop(relationship={"type": "on", "targetId": "floor", "offsetM": [0.3, 0, -0.2]})
        self.scene["placement"]["restsOn"] = "table"
        validate_scene(self.scene)
        first = resolve_scene_objects(self.scene)
        self.assertVectorAlmostEqual(first["product"]["translationM"], [0.3, 0.2, -0.2])
        self.scene["environment"]["floorY"] = 0.4
        table["sizeM"][1] = 0.5
        second = resolve_scene_objects(self.scene)
        self.assertVectorAlmostEqual(second["product"]["translationM"], [0.3, 0.9, -0.2])
        self.assertAlmostEqual(second["props"]["table"]["boundsM"][0][1], 0.4)

    def test_on_relationship_uses_rotated_subject_bottom_gap_and_offset(self):
        self.no_plinth()
        angle = math.pi/4
        self.prop("leaning", sizeM=[0.4, 0.2, 0.3], rotationXyzw=[0, 0, math.sin(angle/2), math.cos(angle/2)],
                  relationship={"type": "on", "targetId": "floor", "gapM": 0.015, "offsetM": [0.2, 0.03, -0.4]})
        validate_scene(self.scene)
        result = resolve_scene_objects(self.scene)["props"]["leaning"]
        self.assertAlmostEqual(result["boundsM"][0][1], 0.045)
        self.assertAlmostEqual(result["translationM"][0], 0.2)
        self.assertAlmostEqual(result["translationM"][2], -0.4)

    def test_nested_objects_resolve_independently_of_document_order(self):
        self.no_plinth()
        self.prop("book", sizeM=[0.1, 0.03, 0.07], relationship={"type": "on", "targetId": "table"})
        self.prop("table", relationship={"type": "on", "targetId": "floor"})
        resolved = resolve_scene_objects(self.scene)
        self.assertAlmostEqual(resolved["props"]["book"]["boundsM"][0][1], 0.2)
        self.scene["environment"]["props"].reverse()
        self.assertEqual(resolve_scene_objects(self.scene), resolved)

    def test_side_relationships_clear_rotated_target_bounds_in_world_axes(self):
        self.no_plinth()
        target = self.prop("table", sizeM=[0.4, 0.2, 0.1],
                           rotationXyzw=[0, math.sqrt(0.5), 0, math.sqrt(0.5)])
        for identity, kind in (("right", "beside"), ("front", "inFrontOf"), ("back", "behind")):
            self.prop(identity, sizeM=[0.08, 0.12, 0.06],
                      relationship={"type": kind, "targetId": target["id"], "gapM": 0.025})
        validate_scene(self.scene)
        result = resolve_scene_objects(self.scene)["props"]
        target_low, target_high = result["table"]["boundsM"]
        self.assertAlmostEqual(result["right"]["boundsM"][0][0]-target_high[0], 0.025)
        self.assertAlmostEqual(result["front"]["boundsM"][0][2]-target_high[2], 0.025)
        self.assertAlmostEqual(target_low[2]-result["back"]["boundsM"][1][2], 0.025)
        for identity in ("right", "front", "back"):
            self.assertAlmostEqual(result[identity]["boundsM"][0][1], target_low[1])

    def test_product_yaw_rotates_component_assembly_and_local_actions(self):
        self.no_plinth()
        self.scene["placement"].update(rotationYDegrees=90, translationM=[1, 0, 3])
        self.scene["actions"][0]["axis"] = [1, 0, 0]
        validate_scene(self.scene)
        result = resolve_scene_objects(self.scene)
        first, last = evaluate(self.scene, 1), evaluate(self.scene, 360)
        self.assertVectorAlmostEqual(result["product"]["translationM"], [1, 0, 3])
        self.assertVectorAlmostEqual(first["components"]["cap"]["rotationXyzw"],
                                     [0, math.sqrt(0.5), 0, math.sqrt(0.5)])
        self.assertVectorAlmostEqual(last["components"]["cap"]["translationM"], [1, 0.1245, 2.945])
        low, high = result["product"]["boundsM"]
        self.assertAlmostEqual(high[2]-low[2], 0.062)
        self.assertAlmostEqual(high[0]-low[0], 0.0386)

    def test_product_root_keeps_off_center_cad_coordinates(self):
        self.no_plinth()
        self.scene["actions"] = []
        for component in self.scene["product"]["components"]:
            component["assembly"]["translationM"][0] += 0.5
            component["assembly"]["translationM"][1] += 0.1
        result = resolve_scene_objects(self.scene)
        self.assertVectorAlmostEqual(result["product"]["translationM"], [0, 0, 0])
        self.assertAlmostEqual(result["product"]["boundsM"][0][0], 0.469)
        self.assertAlmostEqual(result["product"]["boundsM"][0][1], 0.1)

    def test_objects_related_to_product_follow_the_rigid_assembly_not_animated_cap(self):
        self.no_plinth()
        self.prop("sample", sizeM=[0.01, 0.01, 0.01], relationship={"type": "on", "targetId": "product"})
        validate_scene(self.scene)
        first, last = evaluate(self.scene, 1), evaluate(self.scene, 360)
        self.assertNotEqual(first["components"]["cap"], last["components"]["cap"])
        self.assertEqual(first["props"], last["props"])
        self.assertAlmostEqual(first["props"]["sample"]["boundsM"][0][1], 0.137)
        self.scene["placement"]["translationM"][0] = 0.4
        self.assertAlmostEqual(evaluate(self.scene, 1)["props"]["sample"]["translationM"][0], 0.4)

    def test_mesh_world_support_uses_picked_canonical_point_without_world_transform(self):
        self.no_plinth()
        self.mesh_world()
        self.scene["environment"]["asset"].update(translationM=[100, 200, 300], scaleToMeters=20)
        self.scene["placement"].update(restsOn="world-surface", contactPointM=[1, 0.8, -2], translationM=[0.1, 0.02, -0.1])
        validate_scene(self.scene)
        result = resolve_scene_objects(self.scene)
        self.assertVectorAlmostEqual(result["supportOriginM"], [1, 0.8, -2])
        self.assertVectorAlmostEqual(result["product"]["translationM"], [1.1, 0.82, -2.1])
        self.scene["environment"]["asset"]["translationM"] = [-7, -8, -9]
        self.assertEqual(resolve_scene_objects(self.scene), result)

    def test_world_contact_requires_mesh_and_a_finite_picked_point(self):
        self.no_plinth()
        self.scene["placement"].update(restsOn="world-surface", contactPointM=[0, 0, 0])
        with self.assertRaisesRegex(ValueError, "mesh environment"):
            validate_scene(self.scene)
        self.mesh_world()
        for point in (None, [0, 0], [0, float("nan"), 0], [0, True, 0]):
            self.scene["placement"]["contactPointM"] = point
            with self.subTest(point=point), self.assertRaises(ValueError):
                validate_scene(self.scene)

    def test_unknown_hidden_and_component_targets_are_rejected(self):
        self.no_plinth()
        self.prop("hidden", visible=False)
        prop = self.prop("child")
        for identity in ("missing", "hidden", "plinth", "cap", "world-surface"):
            prop["relationship"] = {"type": "on", "targetId": identity}
            with self.subTest(target=identity), self.assertRaises(ValueError):
                validate_scene(self.scene)
        del prop["relationship"]
        for identity in ("missing", "hidden", "cap"):
            self.scene["placement"]["restsOn"] = identity
            with self.subTest(product_support=identity), self.assertRaises(ValueError):
                validate_scene(self.scene)

    def test_cycles_including_product_support_and_self_reference_are_rejected(self):
        self.no_plinth()
        table = self.prop("table", relationship={"type": "on", "targetId": "product"})
        self.scene["placement"]["restsOn"] = "table"
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_scene(self.scene)
        self.scene["placement"]["restsOn"] = "floor"
        table["relationship"]["targetId"] = "child"
        child = self.prop("child", relationship={"type": "beside", "targetId": "table"})
        with self.assertRaisesRegex(ValueError, "cycle"):
            validate_scene(self.scene)
        child["relationship"]["targetId"] = "child"
        with self.assertRaisesRegex(ValueError, "itself"):
            validate_scene(self.scene)

    def test_tilted_support_rejects_on_but_allows_side_relationships(self):
        self.no_plinth()
        self.prop("tilted", rotationXyzw=[0, 0, math.sin(math.pi/8), math.cos(math.pi/8)])
        child = self.prop("child", relationship={"type": "on", "targetId": "tilted"})
        with self.assertRaisesRegex(ValueError, "horizontal"):
            validate_scene(self.scene)
        child["relationship"]["type"] = "beside"
        validate_scene(self.scene)
        self.scene["placement"]["restsOn"] = "tilted"
        with self.assertRaisesRegex(ValueError, "horizontal"):
            validate_scene(self.scene)

    def test_reserved_ids_and_component_collisions_are_rejected(self):
        self.no_plinth()
        prop = self.prop()
        for identity in ("product", "floor", "world-surface", "bottle-body", "plinth"):
            prop["id"] = identity
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, "Prop IDs"):
                validate_scene(self.scene)

    def test_prop_id_support_origin_does_not_collide_with_resolver_metadata(self):
        self.no_plinth()
        self.prop("supportOriginM")
        resolved = resolve_scene_objects(self.scene)
        self.assertIn("boundsM", resolved["props"]["supportOriginM"])
        self.assertEqual(resolved["supportOriginM"], [0, 0, 0])

    def test_invalid_relationship_values_and_visibility_are_rejected(self):
        self.no_plinth()
        prop = self.prop()
        valid = {"type": "on", "targetId": "floor"}
        for key, value in (("type", "inside"), ("targetId", None), ("gapM", -0.1),
                           ("gapM", True), ("gapM", float("inf")), ("offsetM", [0, 0]),
                           ("offsetM", [0, float("nan"), 0]), ("offsetM", [0, True, 0])):
            prop["relationship"] = {**valid, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_scene(self.scene)
        prop["relationship"] = {"type": "beside", "targetId": "floor"}
        with self.assertRaisesRegex(ValueError, "Floor supports only"):
            validate_scene(self.scene)
        del prop["relationship"]
        for record in (prop, self.scene["environment"]["plinth"]):
            record["visible"] = 1
            with self.assertRaisesRegex(ValueError, "visible must be boolean"):
                validate_scene(self.scene)
            record["visible"] = True

    def test_invalid_floor_height_and_product_yaw_are_rejected(self):
        self.no_plinth()
        for value in (float("nan"), float("inf"), True, "0"):
            self.scene["environment"]["floorY"] = value
            with self.subTest(floorY=value), self.assertRaises(ValueError):
                validate_scene(self.scene)
        self.scene["environment"]["floorY"] = 0
        for value in (float("nan"), float("inf"), True, "90"):
            self.scene["placement"]["rotationYDegrees"] = value
            with self.subTest(rotationYDegrees=value), self.assertRaises(ValueError):
                validate_scene(self.scene)


if __name__ == "__main__":
    unittest.main()
