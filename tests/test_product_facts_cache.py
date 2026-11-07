"""Reuse geometry facts without weakening file or scene validation."""
from collections import OrderedDict
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from film import products, worlds
from tests.test_products import product_glb


class ProductFactsCacheTests(unittest.TestCase):
    def setUp(self):
        self.cache = OrderedDict()
        patcher = patch.object(products, "_FACT_CACHE", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.payload = product_glb()

    def test_returned_measurements_and_hierarchy_cannot_change_cached_truth(self):
        expected = products.inspect_product_glb(self.payload)
        nodes = products.product_source_nodes(self.payload)
        expected_nodes = copy.deepcopy(nodes)
        measurements = products.inspect_product_glb(self.payload)
        measurements["boundsM"][0][0] = 100
        nodes[0]["boundsM"][0][0] = 100
        self.assertEqual(products.inspect_product_glb(self.payload), expected)
        self.assertEqual(products.product_source_nodes(self.payload), expected_nodes)
        component = {"sourceNodes": nodes}
        with self.assertRaisesRegex(ValueError, "immutable product"):
            products.validate_product_source_nodes(component, self.payload)
        with self.assertRaisesRegex(ValueError, "dimensions"):
            products.validate_product_dimensions(expected, [1, 1, 1])

    def test_changed_bytes_have_independent_measured_geometry(self):
        first = products.inspect_product_glb(self.payload)
        different = product_glb(positions=[-.06, -.12, -.04, .06, -.12, -.04, .06, .12, -.04,
                                          -.06, -.12, .04, .06, .12, .04, -.06, .12, .04])
        second = products.inspect_product_glb(different)
        self.assertEqual(second["dimensionsM"], [value * 2 for value in first["dimensionsM"]])
        self.assertEqual(products.inspect_product_glb(self.payload), first)

    def test_warm_geometry_facts_do_not_hide_tampered_asset_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = hashlib.sha256(self.payload).hexdigest()
            asset = {"path": f"assets/{digest}.glb", "sha256": digest, "format": "glb", "sourceUp": "Y"}
            path = root / asset["path"]
            path.parent.mkdir()
            path.write_bytes(self.payload)
            dimensions = products.inspect_product_glb(self.payload)["dimensionsM"]
            scene = {"environment": {"kind": "authored"}, "product": {"components": [
                {"id": "product", "shape": "mesh", "asset": asset, "sizeM": dimensions}]}}
            worlds.verify_scene_assets(scene, root)
            changed = bytearray(self.payload)
            changed[-1] ^= 1
            path.write_bytes(changed)
            with self.assertRaisesRegex(ValueError, "hash does not match"):
                worlds.verify_scene_assets(scene, root)

    def test_failures_are_not_cached(self):
        invalid = product_glb(positions=[0, -.1, 0, 0, .1, 0, 0, 0, .1])
        for _ in range(2):
            with self.assertRaises(ValueError):
                products.inspect_product_glb(invalid)
        self.assertFalse(self.cache)

    def test_cache_bounds_and_eviction_retain_only_small_facts(self):
        with patch.object(products, "_FACT_CACHE_MAX_ENTRIES", 1):
            products.inspect_product_glb(self.payload)
            products.product_source_nodes(self.payload)
            self.assertEqual(len(self.cache), 1)
        for facts, _ in self.cache.values():
            self.assertNotIsInstance(facts, (bytes, bytearray, memoryview))
        self.cache.clear()
        with patch.object(products, "_FACT_CACHE_MAX_RECORD_BYTES", 1):
            products.inspect_product_glb(self.payload)
            products.product_source_nodes(self.payload)
        self.assertFalse(self.cache)
        with patch.object(products, "_FACT_CACHE_MAX_BYTES", 1):
            products.inspect_product_glb(self.payload)
        self.assertFalse(self.cache)
