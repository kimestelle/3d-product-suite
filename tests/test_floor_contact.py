"""The authored floor and contact shadow sit where the product touches down.

With a hidden plinth (D93) or a product on the floor, the curved sweep and the
splat shadow catcher must be at the product's contact height. Only a visible
plinth stands on a floor at its own bottom. These checks run the real Blender
adapter functions with a small host adapter, so Blender need not be installed.
"""
import ast
import copy
import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest

from film.scene import evaluate, validate_scene
from film.scene_objects import floor_height, resolve_scene_objects

ROOT = Path(__file__).resolve().parents[1]
HELPERS = ("vertical_half_extent", "authored_floor_height", "product_support_origin", "product_support_height",
           "sampled_product_origin", "studio_rig_origin", "environment")


class HostObject(SimpleNamespace):
    """A Blender object stand-in that also accepts custom properties."""
    def __setitem__(self, key, value):
        setattr(self, f"property_{key}", value)


def adapter():
    """Execute the adapter's floor helpers and environment() with recording fakes."""
    source = ast.parse((ROOT / "scripts/blender_scene.py").read_text())
    functions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in HELPERS]
    meshes = {}

    def new_mesh(name):
        mesh = SimpleNamespace(name=name, polygons=[], materials=[], update=lambda: None)
        mesh.from_pydata = lambda vertices, edges, faces: setattr(mesh, "vertices", vertices)
        meshes[name] = mesh
        return mesh

    def new_object(name, data):
        return HostObject(name=name, data=data, location=None)

    bpy = SimpleNamespace(
        data=SimpleNamespace(meshes=SimpleNamespace(new=new_mesh), objects=SimpleNamespace(new=new_object, get=lambda _: None)),
        context=SimpleNamespace(collection=SimpleNamespace(objects=SimpleNamespace(link=lambda _: None))))
    namespace = {"bpy": bpy, "math": math, "material": lambda *args: None, "specified_material": lambda *args: None,
                 "primitive": lambda *args: HostObject(location=None),
                 "blender_position": lambda p: (p[0], -p[2], p[1]), "blender_rotation": lambda q: q,
                 "area_light": lambda *args: {}, "spot_light": lambda *args: {}}
    exec(compile(ast.Module(body=functions, type_ignores=[]), "<blender_scene>", "exec"), namespace)
    return namespace, meshes


