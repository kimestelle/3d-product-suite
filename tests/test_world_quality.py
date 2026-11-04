"""Measured world diagnostics and camera-safe presets; no provider requests."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

from PIL import Image

from film.world_quality import inspect_visual_world
from film.world_requests import DEFAULT_ENVIRONMENTS, generation_identity
from film.scene import evaluate, load_scene, scene_digest, validate_scene
from tests.test_jobs import png_bytes
from tests.test_worlds import glb_bytes, glb_document


def textured_world(*, width=4096, height=2048, uv=True, image=None, texcoord=0):
    document = glb_document()
    # Accessors without bufferViews represent zero-initialized attributes. The
    # triangle itself uses the fixture's real position bytes.
    document["accessors"].append({"componentType": 5126, "count": 3, "type": "VEC2"})
    primitive = document["meshes"][0]["primitives"][0]
    if uv:
        primitive["attributes"][f"TEXCOORD_{texcoord}"] = 1
    primitive["material"] = 0
    document["materials"] = [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0, "texCoord": texcoord}}}]
    document["textures"] = [{"source": 0}]
    document["images"] = [{"uri": "data:image/png;base64," + base64.b64encode(
        png_bytes(width, height) if image is None else image).decode()}]
    return document


class WorldQualityTests(unittest.TestCase):
    def test_inspects_real_texture_headers_without_decoding_or_rewriting_asset(self):
        payload = glb_bytes(textured_world())
        digest = hashlib.sha256(payload).hexdigest()
        with patch.object(Image.Image, "load", side_effect=AssertionError("must not decode room textures")):
            quality = inspect_visual_world(payload)
        self.assertEqual(hashlib.sha256(payload).hexdigest(), digest)
        self.assertEqual(quality["triangleCount"], 1)
        self.assertEqual(quality["texturedTriangleCount"], 1)
        self.assertEqual(quality["usedColourImageCount"], 1)
        self.assertEqual(quality["maxColourTextureEdge"], 4096)
        self.assertEqual(quality["usedColourDecodedRgbaBytes"], 4096 * 2048 * 4)
        self.assertEqual(quality["warnings"], [])

    def test_only_actual_uv_mapped_used_images_count_toward_source_detail(self):
        document = textured_world(width=64, height=32, uv=False)
        document["images"].append({"uri": "data:image/png;base64," + base64.b64encode(png_bytes(4096, 1)).decode()})
        quality = inspect_visual_world(glb_bytes(document))
        self.assertEqual(quality["imageCount"], 2)
        self.assertEqual(quality["usedColourImageCount"], 0)
        self.assertEqual(quality["maxColourTextureEdge"], 0)
        self.assertTrue(any("matching UV" in note for note in quality["warnings"]))
        self.assertTrue(any("cannot restore" in note for note in quality["warnings"]))

    def test_honours_texture_transform_uv_channel_and_counts_shared_texture_once(self):
        document = textured_world(width=1024, height=512, texcoord=1)
        record = document["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]
        record["texCoord"] = 0
        record["extensions"] = {"KHR_texture_transform": {"texCoord": 1}}
        document["meshes"][0]["primitives"].append(copy.deepcopy(document["meshes"][0]["primitives"][0]))
        quality = inspect_visual_world(glb_bytes(document))
        self.assertEqual(quality["triangleCount"], 2)
        self.assertEqual(quality["texturedTriangleCount"], 2)
        self.assertEqual(quality["usedColourImageCount"], 1)
        self.assertEqual(quality["usedColourDecodedRgbaBytes"], 1024 * 512 * 4)
        self.assertTrue(any("below 2048px" in note for note in quality["warnings"]))

    def test_inspects_embedded_buffer_image_and_indexed_triangle_count(self):
        document = textured_world(width=32, height=64)
        image = png_bytes(32, 64)
        geometry = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
        binary = geometry + struct.pack("<6H", 0, 1, 2, 0, 2, 1) + image
        document["buffers"][0]["byteLength"] = len(binary)
        document["bufferViews"].extend([
            {"buffer": 0, "byteOffset": 36, "byteLength": 12},
            {"buffer": 0, "byteOffset": 48, "byteLength": len(image)},
        ])
        document["accessors"].append({"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"})
        document["meshes"][0]["primitives"][0]["indices"] = 2
        document["images"] = [{"bufferView": 2, "mimeType": "image/png"}]
        quality = inspect_visual_world(glb_bytes(document, binary))
        self.assertEqual(quality["triangleCount"], 2)
        self.assertEqual(quality["texturedTriangleCount"], 2)
        self.assertEqual(quality["images"][0]["width"], 32)
        self.assertEqual(quality["images"][0]["height"], 64)

    def test_reports_unreadable_image_headers_without_inventing_texture_detail(self):
        quality = inspect_visual_world(glb_bytes(textured_world(image=b"not a png")))
        self.assertEqual(quality["images"], [{"index": 0, "readable": False}])
        self.assertEqual(quality["texturedTriangleCount"], 0)
        self.assertTrue(any("could not be inspected" in note for note in quality["warnings"]))

    def test_rejects_excessive_source_headers_before_any_decoder_allocation(self):
        with patch.object(Image, "open") as open_image:
            open_image.return_value.__enter__.return_value.size = (8192, 8192)
            self.assertEqual(inspect_visual_world(glb_bytes(textured_world(image=b"header fixture")))["maxColourTextureEdge"], 8192)
            for dimensions in ((16385, 1), (16384, 16384)):
                open_image.return_value.__enter__.return_value.size = dimensions
                with self.assertRaisesRegex(ValueError, "source texture exceeds the supported decoder budget"):
                    inspect_visual_world(glb_bytes(textured_world(image=b"header fixture")))
            open_image.side_effect = Image.DecompressionBombError("unsafe header")
            with self.assertRaisesRegex(ValueError, "source texture exceeds the supported decoder budget"):
                inspect_visual_world(glb_bytes(textured_world(image=b"header fixture")))

    def test_aggregate_source_image_budget_counts_all_embedded_images(self):
        document = textured_world(image=b"header fixture")
        document["images"] *= 3
        with patch.object(Image, "open") as open_image:
            open_image.return_value.__enter__.return_value.size = (8192, 8192)
            with self.assertRaisesRegex(ValueError, "128 Mi pixels combined"):
                inspect_visual_world(glb_bytes(document))

    def test_preserves_vertex_coloured_source_as_distinct_from_textured_source(self):
        document = glb_document()
        document["accessors"].append({"componentType": 5126, "count": 3, "type": "VEC3"})
        document["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"] = 1
        quality = inspect_visual_world(glb_bytes(document))
        self.assertEqual(quality["vertexColouredTriangleCount"], 1)
        self.assertEqual(quality["texturedTriangleCount"], 0)
        self.assertTrue(quality["warnings"])

    def test_invalid_glb_and_unknown_index_accessor_fail_before_quality_claims(self):
        with self.assertRaises(ValueError):
            inspect_visual_world(b"bad glb")
        document = glb_document()
        document["meshes"][0]["primitives"][0]["indices"] = 99
        with self.assertRaisesRegex(ValueError, "index accessor"):
            inspect_visual_world(glb_bytes(document))


class WorldPresetTests(unittest.TestCase):
    def test_presets_keep_product_neutral_camera_clearance_and_consistent_light(self):
        for name, prompt in DEFAULT_ENVIRONMENTS.items():
            with self.subTest(preset=name):
                self.assertIn("continuous level floor", prompt)
                self.assertIn("clear camera approach and lateral viewing space", prompt)
                self.assertIn("consistent window/light direction", prompt)
                self.assertIn("No product, pedestal", prompt)
                self.assertNotIn("bottle", prompt.lower())
                identity = generation_identity(preset=name)
                self.assertEqual(identity["prompt"], prompt)
                self.assertEqual(identity, generation_identity(preset=name))

    def test_custom_prompt_is_not_augmented_and_has_its_own_reproducible_identity(self):
        identity = generation_identity(prompt="  My custom red room  ")
        self.assertEqual(identity["prompt"], "My custom red room")
        self.assertEqual(identity, generation_identity(prompt="My custom red room", preset="warm-gallery"))
        self.assertNotEqual(identity["key"], generation_identity()["key"])


class WorldPreviewQualityTests(unittest.TestCase):
    def setUp(self):
        self.scene = load_scene(Path(__file__).resolve().parents[1] / "examples" / "bottle.scene.json")

    def test_missing_quality_preserves_legacy_scene_and_explicit_modes_round_trip(self):
        original = copy.deepcopy(self.scene)
        sample = evaluate(self.scene, 1)
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(self.scene, original)
        digests = set()
        for quality in ("balanced", "detail"):
            self.scene["environment"]["previewQuality"] = quality
            self.assertIs(validate_scene(self.scene), self.scene)
            self.assertEqual(validate_scene(json.loads(json.dumps(self.scene)))["environment"]["previewQuality"], quality)
            self.assertEqual(evaluate(self.scene, 1), sample)
            digests.add(scene_digest(self.scene))
        self.assertEqual(len(digests), 2)

    def test_unsupported_preview_modes_fail_explicitly(self):
        for value in ("ultra", "4k", "", None, True, 1, [], {}):
            with self.subTest(value=value):
                self.scene["environment"]["previewQuality"] = value
                with self.assertRaisesRegex(ValueError, "World preview quality must be balanced or detail"):
                    validate_scene(self.scene)
