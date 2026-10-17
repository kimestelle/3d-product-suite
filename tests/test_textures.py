"""Artwork imports, bounded decoders and immutable scene/job lifecycle."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib

from film import comparison, jobs, textures, worlds
from film.scene import load_scene, scene_digest, validate_scene
from film.store import ProjectStore
from tests.test_jobs import png_bytes
from tests.test_worlds import glb_bytes, PROVENANCE


ROOT = Path(__file__).resolve().parents[1]
# Real 2×3 baseline JPEG, retained inline so tests need no image library.
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/"
    "2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/"
    "8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2Jy"
    "ggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5"
    "usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcF"
    "BAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp"
    "anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMB"
    "AAIRAxEAPwDWooor2Txj/9k=")


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


def label(asset, *, mode="planar"):
    return {"asset": copy.deepcopy(asset), "mapping": {"mode": mode, "face": "front", "scale": [1, 1],
            "offset": [0, 0], "rotationDegrees": 0},
            "material": {"baseColor": [1, 1, 1, 1], "roughness": .6, "metallic": 0}}


class TextureTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.scene = load_scene(ROOT / "examples" / "bottle.scene.json")

    def texture(self, payload=None, filename="brand.png"):
        return textures.import_texture(payload or png_bytes(), self.root, filename=filename)["asset"]

    def labeled_scene(self):
        self.scene["product"]["components"][0]["labelTexture"] = label(self.texture())
        return self.scene

    def test_png_and_jpeg_are_content_addressed_and_jpeg_suffix_is_normalized(self):
        for payload, filename, format_, size in ((png_bytes(), "brand.PNG", "png", (4, 6)),
                                               (JPEG, "brand.jpeg", "jpg", (2, 3))):
            with self.subTest(format=format_):
                imported = textures.import_texture(payload, self.root, filename=filename)
                asset = imported["asset"]
                digest = hashlib.sha256(payload).hexdigest()
                self.assertEqual(asset, {"path": f"assets/{digest}.{format_}", "format": format_, "sha256": digest,
                                         "widthPx": size[0], "heightPx": size[1]})
                self.assertEqual(textures.import_texture(payload, self.root, filename=filename), imported)
                self.assertEqual((self.root / asset["path"]).read_bytes(), payload)
        self.assertEqual(len(list((self.root / "assets").iterdir())), 2)

    def test_suffix_spoofing_unsupported_files_and_upload_paths_are_rejected(self):
        for payload, filename in ((png_bytes(), "label.jpg"), (JPEG, "label.png"),
                                  (b"<svg></svg>", "label.png"), (b"x", "label.svg"),
                                  (png_bytes(), "../label.png"), (png_bytes(), "/label.png"),
                                  (png_bytes(), "assets/label.png"), (png_bytes(), "C:\\label.png")):
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                self.texture(payload, filename)

    def test_png_full_structure_checksums_pixels_and_dimensions_are_checked(self):
        valid = png_bytes()
        variants = [valid[:-1], valid + b"trailing", valid[:40] + b"broken" + valid[46:],
                    png_bytes(raw=b"\x05" + b"\0" * 12), png_bytes(raw=b"\0" * 10),
                    png_bytes(raw=b"\0" * 1000)]
        for payload in variants:
            with self.subTest(bytes=len(payload)), self.assertRaises(ValueError):
                self.texture(payload)
        for width, height in ((8193, 1), (8000, 4001), (0, 10)):
            payload = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            with self.subTest(width=width, height=height), self.assertRaises(ValueError):
                self.texture(payload)
        with patch.object(textures, "MAX_TEXTURE_BYTES", len(valid) - 1), self.assertRaisesRegex(ValueError, "8 MiB"):
            self.texture(valid)

    def test_png_palette_alpha_and_interlace_are_accepted_without_decoding_large_buffers(self):
        # A 1×1 indexed PNG with a transparent palette entry and Adam7 interlace.
        payload = b"\x89PNG\r\n\x1a\n"
        payload += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 1, 3, 0, 0, 1))
        payload += png_chunk(b"PLTE", b"\xff\0\0\0\xff\0") + png_chunk(b"tRNS", b"\0\xff")
        payload += png_chunk(b"IDAT", zlib.compress(b"\0\0")) + png_chunk(b"IEND", b"")
        self.assertEqual(self.texture(payload)["widthPx"], 1)
        rgba = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
        rgba += png_chunk(b"IDAT", zlib.compress(b"\0\xff\0\0\x80\0\0\0\0")) + png_chunk(b"IEND", b"")
        self.assertEqual(self.texture(rgba)["widthPx"], 2)
        # Inflation is streamed even for a highly compressible larger image.
        self.assertEqual(textures.inspect_texture(png_bytes(2048, 1024), "png"), {"widthPx": 2048, "heightPx": 1024})

    def test_jpeg_truncation_bad_segments_absent_pixels_and_spoofed_dimensions_are_rejected(self):
        frame = JPEG.index(b"\xff\xc0")
        oversized = bytearray(JPEG)
        oversized[frame + 7:frame + 9] = struct.pack(">H", 8193)
        scan = JPEG.index(b"\xff\xda")
        scan_length = struct.unpack_from(">H", JPEG, scan + 2)[0]
        variants = [JPEG[:-1], JPEG + b"trailing", bytes(oversized), JPEG[:scan + 2 + scan_length] + b"\xff\xd9",
                    JPEG[:frame + 2] + b"\xff\xff" + JPEG[frame + 4:]]
        for payload in variants:
            with self.subTest(bytes=len(payload)), self.assertRaises(ValueError):
                self.texture(payload, "label.jpg")

    def test_exif_rotation_is_rejected_for_jpeg_and_png_without_rewriting_artwork(self):
        def tiff(orientation, *, endian="<"):
            return ((b"II" if endian == "<" else b"MM") + struct.pack(endian + "HIH", 42, 8, 1)
                    + struct.pack(endian + "HHI", 0x0112, 3, 1)
                    + struct.pack(endian + "H", orientation) + b"\0\0" + struct.pack(endian + "I", 0))

        def jpeg(metadata):
            metadata = b"Exif\0\0" + metadata
            return JPEG[:2] + b"\xff\xe1" + struct.pack(">H", len(metadata) + 2) + metadata + JPEG[2:]

        def png(metadata):
            original = png_bytes()
            return original[:33] + png_chunk(b"eXIf", metadata) + original[33:]

        for assemble, filename in ((jpeg, "label.jpg"), (png, "label.png")):
            for endian in ("<", ">"):
                payload = assemble(tiff(1, endian=endian))
                asset = self.texture(payload, filename)
                self.assertEqual((self.root / asset["path"]).read_bytes(), payload)
                for orientation in (3, 6, 8):
                    with self.subTest(filename=filename, endian=endian, orientation=orientation), self.assertRaisesRegex(
                            ValueError, "Export artwork without EXIF rotation"):
                        self.texture(assemble(tiff(orientation, endian=endian)), filename)
            for metadata in (b"broken", tiff(1)[:-1], b"II" + struct.pack("<HI", 42, 0xffffffff),
                             tiff(1)[:10] + struct.pack("<HHI", 0x0112, 4, 1) + tiff(1)[18:]):
                with self.subTest(filename=filename, bytes=len(metadata)), self.assertRaisesRegex(ValueError, "EXIF"):
                    self.texture(assemble(metadata), filename)

    def test_scene_mapping_and_material_contract_is_complete_and_finite(self):
        scene = self.labeled_scene()
        original = copy.deepcopy(scene)
        self.assertIs(validate_scene(scene), scene)
        self.assertEqual(scene, original)
        edits = [lambda t: t["mapping"].pop("offset"), lambda t: t["mapping"].update(mode="unknown"),
                 lambda t: t["mapping"].update(face="unknown"), lambda t: t["mapping"].update(scale=[0, 1]),
                 lambda t: t["mapping"].update(scale=[1, 11]), lambda t: t["mapping"].update(offset=[6, 0]),
                 lambda t: t["mapping"].update(rotationDegrees=361), lambda t: t["mapping"].update(rotationDegrees=float("nan")),
                 lambda t: t["mapping"].update(mode="uv"), lambda t: t["material"].update(roughness=-.1),
                 lambda t: t["material"].update(transmission=.1), lambda t: t["material"].update(baseColor=[1, 1, 1, 2]),
                 lambda t: t["asset"].update(path="../../label.png"), lambda t: t["asset"].update(widthPx=True),
                 lambda t: t["asset"].update(sha256="bad"), lambda t: t["asset"].update(format="svg")]
        for index, edit in enumerate(edits):
            invalid = copy.deepcopy(scene)
            edit(invalid["product"]["components"][0]["labelTexture"])
            with self.subTest(index=index), self.assertRaises(ValueError):
                validate_scene(invalid)
        coated = scene["product"]["components"][0]["labelTexture"]
        coated["material"].update(transmission=0, ior=1.5, baseColor=[1, 1, 1, .4])
        coated["mapping"].update(mode="cylindrical", offset=[-5, 5], scale=[.01, 10], rotationDegrees=-360)
        validate_scene(scene)

    def test_verified_bundles_deduplicate_and_preserve_material_mapping_and_source_artwork(self):
        scene = self.labeled_scene()
        texture = scene["product"]["components"][0]["labelTexture"]
        scene["product"]["components"][1]["labelTexture"] = copy.deepcopy(texture)
        before = copy.deepcopy(scene)
        records = worlds.bundle_assets(scene, self.root, self.root / "snapshot")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["widthPx"], 4)
        self.assertEqual(worlds.verify_scene_assets(scene, self.root / "snapshot"), records)
        self.assertEqual(scene, before)
        self.assertEqual(scene["product"]["label"], before["product"]["label"])
        self.assertEqual(len(list((self.root / "snapshot" / "assets").iterdir())), 1)
        invalid = copy.deepcopy(scene)
        invalid["product"]["components"][0]["labelTexture"]["asset"]["widthPx"] = 5
        with self.assertRaisesRegex(ValueError, "dimensions"):
            worlds.verify_scene_assets(invalid, self.root)
        outside = self.root / "outside.png"
        outside.write_bytes(png_bytes())
        snapshot = self.root / "escaped"
        snapshot.mkdir()
        (snapshot / "assets").symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "outside"):
            worlds.bundle_assets(scene, self.root, snapshot)

    def test_save_reopen_job_resume_and_corruption_use_the_pinned_texture_bytes(self):
        scene = self.labeled_scene()
        renderer = self.root / "renderer.py"
        renderer.write_bytes(jobs._RENDERER.read_bytes())
        store = ProjectStore(self.root / "store")
        saved = store.create("Artwork study", scene, source_dir=self.root)
        edited = copy.deepcopy(scene)
        edited["product"]["components"][0]["labelTexture"]["mapping"]["offset"] = [.2, -.1]
        current = store.save(saved["id"], edited, saved["revisionId"])
        self.assertEqual(store.get(saved["id"])["scene"], edited)
        self.assertEqual(store.get(saved["id"], saved["revisionId"])["scene"], scene)
        self.assertNotEqual(current["revisionId"], saved["revisionId"])
        source = store.scene_source(edited)
        output = self.root / "render"
        with patch.object(jobs, "_RENDERER", renderer):
            first = jobs.create_job(source, output)
            self.assertEqual(jobs.create_job(source, output), first)
            self.assertEqual(len(first["assets"]), 1)
            asset = edited["product"]["components"][0]["labelTexture"]["asset"]
            (output / asset["path"]).write_bytes(png_bytes(value=20))
            with patch.object(jobs.subprocess, "run") as process, self.assertRaisesRegex(ValueError, "Texture hash"):
                jobs.run_job(output)
            process.assert_not_called()
        (store.root / asset["path"]).write_bytes(png_bytes(value=30))
        with self.assertRaisesRegex(ValueError, "Texture hash"):
            store.get(saved["id"])

    def test_comparison_snapshots_pin_identical_product_texture_for_both_worlds(self):
        scene = self.labeled_scene()
        path = self.root / "room.glb"
        path.write_bytes(glb_bytes())
        first = worlds.import_world(path, self.root, name="First", provenance=PROVENANCE, fixture=True)
        second = worlds.import_world(path, self.root, name="Second", provenance=PROVENANCE, fixture=True)
        scene["environment"] = copy.deepcopy(first["environment"])
        scene = comparison.set_alternative(scene, second["environment"])
        payload = comparison.comparison_payload(scene)
        texture = scene["product"]["components"][0]["labelTexture"]["asset"]
        for side in ("a", "b"):
            output = self.root / side
            records = worlds.bundle_assets(payload[side], self.root, output)
            self.assertEqual(len(records), 2)
            self.assertEqual((output / texture["path"]).read_bytes(), png_bytes())
        changed = copy.deepcopy(scene)
        changed["product"]["components"][0]["labelTexture"]["material"]["roughness"] = .2
        self.assertNotEqual(comparison.comparison_payload(changed)["sharedDigest"], payload["sharedDigest"])


if __name__ == "__main__":
    unittest.main()