class FloorContactTests(unittest.TestCase):
    def setUp(self):
        # A teapot-sized product on a 10 cm plinth whose top is the world origin.
        self.scene = json.loads((ROOT / "examples/bottle.scene.json").read_text())
        self.scene["environment"]["plinth"].update(sizeM=[0.3, 0.1, 0.3], translationM=[0, -0.05, 0], visible=False)
        self.scene["lighting"] = {"ambientStrength": .45, "lights": [
            {"id": "key", "name": "Key", "enabled": True, "positionM": [-.2, .3, .24], "targetM": [0, .07, 0],
             "powerW": 2.6, "diameterM": .23, "color": [1, .93, .82]}]}
        validate_scene(self.scene)

    def product_bottom(self, scene):
        sample = evaluate(scene, 1)
        return min(sample["components"][c["id"]]["translationM"][1] - c["sizeM"][1] / 2
                   for c in scene["product"]["components"])

    def sweep_floor(self, scene):
        namespace, meshes = adapter()
        namespace["environment"](scene, None, evaluate(scene, 1))
        # Blender Z is canonical Y; the flat run of the sweep is its lowest row,
        # kept 0.1 mm under the floor so it never coincides with a resting base.
        return min(vertex[2] for vertex in meshes["Set / curved sweep mesh"].vertices) + 0.0001

    def test_hidden_plinth_floor_meets_the_product(self):
        contact = self.product_bottom(self.scene)
        self.assertAlmostEqual(contact, 0)
        self.assertAlmostEqual(floor_height(self.scene), contact)
        self.assertAlmostEqual(resolve_scene_objects(self.scene)["floorY"], contact)
        namespace, _ = adapter()
        self.assertAlmostEqual(namespace["authored_floor_height"](self.scene), contact)
        self.assertAlmostEqual(namespace["product_support_height"](self.scene), contact)
        # Previously the sweep sat at the plinth bottom: 10 cm below the product.
        self.assertAlmostEqual(self.sweep_floor(self.scene), contact)

    def test_visible_plinth_keeps_its_floor_at_the_plinth_bottom(self):
        self.scene["environment"]["plinth"]["visible"] = True
        namespace, _ = adapter()
        self.assertAlmostEqual(self.product_bottom(self.scene), 0)
        self.assertAlmostEqual(floor_height(self.scene), -0.1)
        self.assertAlmostEqual(namespace["authored_floor_height"](self.scene), -0.1)
        self.assertAlmostEqual(namespace["product_support_height"](self.scene), 0)
        self.assertAlmostEqual(self.sweep_floor(self.scene), -0.1)

    def test_product_on_the_floor_and_explicit_floor_height(self):
        self.scene["placement"]["restsOn"] = "floor"
        self.scene["environment"]["floorY"] = 0.25
        validate_scene(self.scene)
        namespace, _ = adapter()
        self.assertAlmostEqual(self.product_bottom(self.scene), 0.25)
        self.assertAlmostEqual(namespace["product_support_height"](self.scene), 0.25)
        self.assertAlmostEqual(self.sweep_floor(self.scene), 0.25)

    def test_rotated_plinths_use_their_world_bounds(self):
        # A yawed hidden plinth keeps its top; a visible plinth turned on its
        # side stands on a floor at its rotated bottom.
        angle = math.pi / 4
        self.scene["environment"]["plinth"]["rotationXyzw"] = [0, math.sin(angle / 2), 0, math.cos(angle / 2)]
        validate_scene(self.scene)
        namespace, _ = adapter()
        self.assertAlmostEqual(self.product_bottom(self.scene), 0)
        self.assertAlmostEqual(floor_height(self.scene), 0)
        self.assertAlmostEqual(namespace["authored_floor_height"](self.scene), 0)
        self.assertAlmostEqual(namespace["product_support_height"](self.scene), 0)
        angle = math.pi / 2
        self.scene["environment"]["plinth"].update(visible=True, rotationXyzw=[0, 0, math.sin(angle / 2), math.cos(angle / 2)])
        self.scene["placement"]["restsOn"] = "floor"
        validate_scene(self.scene)
        bottom = -0.05 - 0.15
        self.assertAlmostEqual(floor_height(self.scene), bottom)
        self.assertAlmostEqual(namespace["authored_floor_height"](self.scene), bottom)
        self.assertAlmostEqual(self.product_bottom(self.scene), bottom)

    def test_prop_support_uses_the_sampled_prop_top(self):
        material = copy.deepcopy(self.scene["product"]["components"][0]["material"])
        self.scene["environment"]["floorY"] = 0
        self.scene["environment"]["props"] = [{"id": "stone", "shape": "box", "sizeM": [.2, .08, .2],
            "translationM": [0, 0, 0], "rotationXyzw": [0, 0, 0, 1], "material": material,
            "relationship": {"type": "on", "targetId": "floor", "offsetM": [.1, 0, 0]}}]
        self.scene["placement"]["restsOn"] = "stone"
        validate_scene(self.scene)
        namespace, _ = adapter()
        sample = evaluate(self.scene, 1)
        self.assertAlmostEqual(namespace["product_support_height"](self.scene, sample), 0.08)
        self.assertAlmostEqual(self.product_bottom(self.scene), 0.08)
        self.assertAlmostEqual(self.sweep_floor(self.scene), 0)

    def test_studio_rig_keeps_the_plinth_rule_and_anchors_other_supports(self):
        # D127: on its plinth, a fixed studio anchors at the plinth top and a legacy
        # rig at the authored placement. Other supports anchor a fixed studio to
        # their own top (D160), matching the viewport and world.ts rigOrigin.
        namespace, _ = adapter()
        rig = namespace["studio_rig_origin"]
        self.scene["placement"]["translationM"] = [.02, 0, -.01]
        self.assertEqual(rig(self.scene), [.02, 0, -.01])
        self.scene["environment"]["studioSizeM"] = .32
        self.scene["environment"]["plinth"]["translationM"] = [.1, -.05, .2]
        self.assertEqual(rig(self.scene), [.1, 0, .2])
        self.scene["placement"]["restsOn"] = "floor"
        self.scene["environment"]["floorY"] = .25
        self.assertEqual(rig(self.scene), [0, .25, 0])
        material = copy.deepcopy(self.scene["product"]["components"][0]["material"])
        self.scene["environment"]["props"] = [{"id": "stone", "shape": "box", "sizeM": [.2, .08, .2],
            "translationM": [.3, .29, 0], "rotationXyzw": [0, 0, 0, 1], "material": material}]
        self.scene["placement"]["restsOn"] = "stone"
        validate_scene(self.scene)
        for actual, expected in zip(rig(self.scene, evaluate(self.scene, 1)), [.3, .33, 0]):
            self.assertAlmostEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
