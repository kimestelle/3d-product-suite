"""Analytic Gaussian and local fixture checks for experimental reconstruction."""

import importlib.util
import json
import hashlib
import math
from pathlib import Path
import struct
import shutil
import subprocess
import tempfile
import unittest

from film.splat_mesh import convert_splat
from film.worlds import _validate_content


ROOT = Path(__file__).resolve().parents[1]
NUMERICAL_STACK = all(importlib.util.find_spec(package) for package in ("numpy", "scipy", "skimage"))
SH_C0 = 0.28209479177387814


def write_gaussians(path, rows):
    names = ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {len(rows)}\n"
    header += "".join(f"property float {name}\n" for name in names) + "end_header\n"
    data = bytearray(header.encode())
    for row in rows:
        mean, scale, color, alpha, quaternion = row
        values = [*mean, *((channel - 0.5) / SH_C0 for channel in color), math.log(alpha / (1 - alpha)),
                  *(math.log(radius) for radius in scale), *quaternion]
        data.extend(struct.pack("<14f", *values))
    path.write_bytes(data)


def read_glb(path):
    import numpy as np
    payload = path.read_bytes()
    _validate_content(payload, "glb", path.name)
    size = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + size])
    binary = payload[20 + size + 8:]

    def accessor(index):
        item = document["accessors"][index]
        view = document["bufferViews"][item["bufferView"]]
        width = {"SCALAR": 1, "VEC3": 3}[item["type"]]
        values = np.frombuffer(binary, dtype={5126: "<f4", 5125: "<u4"}[item["componentType"]],
                               count=item["count"] * width, offset=view.get("byteOffset", 0))
        return values.reshape(-1, width)

    primitive = document["meshes"][0]["primitives"][0]
    return {"vertices": accessor(primitive["attributes"]["POSITION"]), "normals": accessor(primitive["attributes"]["NORMAL"]),
            "colors": accessor(primitive["attributes"]["COLOR_0"]), "faces": accessor(primitive["indices"]).reshape(-1, 3), "document": document}


class ReconstructionBoundsTests(unittest.TestCase):
    def test_unbounded_resolution_and_invalid_axis_rejected_before_loading(self):
        with self.assertRaisesRegex(ValueError, "resolution"):
            convert_splat("missing.ply", "output.glb", resolution=256)
        with self.assertRaisesRegex(ValueError, "source_up"):
            convert_splat("missing.ply", "output.glb", source_up="unknown")


