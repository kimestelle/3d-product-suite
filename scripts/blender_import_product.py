"""Isolated Blender 4.3.2 worker for local polygon-mesh product imports."""
import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix

UNIT_SCALES = {"m": 1.0, "cm": .01, "mm": .001, "in": .0254, "ft": .3048}
MAX_VERTICES = 10_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--source-up", choices=("Y", "Z"), required=True)
    parser.add_argument("--units", choices=tuple(UNIT_SCALES), required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    require(bpy.app.version == (4, 3, 2), "Mesh conversion requires Blender 4.3.2")
    source, output, report = Path(args.input).resolve(), Path(args.output).resolve(), Path(args.report).resolve()
    require(source.parent == output.parent == report.parent, "Worker files must share their isolated directory")
    require(not output.exists() and not report.exists(), "Worker output already exists")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    # Preserve source coordinates first. Blender's Z-up -> glTF Y-up transform
    # is applied only at export, after the explicit source axis conversion.
    options = {"filepath": str(source), "forward_axis": "Y", "up_axis": "Z", "global_scale": 1.0}
    suffix = source.suffix.lower()
    if suffix == ".obj":
        bpy.ops.wm.obj_import(**options, use_split_objects=True, use_split_groups=False, validate_meshes=True)
    elif suffix == ".stl":
        bpy.ops.wm.stl_import(**options, use_scene_unit=False, use_mesh_validate=True)
    elif suffix == ".ply":
        bpy.ops.wm.ply_import(**options, use_scene_unit=False, merge_verts=False, import_colors="SRGB", import_attributes=True)
    else:
        raise ValueError("Unsupported mesh format")
    objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in objects if obj.type == "MESH"]
    require(meshes and all(obj.type in ("MESH", "EMPTY") for obj in objects), "Import must contain mesh geometry only")
    require(not bpy.data.actions and all(obj.animation_data is None for obj in objects), "Product imports must be static")
    require(all(obj.data.shape_keys is None and not obj.modifiers for obj in meshes), "Morphs and procedural modifiers must be baked")
    require(sum(len(obj.data.vertices) for obj in meshes) <= MAX_VERTICES, "Mesh exceeds the 10 million vertex limit")
    minimum, maximum = [math.inf] * 3, [-math.inf] * 3
    triangles, vertices = 0, 0
    for obj in meshes:
        mesh = obj.data
        require(len(mesh.polygons) > 0, "Point clouds and loose vertices are not product meshes")
        for vertex in mesh.vertices:
            require(all(math.isfinite(value) for value in vertex.co), "Mesh positions must be finite")
        used = {index for polygon in mesh.polygons for index in polygon.vertices}
        vertices += len(used)
        triangles += sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)
        require(triangles * 3 <= MAX_VERTICES, "Triangulated mesh exceeds the 10 million vertex limit")
        require(any(polygon.area > 0 for polygon in mesh.polygons), "Mesh contains no nondegenerate faces")
        for index in used:
            point = obj.matrix_world @ mesh.vertices[index].co
            require(all(math.isfinite(value) for value in point), "Mesh transforms must be finite")
            for axis, value in enumerate(point):
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
    scale = UNIT_SCALES[args.units]
    dimensions = [(high - low) * scale for low, high in zip(minimum, maximum)]
    require(all(1e-8 < value <= 1000 for value in dimensions), "Mesh must have nonzero three-dimensional bounds up to 1000 metres")
    center = [(low + high) / 2 for low, high in zip(minimum, maximum)]
    rotation = Matrix.Rotation(math.pi / 2, 4, "X") if args.source_up == "Y" else Matrix.Identity(4)
    for obj in meshes:
        # Bake centering and units into local positions before glTF writes
        # float32 node transforms. Keeping a large CAD origin in a translation
        # matrix would otherwise lose precision through cancellation at import.
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        obj.data.transform(obj.matrix_world)
        for vertex in obj.data.vertices:
            vertex.co = tuple((float(value) - center[axis]) * scale for axis, value in enumerate(vertex.co))
        obj.parent = None
        obj.matrix_world = rotation
        triangulate = obj.modifiers.new(name="Explicit triangle export", type="TRIANGULATE")
        triangulate.keep_custom_normals = True
    bpy.context.view_layer.update()
    # No external images are permitted in accepted formats. In particular, the
    # caller rejects OBJ MTL before import; the worker never loads a sidecar.
    require(not any(image.source == "FILE" for image in bpy.data.images), "External textures require embedded GLB import")
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True,
                              use_selection=False, export_apply=True, export_animations=False,
                              export_skins=False, export_morph=False, export_cameras=False,
                              export_lights=False, export_materials="EXPORT", export_vertex_color="ACTIVE",
                              export_all_vertex_colors=True, export_active_vertex_color_when_no_material=True,
                              export_draco_mesh_compression_enable=False)
    report.write_text(json.dumps({"centerSourceUnits": center, "boundsSourceUnits": [minimum, maximum],
                                 "scaleToMeters": scale, "sourceUp": args.source_up, "outputUp": "Y",
                                 "objectCount": len(meshes), "sourceVertexCount": vertices,
                                 "triangleCount": triangles}, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
