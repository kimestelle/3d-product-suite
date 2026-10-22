"""Bounded local mesh intake and optional real pinned-Blender conversions."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from film import mesh_import
from film.products import inspect_product_glb
from tests.test_products import product_glb


VERTICES = [(10, 20, 30), (12, 20, 30), (12, 24, 30), (10, 24, 30),
            (10, 20, 36), (12, 20, 36), (12, 24, 36), (10, 24, 36)]
FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def obj_bytes(*, two_objects=False):
    data = "o first part\n" + "".join(f"v {x} {y} {z} {int(index < 4)} 0 {int(index >= 4)}\n"
                                         for index, (x, y, z) in enumerate(VERTICES))
    data += "".join("f " + " ".join(str(index + 1) for index in face) + "\n" for face in FACES)
    if two_objects:
        data += "o second part\n"
        data += "".join(f"v {x + 4} {y} {z} 0 1 0\n" for x, y, z in VERTICES)
        data += "".join("f " + " ".join(str(index + 9) for index in face) + "\n" for face in FACES)
    return data.encode()


def ply_bytes(*, binary=False):
    header = ("ply\nformat " + ("binary_little_endian" if binary else "ascii") + " 1.0\n"
              "element vertex 8\nproperty float x\nproperty float y\nproperty float z\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\n"
              "element face 6\nproperty list uchar int vertex_indices\nend_header\n").encode()
    if binary:
        return header + b"".join(struct.pack("<3f3B", *point, 255 if index < 4 else 0, 0, 255 if index >= 4 else 0)
                                  for index, point in enumerate(VERTICES)) + b"".join(struct.pack("<B4i", 4, *face) for face in FACES)
    return header + ("".join(" ".join(map(str, (*point, 255 if index < 4 else 0, 0, 255 if index >= 4 else 0))) + "\n"
                            for index, point in enumerate(VERTICES))
                     + "".join("4 " + " ".join(map(str, face)) + "\n" for face in FACES)).encode()


def stl_bytes(*, ascii_=False):
    triangles = [(face[0], face[1], face[2]) for face in FACES] + [(face[0], face[2], face[3]) for face in FACES]
    if ascii_:
        return ("solid fixture\n" + "".join("facet normal 0 0 0\nouter loop\n" + "".join(
            "vertex " + " ".join(map(str, VERTICES[index])) + "\n" for index in triangle)
            + "endloop\nendfacet\n" for triangle in triangles) + "endsolid fixture\n").encode()
    return b"fixture".ljust(80, b"\0") + struct.pack("<I", len(triangles)) + b"".join(
        struct.pack("<12fH", 0, 0, 0, *(coordinate for index in triangle for coordinate in VERTICES[index]), 0)
        for triangle in triangles)


def glb_document(payload):
    length = struct.unpack_from("<I", payload, 12)[0]
    return json.loads(payload[20:20 + length])


def glb_colors(payload, document):
    json_length = struct.unpack_from("<I", payload, 12)[0]
    binary = payload[20 + json_length + 8:]
    colors = []
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            accessor = document["accessors"][primitive["attributes"]["COLOR_0"]]
            view = document["bufferViews"][accessor["bufferView"]]
            component = {5121: "B", 5123: "H", 5126: "f"}[accessor["componentType"]]
            decoder = struct.Struct("<" + component * {"VEC3": 3, "VEC4": 4}[accessor["type"]])
            offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
            divisor = {"B": 255, "H": 65535, "f": 1}[component] if accessor.get("normalized") else 1
            for index in range(accessor["count"]):
                colors.append(tuple(value / divisor for value in decoder.unpack_from(binary, offset + index * view.get("byteStride", decoder.size)))[:3])
    return colors


class MeshImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.output = self.root / "part.obj", self.root / "out.glb"
        self.source.write_bytes(obj_bytes())
        self.calls = []

    def run_blender(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if "--version" in command:
            return subprocess.CompletedProcess(command, 0, "Blender 4.3.2\n")
        Path(command[command.index("--output") + 1]).write_bytes(product_glb())
        scale = mesh_import.UNIT_SCALES[command[command.index("--units") + 1]]
        Path(command[command.index("--report") + 1]).write_text(json.dumps({"scaleToMeters": scale,
                                                                            "centerSourceUnits": [11, 22, 33]}))
        return subprocess.CompletedProcess(command, 0)

    def prepare(self, **kwargs):
        return mesh_import.prepare_product_mesh(self.source, self.output, **kwargs)

    def test_success_pins_blender_isolates_source_and_preserves_inspection(self):
        with patch.object(mesh_import.subprocess, "run", side_effect=self.run_blender):
            metadata = self.prepare(units="cm", source_up="Z")
        self.assertEqual(self.output.read_bytes(), product_glb())
        self.assertEqual(metadata["sourceSha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(metadata["sourceFormat"], "obj")
        self.assertEqual(metadata["sourceExtension"], ".obj")
        self.assertEqual(metadata["sourceUp"], "Z")
        self.assertEqual(metadata["units"], "cm")
        self.assertEqual(metadata["outputUnits"], "m")
        self.assertEqual(metadata["converter"]["version"], "4.3.2")
        self.assertEqual(metadata["dimensionsM"], inspect_product_glb(product_glb())["dimensionsM"])
        command, options = self.calls[-1]
        for flag in ("--factory-startup", "--disable-autoexec", "--python-exit-code"):
            self.assertIn(flag, command)
        self.assertEqual(options["timeout"], 120)
        copied = Path(command[command.index("--input") + 1])
        self.assertNotEqual(copied, self.source)
        self.assertEqual(copied.parent.parent, self.root)
        self.assertFalse(copied.parent.exists())
        self.assertEqual(set(self.root.iterdir()), {self.source, self.output})
        self.assertNotIn(str(self.root), json.dumps(metadata))

    def test_invalid_axis_units_suffix_or_destination_never_runs_blender(self):
        with patch.object(mesh_import.subprocess, "run") as run:
            for kwargs, message in (({"source_up": "X"}, "source_up"), ({"units": "pixels"}, "units")):
                with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, message):
                    self.prepare(**kwargs)
            for suffix in (".gltf", ".blend", ".step", ".glb"):
                with self.subTest(suffix=suffix), self.assertRaisesRegex(ValueError, "support"):
                    mesh_import.prepare_product_mesh(self.source.with_suffix(suffix), self.output)
            with self.assertRaisesRegex(ValueError, "filename"):
                mesh_import.prepare_product_mesh(self.source, self.root / "out.obj")
            self.output.write_bytes(b"existing asset")
            with self.assertRaisesRegex(ValueError, "already exists"):
                self.prepare()
            self.assertEqual(self.output.read_bytes(), b"existing asset")
            run.assert_not_called()

    def test_rejects_external_obj_dependencies_without_reading_them(self):
        for statement in ("mtllib /etc/passwd", "usemtl hidden", "mtllib https://example.com/private.mtl",
                          "call ../other.obj", "csh echo hello", "maplib texture", "shadow_obj ../secret.obj"):
            with self.subTest(statement=statement), patch.object(mesh_import.subprocess, "run") as run:
                self.source.write_bytes(obj_bytes() + statement.encode() + b"\n")
                with self.assertRaisesRegex(ValueError, "self-contained GLB"):
                    self.prepare()
                run.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_rejects_empty_nonfinite_invalid_and_curve_obj(self):
        for payload, message in ((b"", "128 MiB"), (b"v nan 0 0\nf 1 1 1\n", "finite"),
                                 (b"v 1 2 3\nf 1 2 3\n", "unknown vertex"),
                                 (b"v 1 2 3\n", "polygon faces"),
                                 (b"v 1 2 3\nl 1 1\n", "Unsupported OBJ"),
                                 (obj_bytes() + b"f 1/1 2/1 3/1\n", "unknown texture")):
            with self.subTest(payload=payload), patch.object(mesh_import.subprocess, "run") as run:
                self.source.write_bytes(payload)
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare()
                run.assert_not_called()

    def test_preflight_handles_both_stl_and_ply_encodings(self):
        for suffix, payload in ((".stl", stl_bytes()), (".stl", stl_bytes(ascii_=True)),
                                (".ply", ply_bytes()), (".ply", ply_bytes(binary=True))):
            with self.subTest(suffix=suffix, binary=b"binary" in payload[:100]):
                mesh_import._preflight(payload, suffix)

    def test_rejects_point_clouds_bad_ply_lists_and_nonfinite_binary(self):
        point_cloud = b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n"
        bad_index = ply_bytes().replace(b"4 0 3 2 1\n", b"4 0 3 2 99\n")
        bad_count = ply_bytes().replace(b"4 0 3 2 1\n", b"255 0 3 2 1\n")
        nonfinite = bytearray(stl_bytes())
        struct.pack_into("<f", nonfinite, 96, float("nan"))
        for payload, suffix, message in ((point_cloud, ".ply", "polygon faces"), (bad_index, ".ply", "unknown vertex"),
                                         (bad_count, ".ply", "row"), (bytes(nonfinite), ".stl", "finite"),
                                         (b"solid x\n", ".stl", "missing endsolid"),
                                         (ply_bytes(binary=True)[:-1], ".ply", "Truncated")):
            with self.subTest(suffix=suffix, message=message), self.assertRaisesRegex(ValueError, message):
                mesh_import._preflight(payload, suffix)

    def test_rejects_oversize_source_before_read_or_blender(self):
        with patch.object(mesh_import, "MAX_SOURCE_BYTES", 3), patch.object(mesh_import.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "128 MiB"):
                self.prepare()
            run.assert_not_called()

    def test_missing_or_wrong_blender_is_actionable_and_leaves_no_output(self):
        for effect in (FileNotFoundError("blender"), subprocess.TimeoutExpired("blender", 15),
                       subprocess.CompletedProcess([], 0, "Blender 4.4.0\n")):
            with self.subTest(effect=effect), patch.object(mesh_import.subprocess, "run") as run:
                if isinstance(effect, Exception):
                    run.side_effect = effect
                else:
                    run.return_value = effect
                with self.assertRaisesRegex(ValueError, "Blender"):
                    self.prepare()
                self.assertEqual(set(self.root.iterdir()), {self.source})

    def test_timeout_and_failed_worker_remove_all_partial_files(self):
        for failure in ("timeout", "failed", "invalid-output", "invalid-report", "missing-output"):
            def worker(command, **kwargs):
                if "--version" in command:
                    return self.run_blender(command, **kwargs)
                Path(command[command.index("--output") + 1]).write_bytes(b"partial")
                if failure == "timeout":
                    raise subprocess.TimeoutExpired(command, 120)
                if failure == "failed":
                    kwargs["stdout"].write(b"fixture mesh rejected")
                    return subprocess.CompletedProcess(command, 1)
                if failure == "missing-output":
                    return subprocess.CompletedProcess(command, 0)
                result = self.run_blender(command, **kwargs)
                target = "--output" if failure == "invalid-output" else "--report"
                Path(command[command.index(target) + 1]).write_bytes(b"invalid")
                return result
            with self.subTest(failure=failure), patch.object(mesh_import.subprocess, "run", side_effect=worker):
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertEqual(set(self.root.iterdir()), {self.source})

    def test_exclusive_commit_preserves_concurrently_created_output(self):
        def worker(command, **kwargs):
            result = self.run_blender(command, **kwargs)
            if "--version" not in command:
                self.output.write_bytes(b"other import won")
            return result
        with patch.object(mesh_import.subprocess, "run", side_effect=worker):
            with self.assertRaisesRegex(ValueError, "already exists"):
                self.prepare()
        self.assertEqual(self.output.read_bytes(), b"other import won")
        self.assertFalse(list(self.root.glob(".mesh-import-*")))


@unittest.skipUnless(os.environ.get("RUN_BLENDER_TESTS") == "1" and shutil.which("blender"),
                     "Set RUN_BLENDER_TESTS=1 with pinned Blender 4.3.2 for real mesh imports")
class RealBlenderMeshImportTests(unittest.TestCase):
    def test_far_origin_and_unused_vertices_do_not_shift_actual_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "offset.obj", root / "normalized.glb"
            lines = []
            for line in obj_bytes().decode().splitlines():
                if line.startswith("v "):
                    values = line.split()
                    values[1:4] = [str(float(value) + 1_000_000) for value in values[1:4]]
                    line = " ".join(values)
                lines.append(line)
            # An orphan vertex is not part of the rendered polygon bounds.
            source.write_text("\n".join(lines) + "\nv 9000000 9000000 9000000\n")
            metadata = mesh_import.prepare_product_mesh(source, output, units="mm")
            self.assertEqual(metadata["normalization"]["centerSourceUnits"], [1000011, 1000022, 1000033])
            for actual, wanted in zip(metadata["dimensionsM"], (.002, .004, .006)):
                self.assertAlmostEqual(actual, wanted, places=8)
            for low, high in zip(*metadata["boundsM"]):
                self.assertAlmostEqual(low + high, 0, places=8)

    def test_actual_obj_stl_ply_match_declared_units_axes_and_center(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for suffix, payload in ((".obj", obj_bytes()), (".stl", stl_bytes()), (".ply", ply_bytes(binary=True))):
                for up in ("Y", "Z"):
                    with self.subTest(format=suffix, up=up):
                        source = root / ("source" + suffix)
                        source.write_bytes(payload)
                        metadata = mesh_import.prepare_product_mesh(source, root / f"{suffix[1:]}-{up}.glb", source_up=up, units="mm")
                        expected = (.002, .004, .006) if up == "Y" else (.002, .006, .004)
                        for actual, wanted in zip(metadata["dimensionsM"], expected):
                            self.assertAlmostEqual(actual, wanted, places=7)
                        for low, high in zip(*metadata["boundsM"]):
                            self.assertAlmostEqual(low + high, 0, places=7)
                        self.assertEqual(metadata["normalization"]["centerSourceUnits"], [11, 22, 33])
                        self.assertEqual(metadata["normalization"]["triangleCount"], 12)
                        self.assertEqual(metadata["normalization"]["scaleToMeters"], .001)
                        document = glb_document((root / f"{suffix[1:]}-{up}.glb").read_bytes())
                        self.assertFalse(document.get("animations"))
                        self.assertFalse(document.get("skins"))
                        self.assertTrue(all(primitive.get("mode", 4) == 4 for mesh in document["meshes"] for primitive in mesh["primitives"]))
                        self.assertTrue(all("uri" not in buffer for buffer in document.get("buffers", [])))
                        if suffix == ".stl":
                            self.assertIn("geometry only", metadata["limitations"][0])

    def test_actual_obj_parts_and_obj_ply_vertex_colors_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for suffix, payload in ((".obj", obj_bytes(two_objects=True)), (".ply", ply_bytes())):
                with self.subTest(format=suffix):
                    source, output = root / ("source" + suffix), root / (suffix[1:] + ".glb")
                    source.write_bytes(payload)
                    metadata = mesh_import.prepare_product_mesh(source, output, units="cm")
                    payload = output.read_bytes()
                    document = glb_document(payload)
                    self.assertTrue(all("COLOR_0" in primitive["attributes"] for mesh in document["meshes"] for primitive in mesh["primitives"]))
                    colors = glb_colors(payload, document)
                    for expected in ((1, 0, 0), (0, 0, 1)):
                        self.assertTrue(any(max(abs(value - wanted) for value, wanted in zip(color, expected)) < 1e-5 for color in colors))
                    if suffix == ".obj":
                        self.assertEqual(metadata["normalization"]["objectCount"], 2)
                        self.assertEqual(len(document["meshes"]), 2)
                        self.assertEqual({item["name"] for item in document["meshes"]}, {"first part", "second part"})
                        self.assertTrue(any(max(abs(value - wanted) for value, wanted in zip(color, (0, 1, 0))) < 1e-5 for color in colors))
                    for material in document.get("materials", []):
                        self.assertEqual(material.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1]), [1, 1, 1, 1])


if __name__ == "__main__":
    unittest.main()