@unittest.skipUnless(NUMERICAL_STACK, "Install requirements-worlds.txt for Gaussian density reconstruction tests")
class GaussianDensityMeshTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node") and (ROOT / "web/node_modules/@sparkjsdev/spark/package.json").is_file(),
                         "Install the pinned web dependencies for the real Spark SPZ codec integration")
    def test_real_spark_spz_density_conversion_is_reproducible(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "ellipsoid.ply"
            write_gaussians(source, [([0.3, 0.4, 0.5], [0.3, 0.15, 0.1], [0.1, 0.6, 0.2], 0.9, [1, 0, 0, 0])])
            spz = root / "ellipsoid.spz"
            code = r'''
import * as fs from 'node:fs/promises';
import {decodeFile,closeDecoderWorkers} from './scripts/decode_splat.mjs';
try {
 await decodeFile({input:process.argv[1],output:process.argv[2]+'.f32'});
 const {PackedSplats,SplatFileType,writeSpz}=await import('./web/node_modules/@sparkjsdev/spark/dist/spark.module.js');
 const packed=new PackedSplats({fileBytes:await fs.readFile(process.argv[1]),fileType:SplatFileType.PLY});
 await packed.initialized;
 const result=await writeSpz(packed,{version:3,maxSh:0});
 await fs.writeFile(process.argv[2],result.fileBytes);
 packed.dispose();
} finally {await closeDecoderWorkers();}
'''
            result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", code, str(source), str(spz)],
                                    cwd=ROOT, text=True, capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            first = convert_splat(spz, root / "first.glb", resolution=48)
            second = convert_splat(spz, root / "second.glb", resolution=48)
            reference = convert_splat(source, root / "reference.glb", resolution=48)
            self.assertEqual(first["sourceSha256"], hashlib.sha256(spz.read_bytes()).hexdigest())
            self.assertEqual(first["output"]["sha256"], second["output"]["sha256"])
            self.assertNotIn("output", first["decoder"])
            self.assertIn("@sparkjsdev/spark@2.3.1", first["decoder"]["decoder"])
            self.assertTrue(np.allclose(first["geometry"]["boundsSourceUnits"]["min"], reference["geometry"]["boundsSourceUnits"]["min"],
                                        atol=first["grid"]["voxelSizeSourceUnits"]))

    def test_anisotropic_gaussian_matches_analytic_isosurface_and_outward_normals(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "ellipsoid.ply"
            scales = np.array([0.3, 0.2, 0.1])
            write_gaussians(source, [([0, 0, 0], scales, [0.8, 0.2, 0.1], 0.9, [1, 0, 0, 0])])
            output = root / "surface.glb"
            metadata = convert_splat(source, output, resolution=64)
            mesh = read_glb(output)
            expected_radii = scales * math.sqrt(2 * math.log(0.9 / 0.5))
            voxel = metadata["grid"]["voxelSizeSourceUnits"]
            self.assertTrue(np.all(np.abs(mesh["vertices"].max(axis=0) - expected_radii) < voxel), (mesh["vertices"].max(axis=0), expected_radii, voxel))
            self.assertTrue(np.all(np.abs(mesh["vertices"].min(axis=0) + expected_radii) < voxel))
            expected_normals = mesh["vertices"] / scales ** 2
            expected_normals /= np.linalg.norm(expected_normals, axis=1)[:, None]
            self.assertGreater(float(np.mean(np.sum(expected_normals * mesh["normals"], axis=1))), 0.98)
            self.assertTrue(np.allclose(mesh["colors"], [0.8, 0.2, 0.1], atol=1e-5))
            # A closed ellipsoid has each undirected triangle edge used twice.
            edges = np.sort(mesh["faces"][:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
            _, counts = np.unique(edges, axis=0, return_counts=True)
            self.assertTrue(np.all(counts == 2))
            a, b, c = (mesh["vertices"][mesh["faces"][:, index]] for index in range(3))
            self.assertGreater(float(np.sum(a * np.cross(b, c)) / 6), 0)
            sidecar = json.loads(output.with_suffix(".glb.reconstruction.json").read_text())
            self.assertEqual(sidecar["output"]["sha256"], metadata["output"]["sha256"])
            self.assertTrue(sidecar["experimental"])
            with self.assertRaisesRegex(ValueError, "already exists"):
                convert_splat(source, output, resolution=64)

    def test_quaternion_covariance_and_source_z_up_preserve_geometry_and_colours(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "rotated.ply"
            # Local long X rotates onto native Y, which becomes canonical -Z.
            quaternion = [math.cos(math.pi / 4), 0, 0, math.sin(math.pi / 4)]
            write_gaussians(source, [([0.3, 0.4, 0.5], [0.3, 0.15, 0.1], [0.1, 0.6, 0.2], 0.9, quaternion)])
            output = root / "canonical.glb"
            metadata = convert_splat(source, output, resolution=64, source_up="Z")
            vertices = read_glb(output)["vertices"]
            centre = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
            self.assertTrue(np.allclose(centre, [0.3, 0.5, -0.4], atol=metadata["grid"]["voxelSizeSourceUnits"]))
            extents = vertices.max(axis=0) - vertices.min(axis=0)
            self.assertGreater(extents[2], extents[0])
            self.assertGreater(extents[0], extents[1])
            self.assertEqual(metadata["outputSourceUp"], "Y")
            self.assertEqual(metadata["sourceUp"], "Z")

    def test_threshold_changes_real_density_surface_and_colour_transfer_is_spatial(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "two-colours.ply"
            write_gaussians(source, [([-0.45, 0, 0], [0.2] * 3, [0.9, 0.05, 0.05], 0.9, [1, 0, 0, 0]),
                                    ([0.45, 0, 0], [0.2] * 3, [0.05, 0.05, 0.9], 0.9, [1, 0, 0, 0])])
            low, high = root / "low.glb", root / "high.glb"
            convert_splat(source, low, resolution=48, iso_level=0.3)
            convert_splat(source, high, resolution=48, iso_level=0.6)
            lower, higher = read_glb(low), read_glb(high)
            self.assertGreater(float(np.ptp(lower["vertices"][:, 0])), float(np.ptp(higher["vertices"][:, 0])))
            left = lower["colors"][lower["vertices"][:, 0] < -0.3].mean(axis=0)
            right = lower["colors"][lower["vertices"][:, 0] > 0.3].mean(axis=0)
            self.assertGreater(left[0], left[2] * 5)
            self.assertGreater(right[2], right[0] * 5)

    def test_same_geometry_room_fixture_produces_bounded_coloured_visual_mesh(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "room.glb"
            metadata = convert_splat(ROOT / "examples/worlds/neutral-room.ply", output, resolution=48, max_splats=4000)
            mesh = read_glb(output)
            self.assertGreater(metadata["geometry"]["triangles"], 100)
            self.assertLessEqual(metadata["grid"]["voxelCount"], 48 ** 3)
            self.assertEqual(metadata["selection"]["usedSplats"], 4000)
            self.assertGreater(metadata["grid"]["radiusFlooredAxes"], 0)
            self.assertEqual(metadata["output"]["format"], "glb")
            self.assertGreater(len(set(tuple(round(float(channel), 2) for channel in color) for color in mesh["colors"])), 3)


if __name__ == "__main__":
    unittest.main()
