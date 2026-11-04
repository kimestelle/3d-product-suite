"""Verified world facts are reusable; source bytes and scene checks are not."""
from collections import OrderedDict
import copy
import gzip
import hashlib
import os
from pathlib import Path
import struct
import tempfile
import tracemalloc
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from film import worlds
from tests.test_worlds import PROVENANCE, glb_bytes, glb_document


class WorldVerificationCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.library = self.root / "library"
        self.cache = OrderedDict()
        self.cache_patch = patch.object(worlds, "_WORLD_ASSET_CACHE", self.cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        self.entry = self.import_asset(glb_bytes())
        self.scene = {"environment": self.entry["environment"]}
        self.path = self.library / self.entry["environment"]["asset"]["path"]

    def import_asset(self, payload, suffix="glb"):
        source = self.root / f"source.{suffix}"
        source.write_bytes(payload)
        return worlds.import_world(source, self.library, name="Synthetic cache fixture", provenance=PROVENANCE, fixture=True)

    def verify(self, scene=None):
        return worlds.verify_scene_assets(scene or self.scene, self.library)

    def test_reuses_only_verified_metadata_and_returns_independent_records(self):
        with patch.object(worlds, "_read_asset", wraps=worlds._read_asset) as read, \
             patch.object(worlds, "_validate_content", wraps=worlds._validate_content) as validate:
            first = self.verify()
            first[0]["meshCount"] = 999
            second = self.verify()
        self.assertEqual(read.call_count, 1)
        self.assertEqual(validate.call_count, 1)
        self.assertEqual(second[0]["meshCount"], 1)
        self.assertEqual(list(self.cache.values()), [{"bytes": self.path.stat().st_size, "meshCount": 1}])
        self.assertTrue(all(not isinstance(value, (bytes, bytearray, memoryview))
                            for record in self.cache.values() for value in record.values()))

    def test_world_listing_uses_same_verification_cache_but_rereads_entry_documents(self):
        with patch.object(worlds, "_read_asset", wraps=worlds._read_asset) as read:
            self.assertEqual(worlds.list_worlds(self.library), [self.entry])
            self.assertEqual(worlds.list_worlds(self.library), [self.entry])
            self.assertEqual(read.call_count, 1)
            entry_path = self.library / "worlds" / f"{self.entry['id']}.json"
            entry_path.write_text("{}")
            with self.assertRaisesRegex(ValueError, "identity"):
                worlds.list_worlds(self.library)

    def test_same_inode_size_and_restored_mtime_do_not_hide_changed_bytes(self):
        self.verify()
        original = self.path.stat()
        payload = self.path.read_bytes()
        self.path.write_bytes(b"X" + payload[1:])
        os.utime(self.path, ns=(original.st_atime_ns, original.st_mtime_ns))
        changed = self.path.stat()
        self.assertEqual(changed.st_ino, original.st_ino)
        self.assertEqual(changed.st_size, original.st_size)
        self.assertEqual(changed.st_mtime_ns, original.st_mtime_ns)
        self.assertNotEqual(changed.st_ctime_ns, original.st_ctime_ns)
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            self.verify()

    def test_atomic_replacement_with_preserved_size_and_mtime_is_reverified(self):
        expected = self.verify()
        original = self.path.stat()
        replacement = self.path.with_suffix(".replacement")
        replacement.write_bytes(self.path.read_bytes())
        os.utime(replacement, ns=(original.st_atime_ns, original.st_mtime_ns))
        os.replace(replacement, self.path)
        self.assertNotEqual(self.path.stat().st_ino, original.st_ino)
        with patch.object(worlds, "_read_asset", wraps=worlds._read_asset) as read:
            self.assertEqual(self.verify(), expected)
            self.assertEqual(read.call_count, 1)

    def test_replaced_invalid_file_is_rejected_despite_a_warm_cache(self):
        self.verify()
        replacement = self.path.with_suffix(".replacement")
        replacement.write_bytes(b"X" + self.path.read_bytes()[1:])
        os.replace(replacement, self.path)
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            self.verify()

    def test_removed_asset_or_escape_symlink_never_hits_old_verification(self):
        self.verify()
        payload = self.path.read_bytes()
        self.path.unlink()
        with self.assertRaisesRegex(ValueError, "Cannot read world asset"):
            self.verify()
        self.path.mkdir()
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.verify()
        self.path.rmdir()
        outside = self.root / "outside.glb"
        outside.write_bytes(payload)
        self.path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.verify()

    def test_changed_file_during_cached_lookup_is_rejected(self):
        self.verify()
        actual_stat = worlds._asset_stat
        calls = 0

        def changed_after_lookup(path):
            nonlocal calls
            calls += 1
            if calls == 2:
                path.write_bytes(b"X" + path.read_bytes()[1:])
            return actual_stat(path)

        with patch.object(worlds, "_asset_stat", side_effect=changed_after_lookup), \
             self.assertRaisesRegex(ValueError, "changed during verification"):
            self.verify()

    def test_changed_file_during_cold_validation_is_rejected_and_not_cached(self):
        actual_validate = worlds._validate_content

        def changed_after_validate(payload, format_):
            metadata = actual_validate(payload, format_)
            self.path.write_bytes(b"X" + payload[1:])
            return metadata

        with patch.object(worlds, "_validate_content", side_effect=changed_after_validate), \
             self.assertRaisesRegex(ValueError, "changed during verification"):
            self.verify()
        self.assertEqual(self.cache, {})

    def test_changed_descriptor_during_read_is_rejected(self):
        actual_fstat = os.fstat
        calls = 0

        def changed_second_stat(fd):
            nonlocal calls
            calls += 1
            info = actual_fstat(fd)
            if calls != 2:
                return info
            return SimpleNamespace(**{key:getattr(info, key) for key in
                ("st_mode", "st_dev", "st_ino", "st_size", "st_mtime_ns")}, st_ctime_ns=info.st_ctime_ns + 1)

        with patch.object(os, "fstat", side_effect=changed_second_stat), \
             self.assertRaisesRegex(ValueError, "changed while reading"):
            self.verify()
        self.assertEqual(self.cache, {})

    def test_invalid_content_and_hash_failures_are_never_cached(self):
        self.path.write_bytes(b"X" + self.path.read_bytes()[1:])
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "hash does not match"):
                self.verify()
        self.assertEqual(self.cache, {})
        invalid_scene = {"environment": copy.deepcopy(self.entry["environment"])}
        payload = b"not a glb"
        digest = hashlib.sha256(payload).hexdigest()
        invalid_scene["environment"]["asset"].update(sha256=digest, path=f"assets/{digest}.glb")
        (self.library / f"assets/{digest}.glb").write_bytes(payload)
        with self.assertRaisesRegex(ValueError, "GLB"):
            self.verify(invalid_scene)
        self.assertEqual(self.cache, {})

    def test_current_file_and_decoder_limits_still_apply_after_a_cache_hit(self):
        self.verify()
        with patch.object(worlds, "MAX_ASSET_BYTES", 20), self.assertRaisesRegex(ValueError, "at most"):
            self.verify()
        spz = gzip.compress(struct.pack("<III4B", 0x5053474E, 2, 1, 0, 12, 0, 0) + bytes(19))
        entry = self.import_asset(spz, "spz")
        scene = {"environment": entry["environment"]}
        self.verify(scene)
        with patch.object(worlds, "MAX_DECODED_SPZ_BYTES", 16), self.assertRaisesRegex(ValueError, "decompressed"):
            self.verify(scene)

    def test_lru_entries_are_bounded_and_recent_use_preserves_an_entry(self):
        scenes = []
        for index in range(3):
            document = glb_document()
            document["meshes"][0]["name"] = f"Visual room {index}"
            scenes.append({"environment": self.import_asset(glb_bytes(document))["environment"]})
        with patch.object(worlds, "_WORLD_ASSET_CACHE_MAX_ENTRIES", 2), \
             patch.object(worlds, "_read_asset", wraps=worlds._read_asset) as read:
            for index in (0, 1, 0, 2, 0, 1):
                self.verify(scenes[index])
                self.assertLessEqual(len(self.cache), 2)
            self.assertEqual(read.call_count, 4)

    def test_oversized_metadata_is_returned_but_not_retained_in_cache(self):
        with patch.object(worlds, "_validate_content", return_value={"details":"x" * 4096}), \
             patch.object(worlds, "_read_asset", wraps=worlds._read_asset) as read:
            for _ in range(2):
                self.assertEqual(len(self.verify()[0]["details"]), 4096)
            self.assertEqual(read.call_count, 2)
        self.assertEqual(self.cache, {})

    def test_glb_validation_does_not_copy_large_embedded_geometry_and_texture_storage(self):
        binary = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0) + bytes(4 * 1024 * 1024)
        document = glb_document()
        document["buffers"][0]["byteLength"] = len(binary)
        payload = glb_bytes(document, binary)
        tracemalloc.start()
        try:
            self.assertEqual(worlds._validate_content(payload, "glb"), {"meshCount": 1})
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
