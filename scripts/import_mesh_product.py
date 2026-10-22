"""Import self-contained OBJ/STL geometry with declared units and axes in Blender."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import re
import sys

import bpy
from mathutils import Matrix, Vector

UNITS = {'mm': .001, 'cm': .01, 'm': 1., 'in': .0254, 'ft': .3048}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def convert(source, output, source_units, source_up):
    require(source_units in UNITS and source_up in {'y', 'z'}, 'Choose source units and up axis for this mesh')
    suffix = source.suffix.lower()
    if suffix == '.obj':
        # Single-upload endpoint intentionally cannot resolve companion MTL or
        # image paths. Reject instead of silently returning an untextured model.
        with source.open('rb') as handle:
            for line in handle:
                if re.match(rb'\s*(mtllib|call|csh)\s', line.removeprefix(b'\xef\xbb\xbf'), re.IGNORECASE):
                    raise ValueError('This OBJ references companion files. Export a packed GLB or .blend to preserve its MTL materials and textures')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    if suffix == '.obj':
        result = bpy.ops.wm.obj_import(filepath=str(source), forward_axis='Y', up_axis='Z',
                                       use_split_objects=True, use_split_groups=True, validate_meshes=True)
    elif suffix == '.stl':
        result = bpy.ops.wm.stl_import(filepath=str(source), forward_axis='Y', up_axis='Z',
                                       use_scene_unit=False, use_facet_normal=False)
    else:
        raise ValueError('Mesh import accepts .obj or .stl')
    require('FINISHED' in result, 'The mesh reader could not read this file')
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj.data.polygons]
    require(objects, 'The file contains no polygon surfaces')
    require(len(objects) <= 10000, 'The file contains too many objects; simplify its groups before import')
    total = sum(len(obj.data.vertices) for obj in objects)
    require(total <= 10000000, 'The file exceeds 10 million vertices; simplify it before import')
    unit_scale = UNITS[source_units]
    # Import without implicit axis rotation, then explicitly convert source Y-up
    # to Blender Z-up. glTF export converts Blender Z-up to final Y-up metres.
    rotation = Matrix.Rotation(math.pi / 2, 4, 'X') if source_up == 'y' else Matrix.Identity(4)
    minimum, maximum = Vector((math.inf,) * 3), Vector((-math.inf,) * 3)
    for obj in objects:
        obj.data.transform(rotation @ Matrix.Scale(unit_scale, 4) @ obj.matrix_world)
        obj.matrix_world = Matrix.Identity(4)
        used = {index for poly in obj.data.polygons for index in poly.vertices}
        for index in used:
            point = obj.data.vertices[index].co
            for axis in range(3):
                require(math.isfinite(point[axis]), 'The mesh contains nonfinite coordinates')
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    require(all(1e-8 < value <= 1000 for value in maximum - minimum),
            'Mesh dimensions must be nonzero and no larger than 1000 metres; check its source units')
    center = (minimum + maximum) * .5
    neutral = bpy.data.materials.new('Mesh surface')
    neutral.diffuse_color = (.65, .65, .65, 1)
    neutral.use_nodes = True
    neutral.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (.65, .65, .65, 1)
    neutral.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = .45
    for obj in objects:
        obj.data.transform(Matrix.Translation(-center))
        obj.data.materials.clear()
        obj.data.materials.append(neutral)
        obj.data.update()
    result = bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_active_scene=True,
        export_yup=True, export_animations=False, export_skins=False, export_morph=False,
        export_cameras=False, export_lights=False, export_extras=False, export_gpu_instances=False,
        export_draco_mesh_compression_enable=False, export_materials='EXPORT')
    require('FINISHED' in result and output.is_file(), 'The mesh could not be exported as a static product')
    names = [obj.name for obj in objects]
    return {'sourceFormat': suffix[1:], 'sourceUnits': source_units, 'sourceUp': source_up,
            'sourceScaleToMeters': unit_scale, 'outputUnits': 'm', 'outputUp': 'y',
            'blenderVersion': bpy.app.version_string, 'objectCount': len(objects), 'meshCount': len(objects),
            'sourceNames': names[:200], 'sourceNamesTruncated': len(names) > 200,
            'normalization': 'centered Y-up metres; OBJ object/group names retained',
            'warnings': ['Imported mesh geometry with a neutral surface. STL has no standard material or part hierarchy; OBJ companion materials require packed GLB/.blend.']}


def main():
    parser = argparse.ArgumentParser()
    for name in ('input', 'output', 'report', 'source-units', 'source-up'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    try:
        result = convert(Path(args.input), Path(args.output), args.source_units, args.source_up)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else 'Mesh conversion failed; repair the file or export a packed GLB from its source application'
        Path(args.report).write_text(json.dumps({'error': message[:1600]}))
        raise
    Path(args.report).write_text(json.dumps(result))


if __name__ == '__main__':
    main()
