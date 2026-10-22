"""Conversion boundaries plus opt-in native CAD and Blender exchange tests."""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from film import cad_import
from film.products import inspect_product_glb, _IDENTITY, _accessor_rows, _multiply, _node_matrix
from tests.test_products import product_glb

CAD_PYTHON = os.environ.get('GESSO_TEST_CAD_PYTHON')
BLENDER = os.environ.get('GESSO_TEST_BLENDER')
ROOT = Path(__file__).resolve().parents[1]


def document(path):
    payload = path.read_bytes()
    length = struct.unpack_from('<I', payload, 12)[0]
    return json.loads(payload[20:20 + length]), payload[28 + length:]


def mesh_centres(path):
    doc, binary = document(path)
    result = {}
    def visit(index, parent):
        node = doc['nodes'][index]
        matrix = _multiply(parent, _node_matrix(node))
        points = []
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                for p in _accessor_rows(doc, [binary], primitive['attributes']['POSITION'], positions=True):
                    points.append([sum(matrix[r][c] * p[c] for c in range(3)) + matrix[r][3] for r in range(3)])
            result[node.get('name')] = [(min(p[a] for p in points) + max(p[a] for p in points)) / 2 for a in range(3)]
        for child in node.get('children', []):
            visit(child, matrix)
    for root in doc['scenes'][0]['nodes']:
        visit(root, _IDENTITY)
    return result


class CadConversionBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'part.step'
        self.source.write_bytes(b'ISO-10303-21; synthetic wrapper fixture')
        self.output = self.root / 'result.glb'
        self.paths = []

    def successful_worker(self, command, **kwargs):
        output = Path(command[command.index('--output') + 1])
        report = Path(command[command.index('--report') + 1])
        self.paths += [output, report]
        output.write_bytes(product_glb())
        report.write_text(json.dumps({'sourceFormat': 'step', 'sourceUnits': ['millimetre'], 'warnings': []}))
        self.assertFalse(kwargs.get('shell'))
        self.assertGreater(kwargs['timeout'], 0)
        return subprocess.CompletedProcess(command, 0)

    def test_validates_atomic_publish_and_preserves_source(self):
        before = self.source.read_bytes()
        self.output.write_bytes(b'previous good asset')
        with patch.object(cad_import.subprocess, 'run', side_effect=self.successful_worker) as run:
            report = cad_import.convert_cad_product(self.source, self.output, python='/configured/python', source_up='y')
        self.assertEqual(run.call_args.args[0][0], '/configured/python')
        self.assertEqual(report['sourceSha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.output.read_bytes(), product_glb())
        self.assertTrue(all(not p.exists() for p in self.paths))

    def test_worker_failure_preserves_destination_and_cleans(self):
        def fail(command, **kwargs):
            self.successful_worker(command, **kwargs)
            self.paths[-1].write_text(json.dumps({'error': 'Missing CAD surface'}))
            return subprocess.CompletedProcess(command, 1)
        self.output.write_bytes(b'previous good asset')
        with patch.object(cad_import.subprocess, 'run', side_effect=fail), self.assertRaisesRegex(ValueError, 'Missing CAD surface'):
            cad_import.convert_cad_product(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b'previous good asset')
        self.assertTrue(all(not p.exists() for p in self.paths))

    def test_malformed_worker_output_never_publishes(self):
        def malformed(command, **kwargs):
            result = self.successful_worker(command, **kwargs)
            self.paths[0].write_bytes(b'invalid glb')
            return result
        self.output.write_bytes(b'previous good asset')
        with patch.object(cad_import.subprocess, 'run', side_effect=malformed), self.assertRaises(ValueError):
            cad_import.convert_cad_product(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b'previous good asset')
        self.assertTrue(all(not p.exists() for p in self.paths))

    def test_timeout_is_actionable_and_preserves_destination(self):
        self.output.write_bytes(b'previous good asset')
        with patch.object(cad_import.subprocess, 'run', side_effect=subprocess.TimeoutExpired('cad', 180)), self.assertRaisesRegex(ValueError, 'exceeded 180'):
            cad_import.convert_cad_product(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b'previous good asset')

    def test_source_change_never_publishes(self):
        def changed(command, **kwargs):
            result = self.successful_worker(command, **kwargs)
            self.source.write_bytes(b'changed during conversion')
            return result
        with patch.object(cad_import.subprocess, 'run', side_effect=changed), self.assertRaisesRegex(ValueError, 'changed during import'):
            cad_import.convert_cad_product(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_mesh_requires_known_units_and_axes_before_launch(self):
        for units, axis in [('auto', 'z'), ('mm', 'x'), ('', 'z'), (None, 'z')]:
            with self.subTest(units=units, axis=axis), patch.object(cad_import.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    cad_import.convert_mesh_product(self.source, self.output, source_units=units, source_up=axis)
                run.assert_not_called()


@unittest.skipUnless(CAD_PYTHON, 'Set GESSO_TEST_CAD_PYTHON to run native OpenCascade tests')
class NativeCadImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        subprocess.run([CAD_PYTHON, str(ROOT / 'tests' / 'cad_import_fixtures.py'), str(cls.root)],
                       check=True, capture_output=True, timeout=60)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def convert(self, name, up='z'):
        output = self.root / (name + up + '.glb')
        report = cad_import.convert_cad_product(self.root / name, output, source_up=up, python=CAD_PYTHON)
        return output, report

    def assert_dimensions(self, report, expected):
        for actual, wanted in zip(report['dimensionsM'], expected):
            self.assertAlmostEqual(actual, wanted, places=6)

    def test_step_declared_mm_and_metres_and_axis_conversion(self):
        for name, up, expected in [('box-mm.step', 'z', [.01, .03, .02]),
                                    ('box-mm.step', 'y', [.01, .02, .03]),
                                    ('box-m.stp', 'z', [10, 30, 20])]:
            with self.subTest(name=name, up=up):
                _, report = self.convert(name, up)
                self.assert_dimensions(report, expected)
                self.assertEqual(report['sourceFaceCount'], 6)

    def test_named_instances_keep_hierarchy_colour_and_axis_sign(self):
        output, report = self.convert('assembly.step')
        self.assert_dimensions(report, [.05, .037, .025])
        doc, _ = document(output)
        nodes = {node['name']: node for node in doc['nodes']}
        self.assertEqual(len(nodes['Bottle assembly']['children']), 2)
        self.assertIn('Cap 1', nodes)
        self.assertIn('Cap 2', nodes)
        colours = [m.get('pbrMetallicRoughness', {}).get('baseColorFactor') for m in doc['materials']]
        self.assertTrue(any(c and abs(c[0] - .8) < 1e-5 and abs(c[1] - .1) < 1e-5 for c in colours))
        centres = mesh_centres(output)
        for name, expected in [('Cap 1', [-.020, -.0035, .0025]), ('Cap 2', [.020, .0035, -.0025])]:
            for actual, wanted in zip(centres[name], expected):
                self.assertAlmostEqual(actual, wanted, places=6)

    def test_iges_open_sheet_and_declared_inches(self):
        _, report = self.convert('sheet.iges')
        self.assert_dimensions(report, [.01, .03, .02])
        self.assertEqual(report['sourceFaceCount'], 1)
        self.assertEqual(report['sourceSolidCount'], 0)
        source = (self.root / 'sheet.iges').read_text()
        self.assertIn(',1.,2,2HMM,', source)
        (self.root / 'sheet-inch.iges').write_text(source.replace(',1.,2,2HMM,', ',1.,1,2HIN,'))
        _, report = self.convert('sheet-inch.iges')
        self.assert_dimensions(report, [.254, .762, .508])

    def test_iges_group_does_not_duplicate_surface_geometry(self):
        output, report = self.convert('assembly.igs')
        doc, _ = document(output)
        emitted = sum(doc['accessors'][p['indices']]['count'] // 3 for m in doc['meshes'] for p in m['primitives'])
        self.assertEqual(emitted, report['triangleCount'])
        self.assertEqual(emitted, 24)

    def test_malformed_cad_keeps_existing_asset(self):
        source = self.root / 'broken.step'
        source.write_text('not a STEP document')
        output = self.root / 'existing.glb'
        output.write_bytes(b'previous good asset')
        with self.assertRaisesRegex(ValueError, 'Could not read'):
            cad_import.convert_cad_product(source, output, python=CAD_PYTHON)
        self.assertEqual(output.read_bytes(), b'previous good asset')


@unittest.skipUnless(BLENDER, 'Set GESSO_TEST_BLENDER to run real OBJ/STL tests')
class NativeMeshImportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.obj = self.root / 'parts.obj'
        self.obj.write_text('o Sheet\nv 0 0 0\nv 10 0 5\nv 0 20 30\nf -3 -2 -1\n')
        self.stl = self.root / 'sheet.stl'
        # Binary STL beginning with "solid" must not be mistaken for ASCII.
        self.stl.write_bytes(b'solid binary fixture'.ljust(80, b'\0') + struct.pack('<I12fH', 1, 0, 0, 1, 0, 0, 0, 10, 0, 5, 0, 20, 30, 0))

    def test_obj_and_binary_stl_units_and_axes(self):
        for source in (self.obj, self.stl):
            for units, up, expected in [('mm', 'z', [.01, .03, .02]), ('cm', 'y', [.1, .2, .3])]:
                with self.subTest(format=source.suffix, units=units, up=up):
                    output = self.root / (source.name + units + up + '.glb')
                    report = cad_import.convert_mesh_product(source, output, source_units=units, source_up=up, blender=BLENDER)
                    for actual, wanted in zip(report['dimensionsM'], expected):
                        self.assertAlmostEqual(actual, wanted, places=6)

    def test_obj_external_materials_are_not_silently_dropped(self):
        self.obj.write_text('mtllib missing.mtl\n' + self.obj.read_text())
        output = self.root / 'preserved.glb'
        output.write_bytes(b'previous good asset')
        with self.assertRaisesRegex(ValueError, 'companion files'):
            cad_import.convert_mesh_product(self.obj, output, source_units='mm', source_up='z', blender=BLENDER)
        self.assertEqual(output.read_bytes(), b'previous good asset')
