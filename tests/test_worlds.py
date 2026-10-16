"""Local world import, explicit placement and render asset/plate integrity."""
import base64
import copy
import gzip
import hashlib
import json
import math
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from film import jobs, worlds
from film.scene import evaluate, load_scene, scene_digest, validate_scene
from tests.test_jobs import png_bytes

ROOT = Path(__file__).resolve().parents[1]
PROVENANCE = {"source": "Original synthetic QA fixture; not a generated provider world", "owner": "3d-product-suite",
              "reuseBasis": "Original authored test geometry", "allowedExternalDestinations": []}


def glb_bytes(document=None, binary=None):
    binary = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0) if binary is None else binary
    if document is None:
        document = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(binary)}],
                    "bufferViews": [{"buffer": 0, "byteLength": len(binary)}],
                    "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"}],
                    "meshes": [{"name": "Visual room", "primitives": [{"attributes": {"POSITION": 0}}]}],
                    "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0}
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    chunks = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    if binary:
        binary += b"\0" * (-len(binary) % 4)
        chunks += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


def glb_document():
    payload = glb_bytes()
    length = struct.unpack_from("<I", payload, 12)[0]
    return json.loads(payload[20:20 + length])


def ply_bytes(*, binary=True, nan=False):
    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    format_ = "binary_little_endian" if binary else "ascii"
    header = "ply\nformat " + format_ + " 1.0\nelement vertex 1\n"
    header += "".join(f"property float {name}\n" for name in names) + "end_header\n"
    values = [float("nan") if nan else 0, 0, 0, 0, 0, 0, 2, -3, -3, -3, 1, 0, 0, 0]
    data = struct.pack("<14f", *values) if binary else (" ".join(map(str, values)) + "\n").encode()
    return header.encode() + data


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class WorldTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.library = self.root / "library"
        self.source = self.root / "room.glb"
        self.source.write_bytes(glb_bytes())
        self.scene = load_scene(ROOT / "examples" / "bottle.scene.json")
        # Isolate job integrity tests from concurrent development of the renderer.
        renderer = self.root / "renderer.py"
        renderer.write_bytes(jobs._RENDERER.read_bytes())
        self.patch_renderer = patch.object(jobs, "_RENDERER", renderer)
        self.patch_renderer.start()
        self.addCleanup(self.patch_renderer.stop)

    def import_asset(self, path=None, **kwargs):
        return worlds.import_world(path or self.source, self.library, name=kwargs.pop("name", "Synthetic room"),
                                   provenance=kwargs.pop("provenance", PROVENANCE), fixture=True, **kwargs)

    def world_scene(self, format_="glb"):
        if format_ == "ply":
            self.source = self.root / "room.ply"
            self.source.write_bytes(ply_bytes())
        entry = self.import_asset()
        self.scene["environment"] = copy.deepcopy(entry["environment"])
        return self.scene

    def make_job(self, *, splat=False):
        self.world_scene("ply" if splat else "glb")
        self.scene["render"].update(width=4, height=6, samples=1)
        self.scene["actions"] = []
        for index, shot in enumerate(self.scene["shots"]):
            shot.update(startFrame=index + 1, endFrame=index + 1)
        source = self.library / "scene.json"
        source.write_text(json.dumps(self.scene))
        output = self.root / "job"
        return output, jobs.create_job(source, output)

    def capture(self, output, job, numbers=(1, 2, 3)):
        plate = output / "plate"
        plate.mkdir(exist_ok=True)
        hashes = {}
        for number in numbers:
            path = plate / f"{number:06d}.png"
            path.write_bytes(png_bytes(value=number * 10))
            hashes[str(number)] = jobs._sha256(path)
        sampled = json.loads((output / "samples.json").read_text())
        manifest = {"schemaVersion": 1, "sourceDigest": job["sceneDigest"], "samplesDigest": canonical_digest(sampled),
                    "assetSha256": self.scene["environment"]["asset"]["sha256"], "assetFormat": "ply",
                    "profile": {"width": 4, "height": 6, "frameNumbers": list(numbers), "renderer": "spark",
                                "runtimeDigest": "a" * 64, "colorSpace": "srgb", "toneMapping": "none", "contents": "gaussian-world-only"},
                    "frames": hashes, "createdAt": "not-part-of-source-pin"}
        jobs._atomic_json(plate / "capture-manifest.json", manifest)
        return manifest

    def test_import_is_content_addressed_immutable_and_provenance_preserving(self):
        first = self.import_asset()
        self.assertEqual(self.import_asset(), first)
        asset = first["environment"]["asset"]
        self.assertEqual(asset["sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(asset["path"], f"assets/{asset['sha256']}.glb")
        self.assertEqual((self.library / asset["path"]).read_bytes(), self.source.read_bytes())
        self.assertEqual(first["environment"]["provenance"], PROVENANCE)
        self.assertEqual(first["environment"]["reviewStatus"], "unreviewed")
        self.assertTrue(first["environment"]["fixture"])
        self.assertNotIn(str(self.root), json.dumps(first))
        self.assertEqual(first["environment"]["plinth"], self.scene["environment"]["plinth"])
        second = self.import_asset(name="Another approved name")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["environment"]["asset"], second["environment"]["asset"])
        self.assertEqual(len(worlds.list_worlds(self.library)), 2)
        self.assertEqual(len(list((self.library / "assets").iterdir())), 1)

    def test_actual_authored_glb_and_gaussian_ply_fixtures_import(self):
        for format_ in ("glb", "ply"):
            with self.subTest(format=format_):
                entry = self.import_asset(ROOT / "examples" / "worlds" / f"neutral-room.{format_}", name=f"Synthetic {format_}")
                self.assertEqual(entry["environment"]["kind"], "mesh" if format_ == "glb" else "splat")
                self.assertEqual(len(worlds.verify_scene_assets({"environment": entry["environment"]}, self.library)), 1)

    def test_provenance_scale_axis_and_file_bounds_are_explicit(self):
        for provenance in ({}, {**PROVENANCE, "owner": ""}, {**PROVENANCE, "allowedExternalDestinations": None}):
            with self.subTest(provenance=provenance), self.assertRaises(ValueError):
                self.import_asset(provenance=provenance)
        for scale in (0, -1, float("nan"), True):
            with self.subTest(scale=scale), self.assertRaises(ValueError):
                self.import_asset(scale_to_meters=scale)
        with self.assertRaisesRegex(ValueError, "sourceUp Y"):
            self.import_asset(source_up="Z")
        with patch.object(worlds, "MAX_ASSET_BYTES", 20), self.assertRaisesRegex(ValueError, "at most"):
            self.import_asset()
        unknown = self.root / "room.obj"
        unknown.write_bytes(b"not supported")
        with self.assertRaisesRegex(ValueError, "suffix"):
            self.import_asset(unknown)

    def test_glb_external_resources_scripts_and_collision_geometry_are_rejected(self):
        variants = []
        document = glb_document()
        document["buffers"][0]["uri"] = "textures/room.bin"
        variants.append(document)
        document = glb_document()
        document["images"] = [{"uri": "https://example.invalid/texture.png"}]
        variants.append(document)
        document = glb_document()
        document["extras"] = {"scripts": ["do something"]}
        variants.append(document)
        document = glb_document()
        document["meshes"][0]["name"] = "Collision mesh"
        variants.append(document)
        document = glb_document()
        document["asset"]["extras"] = {"role": "collision"}
        variants.append(document)
        document = glb_document()
        document["images"] = [{"uri": "data:image/svg+xml;base64,PHN2Zy8+"}]
        variants.append(document)
        for index, document in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.source.write_bytes(glb_bytes(document))
                self.import_asset()

    def test_glb_lengths_buffers_and_empty_geometry_are_checked(self):
        variants = [glb_bytes()[:-1], b"glTF" + b"\0" * 20]
        excessive = glb_document()
        excessive["accessors"][0]["count"] = 10**12
        variants.append(glb_bytes(excessive))
        outside_view = glb_document()
        outside_view["accessors"][0]["byteOffset"] = 12
        variants.append(glb_bytes(outside_view))
        for field in ("buffers", "bufferViews", "accessors", "meshes"):
            document = glb_document()
            if field == "buffers":
                document[field][0]["byteLength"] = 10000
            elif field == "bufferViews":
                document[field][0]["byteOffset"] = 99999
            elif field == "accessors":
                document[field][0]["count"] = 0
            else:
                document[field] = []
            variants.append(glb_bytes(document))
        for index, payload in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.source.write_bytes(payload)
                self.import_asset()

    def test_self_contained_data_uri_buffer_is_allowed(self):
        document = glb_document()
        raw = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
        document["buffers"][0]["uri"] = "data:application/octet-stream;base64," + base64.b64encode(raw).decode()
        self.source.write_bytes(glb_bytes(document, binary=b""))
        self.assertEqual(self.import_asset()["environment"]["kind"], "mesh")

    def test_gaussian_ply_checks_properties_vertex_data_and_finite_values(self):
        path = self.root / "world.ply"
        for binary in (False, True):
            path.write_bytes(ply_bytes(binary=binary))
            self.assertEqual(self.import_asset(path, source_up="Z")["environment"]["asset"]["sourceUp"], "Z")
        variants = [ply_bytes()[:-1], ply_bytes(nan=True), ply_bytes(binary=False, nan=True),
                    b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n"]
        for index, payload in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(ValueError):
                path.write_bytes(payload)
                self.import_asset(path)

    def test_spz_checks_compression_magic_header_and_bounded_decompression(self):
        path = self.root / "world.spz"
        raw = struct.pack("<III4B", 0x5053474E, 2, 1, 0, 12, 0, 0) + b"\0" * 19
        path.write_bytes(gzip.compress(raw))
        self.assertEqual(self.import_asset(path)["environment"]["asset"]["format"], "spz")
        for payload in (raw, gzip.compress(b"wrong magic"), gzip.compress(raw[:-1]), gzip.compress(raw)[:-2]):
            with self.subTest(length=len(payload)), self.assertRaises(ValueError):
                path.write_bytes(payload)
                self.import_asset(path)
        path.write_bytes(gzip.compress(raw + b"\0" * 1000))
        with patch.object(worlds, "MAX_DECODED_SPZ_BYTES", 100), self.assertRaisesRegex(ValueError, "size limit"):
            self.import_asset(path)

    def test_safe_paths_reject_traversal_absolute_network_and_symlink_escape(self):
        self.library.mkdir()
        for value in ("../secret.glb", "/tmp/secret.glb", "https://example.invalid/x", "//server/file", "C:\\tmp\\x", "assets/../x", "assets//x"):
            with self.subTest(path=value), self.assertRaises(ValueError):
                worlds.safe_asset_path(self.library, value)
        outside = self.root / "outside"
        outside.mkdir()
        (self.library / "assets").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.import_asset()
        self.assertEqual(list(outside.iterdir()), [])

    def test_bundle_copies_exact_asset_without_mutating_scene_and_rechecks_hash(self):
        scene = self.world_scene()
        before = copy.deepcopy(scene)
        output = self.root / "bundled"
        records = worlds.bundle_assets(scene, self.library, output)
        self.assertEqual(scene, before)
        self.assertEqual((output / records[0]["path"]).read_bytes(), self.source.read_bytes())
        self.assertEqual(worlds.bundle_assets(scene, self.library, output), records)
        asset = self.library / scene["environment"]["asset"]["path"]
        asset.write_bytes(asset.read_bytes()[:-1] + b"x")
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            worlds.bundle_assets(scene, self.library, output)
        self.assertEqual((output / records[0]["path"]).read_bytes(), self.source.read_bytes())

    def test_bundle_refuses_to_overwrite_corrupt_destination(self):
        scene = self.world_scene()
        output = self.root / "bundled"
        worlds.bundle_assets(scene, self.library, output)
        target = output / scene["environment"]["asset"]["path"]
        target.write_bytes(b"keep visible corruption")
        with self.assertRaisesRegex(ValueError, "immutable library content"):
            worlds.bundle_assets(scene, self.library, output)
        self.assertEqual(target.read_bytes(), b"keep visible corruption")

    def test_job_bundles_world_and_resume_uses_verified_snapshot(self):
        output, job = self.make_job()
        self.assertEqual(job["renderingPath"], "mesh-cycles")
        self.assertEqual(len(job["assets"]), 1)
        (self.library / self.scene["environment"]["asset"]["path"]).unlink()
        self.assertEqual(jobs._verify_snapshots(output, job), self.scene)
        asset = output / self.scene["environment"]["asset"]["path"]
        asset.write_bytes(b"modified asset")
        with patch.object(jobs.subprocess, "run") as process, self.assertRaisesRegex(ValueError, "hash does not match"):
            jobs.run_job(output)
        process.assert_not_called()
        self.assertEqual(jobs._read_job(output)["state"], "failed")

    def test_still_job_is_rejected_by_reel_worker_without_state_change(self):
        output, job = self.make_job()
        job.update(kind="still", frame=2)
        jobs._save_job(output, job)
        with self.assertRaisesRegex(ValueError, "film.stills.run_still_job"):
            jobs.run_job(output)
        self.assertEqual(jobs._read_job(output)["state"], "queued")

    def test_scene_asset_contract_rejects_ambiguous_axes_paths_and_transforms(self):
        scene = self.world_scene()
        validate_scene(scene)
        for field, value in (("sourceUp", "Z"), ("scaleToMeters", 0), ("sha256", "A" * 64),
                             ("path", "../escape.glb"), ("rotationXyzw", [0, 0, 0, 2]), ("translationM", [0, float("nan"), 0])):
            invalid = copy.deepcopy(scene)
            invalid["environment"]["asset"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_scene(invalid)

    def test_explicit_plinth_carries_product_but_world_alignment_does_not(self):
        baseline = evaluate(self.scene, 166)
        moved = copy.deepcopy(self.scene)
        moved["environment"]["plinth"]["translationM"] = [0.1, 0.165, -0.3]
        sample = evaluate(moved, 166)
        for component in baseline["components"]:
            expected = [x + y for x, y in zip(baseline["components"][component]["translationM"], [0.1, 0.2, -0.3])]
            for actual, want in zip(sample["components"][component]["translationM"], expected):
                self.assertAlmostEqual(actual, want)
            self.assertEqual(sample["components"][component]["rotationXyzw"], baseline["components"][component]["rotationXyzw"])
        self.assertEqual(sample["camera"], baseline["camera"])
        self.world_scene()
        before = evaluate(self.scene, 166)
        plinth = copy.deepcopy(self.scene["environment"]["plinth"])
        self.scene["environment"]["asset"].update(translationM=[10, 20, 30], scaleToMeters=100)
        self.assertEqual(evaluate(self.scene, 166), before)
        self.assertEqual(self.scene["environment"]["plinth"], plinth)

    def test_glass_material_ranges_and_explicit_props_are_validated(self):
        material = self.scene["product"]["components"][0]["material"]
        material.update(transmission=1, ior=1.46)
        prop = {"id": "occluder", "shape": "box", "sizeM": [0.02, 0.1, 0.02], "translationM": [0.06, 0.05, 0.06],
                "rotationXyzw": [0, 0, 0, 1], "material": copy.deepcopy(material), "bevelM": 0.001}
        self.scene["environment"]["props"] = [prop]
        validate_scene(self.scene)
        for field, value in (("transmission", -0.1), ("transmission", 1.1), ("transmission", True), ("ior", 0.9), ("ior", 3.1), ("ior", float("nan"))):
            invalid = copy.deepcopy(self.scene)
            invalid["product"]["components"][0]["material"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_scene(invalid)
        for identity in ("bottle-body", "plinth"):
            invalid = copy.deepcopy(self.scene)
            invalid["environment"]["props"][0]["id"] = identity
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, "Prop IDs"):
                validate_scene(invalid)
        invalid = copy.deepcopy(self.scene)
        invalid["environment"]["props"].append(copy.deepcopy(prop))
        with self.assertRaisesRegex(ValueError, "Prop IDs"):
            validate_scene(invalid)

    def test_splat_plate_inputs_pin_exact_source_profile_and_png_hashes(self):
        output, job = self.make_job(splat=True)
        manifest = self.capture(output, job)
        digest = jobs.validate_plate_inputs(output, job, [1, 2, 3])
        self.assertEqual(job["plateDigest"], digest)
        self.assertEqual(jobs.validate_plate_inputs(output, job, [1, 2, 3]), digest)
        manifest["createdAt"] = "timestamp does not alter source"
        jobs._atomic_json(output / "plate" / "capture-manifest.json", manifest)
        self.assertEqual(jobs.validate_plate_inputs(output, job, [1, 2, 3]), digest)
        (output / "plate" / "000001.png").write_bytes(png_bytes(value=90))
        with self.assertRaisesRegex(ValueError, "plate hash changed"):
            jobs.validate_plate_inputs(output, job, [1, 2, 3])
        manifest["frames"]["1"] = jobs._sha256(output / "plate" / "000001.png")
        jobs._atomic_json(output / "plate" / "capture-manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "changed after job started"):
            jobs.validate_plate_inputs(output, job, [1, 2, 3])

    def test_splat_capture_mismatch_missing_frame_and_runtime_changes_fail(self):
        output, job = self.make_job(splat=True)
        with self.assertRaisesRegex(ValueError, "capture-manifest"):
            jobs.validate_plate_inputs(output, job, [1, 2, 3])
        original = self.capture(output, job)
        for field, value in (("sourceDigest", "b" * 64), ("assetSha256", "b" * 64), ("samplesDigest", "b" * 64)):
            manifest = copy.deepcopy(original)
            manifest[field] = value
            jobs._atomic_json(output / "plate" / "capture-manifest.json", manifest)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "does not match this job"):
                jobs.validate_plate_inputs(output, job, [1, 2, 3])
        jobs._atomic_json(output / "plate" / "capture-manifest.json", original)
        jobs.validate_plate_inputs(output, job, [1, 2, 3])
        changed = copy.deepcopy(original)
        changed["profile"]["runtimeDigest"] = "b" * 64
        jobs._atomic_json(output / "plate" / "capture-manifest.json", changed)
        with self.assertRaisesRegex(ValueError, "changed after job started"):
            jobs.validate_plate_inputs(output, job, [1, 2, 3])
        jobs._atomic_json(output / "plate" / "capture-manifest.json", original)
        (output / "plate" / "000002.png").write_bytes(png_bytes(width=6, height=4))
        with self.assertRaisesRegex(ValueError, "invalid camera-matched"):
            jobs.validate_plate_inputs(output, job, [1, 2, 3])

    def test_splat_reel_worker_rejects_missing_plates_before_process_dispatch(self):
        output, job = self.make_job(splat=True)
        with patch.object(jobs.subprocess, "run") as process, self.assertRaisesRegex(ValueError, "capture-manifest"):
            jobs.run_job(output)
        process.assert_not_called()
        self.assertEqual(jobs._read_job(output)["state"], "failed")


if __name__ == "__main__":
    unittest.main()
