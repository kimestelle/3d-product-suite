"""Prepared product handoff preserves bytes, validates geometry and pins assets."""

import copy
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from film import jobs, products, worlds
from film.scene import evaluate, load_scene, validate_scene
from film.store import ProjectStore
from tests.test_worlds import glb_bytes, glb_document, PROVENANCE


ROOT = Path(__file__).resolve().parents[1]


def product_glb(*, change=None, positions=None):
    # Two opposing triangles span a small centered rigid product's bounds.
    positions = positions if positions is not None else [
        -0.03, -0.06, -0.02, 0.03, -0.06, -0.02, 0.03, 0.06, -0.02,
        -0.03, -0.06, 0.02, 0.03, 0.06, 0.02, -0.03, 0.06, 0.02,
    ]
    binary = struct.pack("<" + "f" * len(positions), *positions)
    document = glb_document()
    document["buffers"][0]["byteLength"] = len(binary)
    document["bufferViews"][0]["byteLength"] = len(binary)
    document["accessors"][0]["count"] = len(positions) // 3
    document["materials"] = [{"name": "Approved original finish", "pbrMetallicRoughness": {
        "baseColorFactor": [0.12, 0.4, 0.6, 1], "metallicFactor": 0.1, "roughnessFactor": 0.3}}]
    document["meshes"][0]["name"] = "Prepared original product"
    document["meshes"][0]["primitives"][0]["material"] = 0
    if change:
        change(document)
    return glb_bytes(document, binary)


class ProductTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "prepared-product.glb"
        self.source.write_bytes(product_glb())
        self.output = self.root / "product-scene"
        # Keep renderer snapshot tests independent of concurrent adapter edits.
        renderer = self.root / "renderer.py"
        renderer.write_bytes(jobs._RENDERER.read_bytes())
        patcher = patch.object(jobs, "_RENDERER", renderer)
        patcher.start()
        self.addCleanup(patcher.stop)

    def create(self, **kwargs):
        return products.create_product_scene(self.source, self.output, name="Prepared product", provenance=PROVENANCE, **kwargs)

    def test_import_preserves_exact_geometry_and_artwork_without_fictional_mechanism(self):
        payload = self.source.read_bytes()
        measured = products.inspect_product_glb(payload)
        self.assertEqual(measured["vertexCount"], 6)
        for actual, expected in zip(measured["dimensionsM"], [0.06, 0.12, 0.04]):
            self.assertAlmostEqual(actual, expected, places=7)
        scene = self.create(metadata={"sourceDocument": "approved drawing v2", "sourceMedia": ["reference-front.jpg"]})
        self.assertFalse(scene["environment"]["plinth"]["visible"])
        self.assertEqual(scene["placement"]["restsOn"], "floor")
        self.assertEqual(scene, load_scene(self.output / "scene.json"))
        self.assertNotIn("label", scene["product"])
        self.assertEqual(scene["actions"], [])
        self.assertEqual(scene["evidence"], [])
        self.assertEqual(scene["product"]["provenance"], PROVENANCE)
        self.assertEqual(scene["product"]["metadata"]["sourceDocument"], "approved drawing v2")
        component = scene["product"]["components"][0]
        self.assertEqual(component["shape"], "mesh")
        self.assertFalse(component["materialOverride"])
        asset = component["asset"]
        self.assertEqual(asset, {"format": "glb", "path": f"assets/{hashlib.sha256(payload).hexdigest()}.glb",
                                 "sha256": hashlib.sha256(payload).hexdigest(), "sourceUp": "Y"})
        self.assertEqual((self.output / asset["path"]).read_bytes(), payload)
        self.assertAlmostEqual(evaluate(scene, 1)["components"]["product"]["translationM"][1], 0.06, places=7)
        for shot in scene["shots"]:
            self.assertAlmostEqual(shot["camera"]["from"]["targetM"][1], 0.06, places=7)
            self.assertGreater(shot["camera"]["from"]["positionM"][2], 0.3)

    def test_scene_creation_is_idempotent_and_refuses_another_source_revision(self):
        first = self.create()
        self.assertEqual(self.create(), first)
        self.source.write_bytes(product_glb(change=lambda d: d["materials"][0].update(name="New finish")))
        with self.assertRaisesRegex(ValueError, "Existing product scene differs"):
            self.create()
        self.assertEqual(load_scene(self.output / "scene.json"), first)
        self.assertEqual(len(list((self.output / "assets").glob("*.glb"))), 1)

    def test_library_import_keeps_multiple_immutable_product_entries(self):
        library = self.root / "library"
        first = products.import_product(self.source, library, name="Finish A", provenance=PROVENANCE)
        again = products.import_product(self.source, library, name="Finish A", provenance=PROVENANCE)
        second = products.import_product(self.source, library, name="Finish B", provenance=PROVENANCE)
        self.assertEqual(first, again)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(list((library / "products").glob("*.json"))), 2)
        self.assertEqual(len(list((library / "assets").glob("*.glb"))), 1)
        self.assertEqual(json.loads((library / "products" / f"{first['id']}.json").read_text()), first)

    def test_measured_bounds_ignore_accessor_metadata_and_apply_static_node_transforms(self):
        spoofed = product_glb(change=lambda d: d["accessors"][0].update(min=[0, 0, 0], max=[100, 100, 100]))
        self.assertEqual(products.inspect_product_glb(spoofed), products.inspect_product_glb(self.source.read_bytes()))
        def transformed(document):
            document["nodes"][0].update(scale=[2, 1, 1], translation=[0.1, 0, 0])
            document["nodes"].append({"translation": [-0.1, 0, 0], "children": [0]})
            document["scenes"][0]["nodes"] = [1]
        measured = products.inspect_product_glb(product_glb(change=transformed))
        self.assertAlmostEqual(measured["dimensionsM"][0], 0.12, places=7)

    def test_dimensions_and_bounds_must_match_actual_geometry(self):
        self.create(dimensions_m=[0.06, 0.12, 0.04], bounds_m=[[-0.03, -0.06, -0.02], [0.03, 0.06, 0.02]])
        for kwargs in ({"dimensions_m": [6, 12, 4]}, {"dimensions_m": [0, 0.12, 0.04]},
                       {"bounds_m": [[0, 0, 0], [0.06, 0.12, 0.04]]}):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, "match"):
                self.create(**kwargs)

    def test_unprepared_or_hidden_geometry_is_rejected_before_writing(self):
        cases = [
            lambda d: d["nodes"][0].update(translation=[0.1, 0, 0]),
            lambda d: d["nodes"][0].update(scale=[1, 1, 0]),
            lambda d: d["nodes"][0].update(mesh=20),
            lambda d: d["nodes"][0].update(children=[0]),
            lambda d: d["scenes"].append({"nodes": []}),
            lambda d: d["nodes"].append({"mesh": 0}),
            lambda d: d.update(animations=[{}]),
            lambda d: d.update(skins=[{}]),
            lambda d: d.update(cameras=[{}]),
            lambda d: d["nodes"][0].update(camera=0),
            lambda d: d["nodes"][0].update(skin=0),
            lambda d: d["meshes"][0]["primitives"][0].update(targets=[{"POSITION": 0}]),
            lambda d: d["meshes"][0]["primitives"][0].update(mode=0),
            lambda d: d["meshes"][0]["primitives"][0].update(indices=0),
            lambda d: d["meshes"][0]["primitives"][0].update(extensions={"KHR_draco_mesh_compression": {}}),
            lambda d: d["bufferViews"][0].update(extensions={"EXT_meshopt_compression": {}}),
            lambda d: d["accessors"][0].update(sparse={"count": 1}),
            lambda d: d["accessors"][0].update(type="VEC2"),
            lambda d: d["buffers"][0].update(uri="https://example.invalid/secret.bin"),
            lambda d: d.update(extensions={"KHR_lights_punctual": {"lights": [{}]}}),
        ]
        for index, change in enumerate(cases):
            with self.subTest(case=index), self.assertRaises(ValueError):
                products.inspect_product_glb(product_glb(change=change))
        nonfinite = [-0.03, -0.06, -0.02, 0.03, -0.06, -0.02, 0.03, 0.06, float("nan"),
                     -0.03, -0.06, 0.02, 0.03, 0.06, 0.02, -0.03, 0.06, 0.02]
        with self.assertRaisesRegex(ValueError, "finite"):
            products.inspect_product_glb(product_glb(positions=nonfinite))
        with self.assertRaisesRegex(ValueError, "nonzero"):
            products.inspect_product_glb(product_glb(positions=[0, -0.1, 0, 0, 0.1, 0, 0, 0, 0.1]))
        self.assertFalse(self.output.exists())

    def test_mesh_contract_rejects_ambiguous_asset_transforms_and_artwork_replacement(self):
        scene = self.create()
        cases = [("sourceUp", "Z"), ("format", "ply"), ("path", "../private.glb"),
                 ("sha256", "X" * 64), ("scaleToMeters", 1)]
        for key, value in cases:
            invalid = copy.deepcopy(scene)
            invalid["product"]["components"][0]["asset"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_scene(invalid)
        for key, value in (("materialOverride", "false"), ("bevelM", 0.001)):
            invalid = copy.deepcopy(scene)
            invalid["product"]["components"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_scene(invalid)
        scene["product"]["label"] = {"componentId": "product", "text": "MORA", "subtitle": "fictional"}
        with self.assertRaisesRegex(ValueError, "artwork"):
            validate_scene(scene)

    def test_product_and_environment_assets_bundle_together_and_reject_corruption(self):
        scene = self.create()
        world = self.root / "visual-room.glb"
        world.write_bytes(glb_bytes())
        entry = worlds.import_world(world, self.output, name="Room", provenance=PROVENANCE)
        scene["environment"] = entry["environment"]
        destination = self.root / "bundle"
        records = worlds.bundle_assets(scene, self.output, destination)
        self.assertEqual(len(records), 2)
        self.assertEqual(worlds.verify_scene_assets(scene, destination), records)
        for record in records:
            self.assertEqual((destination / record["path"]).read_bytes(), (self.output / record["path"]).read_bytes())
        invalid = copy.deepcopy(scene)
        invalid["product"]["components"][0]["sizeM"][0] *= 2
        with self.assertRaisesRegex(ValueError, "dimensions do not match"):
            worlds.verify_scene_assets(invalid, destination)
        (destination / scene["product"]["components"][0]["asset"]["path"]).write_bytes(b"tampered product")
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            worlds.verify_scene_assets(scene, destination)

    def test_project_copy_and_render_jobs_keep_pinned_product_assets(self):
        scene = self.create()
        store = ProjectStore(self.root / "data")
        project = store.create("Real asset campaign", scene, source_dir=self.output)
        duplicate = store.create("Campaign copy", project["scene"])
        self.assertNotEqual(project["id"], duplicate["id"])
        self.assertEqual(project["scene"], duplicate["scene"])
        asset = scene["product"]["components"][0]["asset"]
        self.assertEqual((store.root / asset["path"]).read_bytes(), self.source.read_bytes())
        source = store.scene_source(scene)
        output = self.root / "job"
        job = jobs.create_job(source, output, width=144, height=256, samples=1)
        self.assertEqual(len(job["assets"]), 1)
        (store.root / asset["path"]).unlink()
        self.assertEqual(jobs._verify_snapshots(output, job), scene)
        with self.assertRaisesRegex(ValueError, "Cannot read"):
            store.get(project["id"])

    def test_project_save_cannot_pin_a_missing_or_changed_asset(self):
        scene = self.create()
        store = ProjectStore(self.root / "data")
        project = store.create("First", scene, source_dir=self.output)
        asset = scene["product"]["components"][0]["asset"]
        (store.root / asset["path"]).write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            store.save(project["id"], scene, project["revisionId"])
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            store.scene_source(scene)


if __name__ == "__main__":
    unittest.main()
