"""Headless OpenCascade worker. Run through film.cad_import, never in the server process."""
from __future__ import annotations
import argparse
import json
import math
import re
from pathlib import Path
import struct
import sys

MAX_FACES = 100000
MAX_TRIANGLES = 2000000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def normalize_glb(output, source_up):
    """Add one rigid root transform; retain original part nodes and materials."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from film.products import _IDENTITY, _accessor_rows, _multiply, _node_matrix
    payload = output.read_bytes()
    length = struct.unpack_from('<I', payload, 12)[0]
    doc = json.loads(payload[20:20 + length])
    binary = payload[28 + length:]
    rotation = ((1., 0., 0., 0.), (0., 0., 1., 0.), (0., -1., 0., 0.), (0., 0., 0., 1.)) if source_up == 'z' else _IDENTITY
    low, high = [math.inf] * 3, [-math.inf] * 3
    roots = doc['scenes'][doc.get('scene', 0)]['nodes']
    seen = set()
    def visit(index, parent, depth=0):
        require(depth <= 80 and index not in seen, 'CAD hierarchy is cyclic or exceeds 80 levels')
        seen.add(index)
        node = doc['nodes'][index]
        matrix = _multiply(parent, _node_matrix(node))
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                for point in _accessor_rows(doc, [binary], primitive['attributes']['POSITION'], positions=True):
                    for axis in range(3):
                        value = sum(matrix[axis][c] * point[c] for c in range(3)) + matrix[axis][3]
                        require(math.isfinite(value), 'CAD contains nonfinite geometry')
                        low[axis] = min(low[axis], value)
                        high[axis] = max(high[axis], value)
        for child in node.get('children', []):
            visit(child, matrix, depth + 1)
    for root in roots:
        visit(root, rotation)
    require(all(math.isfinite(v) for v in low + high), 'CAD contains no tessellated surfaces')
    center = [(a + b) / 2 for a, b in zip(low, high)]
    transform = [rotation[r][c] if c < 3 or r == 3 else -center[r] for c in range(4) for r in range(4)]
    doc['nodes'].append({'name': 'Product', 'children': roots[:], 'matrix': transform})
    doc['scenes'][0]['nodes'] = [len(doc['nodes']) - 1]
    # OpenCascade has no PBR material for plain geometry; provide a neutral
    # surface instead of pretending a CAD display colour is measured material.
    neutral = None
    for mesh in doc['meshes']:
        for primitive in mesh['primitives']:
            if 'material' not in primitive:
                if neutral is None:
                    materials = doc.setdefault('materials', [])
                    neutral = len(materials)
                    materials.append({'name': 'CAD surface', 'pbrMetallicRoughness': {
                        'baseColorFactor': [.65, .65, .65, 1], 'metallicFactor': 0, 'roughnessFactor': .45}})
                primitive['material'] = neutral
    # Surface-only CAD sheets have no thickness: retain them as two-sided
    # surfaces rather than silently discarding their back faces in the viewer.
    for material in doc.get('materials', []):
        material['doubleSided'] = True
    names = [n.get('name', '') for n in doc['nodes'][:-1]]
    part_number, group_number = 0, 0
    for node in doc['nodes'][:-1]:
        if not node.get('name') or re.match(r'^=>\[', node['name']):
            node.setdefault('extras', {})['cadSourceName'] = node.get('name', '')
            if 'mesh' in node:
                part_number += 1
                node['name'] = f'Part {part_number:02}'
            else:
                group_number += 1
                node['name'] = f'Group {group_number:02}'
    text = json.dumps(doc, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    binary += b'\0' * (-len(binary) % 4)
    body = struct.pack('<II', len(text), 0x4E4F534A) + text + struct.pack('<II', len(binary), 0x004E4942) + binary
    output.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body)
    return {'objectCount': len(doc['nodes']) - 1, 'meshCount': len(doc['meshes']),
            'sourceNames': names[:200], 'sourceNamesTruncated': len(names) > 200}


def convert(source, output, source_up):
    try:
        import OCP
        from OCP.Bnd import Bnd_Box
        from OCP.BRep import BRep_Tool
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.IGESCAFControl import IGESCAFControl_Reader
        from OCP.Interface import Interface_Static
        from OCP.Message import Message_ProgressRange
        from OCP.RWGltf import RWGltf_CafWriter
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
        from OCP.TColStd import TColStd_IndexedDataMapOfStringString, TColStd_SequenceOfAsciiString
        from OCP.TDF import TDF_LabelSequence, TDF_Label, TDF_Tool
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_SHELL, TopAbs_COMPOUND, TopAbs_COMPSOLID
        from OCP.TopExp import TopExp
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS
        from OCP.TopTools import TopTools_IndexedMapOfShape
        from OCP.XCAFDoc import XCAFDoc_DocumentTool
    except ImportError as error:
        raise ValueError('STEP/IGES import needs the optional CAD reader. Install the project with pip install -e ".[cad]" under Python 3.12, or set GESSO_CAD_PYTHON to that environment.') from error
    require(source_up in {'y', 'z'}, 'Choose source Y-up or Z-up')
    doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    # Normalize the reader's internal units to mm, not the source file's units.
    # STEP/IGES still applies the scale declared in the source document.
    XCAFDoc_DocumentTool.SetLengthUnit_s(doc, .001)
    Interface_Static.SetCVal_s('xstep.cascade.unit', 'MM')
    step = source.suffix.lower() in {'.step', '.stp'}
    if step:
        require(not re.search(rb'#[0-9]+\s*=\s*DOCUMENT_FILE\s*\(', source.read_bytes(), re.IGNORECASE), 'This STEP references companion documents. Export one self-contained STEP assembly before importing')
    reader = STEPCAFControl_Reader() if step else IGESCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(True)
    require(reader.ReadFile(str(source)) == IFSelect_RetDone, 'Could not read this STEP/IGES file; export a fresh STEP AP214/AP242 or IGES from its source application')
    if step:
        lengths, angles, solids = (TColStd_SequenceOfAsciiString() for _ in range(3))
        reader.Reader().FileUnits(lengths, angles, solids)
        source_units = [lengths.Value(i).ToCString() for i in range(1, lengths.Length() + 1)]
        require(source_units, 'STEP does not declare length units; export again with explicit units')
    else:
        header = reader.IGESModel().GlobalSection()
        source_units = [header.UnitName().ToCString()] if header.UnitName() else [f'IGES unit {header.UnitFlag()}']
        require(header.UnitFlag() in {1, 2, 4, 5, 6, 7, 8, 9, 10, 11}, 'IGES uses unspecified or custom length units; export with standard units')
    require(reader.Transfer(doc), 'CAD transfer failed; repair or re-export its surfaces in the source application')
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    labels = TDF_LabelSequence()
    tool.GetFreeShapes(labels)
    require(0 < labels.Length() <= 10000, 'CAD must contain a bounded product assembly')
    # A CAD leaf can contain many solids/surface shells. Expose those as
    # child objects while leaving real assemblies and solid faces intact.
    expanded, visited = 0, set()
    def expand_parts(label, depth=0):
        nonlocal expanded
        require(depth <= 80 and len(visited) <= 10000, 'CAD assembly exceeds supported hierarchy limits')
        referred = TDF_Label()
        if tool.GetReferredShape_s(label, referred):
            label = referred
        key = TCollection_AsciiString()
        TDF_Tool.Entry_s(label, key)
        key = key.ToCString()
        if key in visited:
            return
        visited.add(key)
        shape = tool.GetShape_s(label)
        physical_parts = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(shape, TopAbs_SHELL, physical_parts)
        # Expanding raw IGES face compounds can duplicate colour-labelled
        # subfaces in XDE. Keep those sheets in their source grouping.
        if physical_parts.Extent() and not tool.IsAssembly_s(label) and shape.ShapeType() in {TopAbs_COMPOUND, TopAbs_COMPSOLID}:
            if tool.Expand(label):
                expanded += 1
        children = TDF_LabelSequence()
        if tool.GetComponents_s(label, children):
            for number in range(1, children.Length() + 1):
                expand_parts(children.Value(number), depth + 1)
    for i in range(1, labels.Length() + 1):
        expand_parts(labels.Value(i))
    tool.UpdateAssemblies()
    faces, solids, shells = (TopTools_IndexedMapOfShape() for _ in range(3))
    bounds = Bnd_Box()
    shapes = []
    for i in range(1, labels.Length() + 1):
        shape = tool.GetShape_s(labels.Value(i))
        shapes.append(shape)
        BRepBndLib.Add_s(shape, bounds)
        for kind, index in ((TopAbs_FACE, faces), (TopAbs_SOLID, solids), (TopAbs_SHELL, shells)):
            TopExp.MapShapes_s(shape, kind, index)
    require(0 < faces.Extent() <= MAX_FACES, 'CAD must contain surfaces and no more than 100,000 faces; simplify it before import')
    bbox = bounds.Get()
    extent = max(bbox[i + 3] - bbox[i] for i in range(3))
    require(math.isfinite(extent) and 0 < extent <= 1000000, 'CAD dimensions are invalid or exceed 1000 metres; check document units')
    # Tolerance scales with the product, with an explicit report. No geometry
    # is silently decimated after conversion.
    deflection = max(.01, min(.25, extent * .0005))
    for shape in shapes:
        mesher = BRepMesh_IncrementalMesh(shape, deflection, False, .15, True)
        require(mesher.IsDone(), 'CAD meshing failed; repair its surfaces before importing')
    triangle_count = 0
    for i in range(1, faces.Extent() + 1):
        tri = BRep_Tool.Triangulation_s(TopoDS.Face_s(faces.FindKey(i)), TopLoc_Location())
        require(tri is not None and tri.NbTriangles() > 0, 'Some CAD surfaces could not be tessellated; repair or re-export the file so no product surfaces are lost')
        triangle_count += tri.NbTriangles()
        require(triangle_count <= MAX_TRIANGLES, 'CAD exceeds two million tessellated triangles; simplify the source product before importing')
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(output)), True)
    writer.SetMergeFaces(True)
    require(writer.Perform(doc, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()), 'CAD could not export its tessellated geometry')
    details = normalize_glb(output, source_up)
    return {'sourceFormat': 'step' if step else 'iges', 'cadVersion': OCP.__version__,
            'sourceUnits': source_units, 'sourceUp': source_up, 'outputUnits': 'm', 'outputUp': 'y',
            'sourceFaceCount': faces.Extent(), 'sourceSolidCount': solids.Extent(), 'sourceShellCount': shells.Extent(),
            'expandedCompoundCount': expanded, 'triangleCount': triangle_count, 'tessellationDeflectionM': deflection * .001,
            'tessellationAngleRadians': .15, 'normalization': 'centered Y-up metres; source assembly retained',
            'warnings': ['CAD surface colours are retained where available. CAD does not provide render-ready textures, UV artwork, mechanisms or animation.'], **details}


def main():
    parser = argparse.ArgumentParser()
    for name in ('input', 'output', 'report'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--source-up', choices=('y', 'z'), required=True)
    args = parser.parse_args()
    try:
        result = convert(Path(args.input), Path(args.output), args.source_up)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else 'CAD conversion failed; repair the file or export a self-contained GLB from the source application'
        Path(args.report).write_text(json.dumps({'error': message[:1600]}))
        raise
    Path(args.report).write_text(json.dumps(result))


if __name__ == '__main__':
    main()
