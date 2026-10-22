# Product import compatibility

Checked on 2026-10-21 after integrating `worlds-light-sound` through `aaa8852` with the local bottle workflow and curve studies.

Every accepted input becomes one validated, self-contained GLB. The editor and Blender export use that same hashed asset, source-part catalog, artwork and sampled transforms. Conversion never overwrites the original file. A failed import leaves existing campaigns and assets unchanged.

## Formats

| Input | Preserved | Required choice / limit |
| --- | --- | --- |
| GLB | Static geometry, source hierarchy, supported PBR materials and embedded artwork; original bytes | Centered, Y-up metres, one active scene. No external files, animation, skinning, morph targets or compressed geometry. |
| Blender `.blend` | Active scene at the saved frame, evaluated static geometry, source parenting, names, supported materials and packed images | Blender 4.3–5.1 importer; 4.3.2 and 5.1.1 tested. File units by default; explicit units override available. Unsupported materials become neutral surfaces with an import warning. Realize instances first. Native animation, modifiers and constraints are not carried into the editor. |
| STEP / STP | Document units, available assembly names, repeated parts, solid and surface geometry, display colours | Choose source Y-up or Z-up. Local OpenCascade worker required. Self-contained file; no companion-document assemblies. CAD is tessellated, with tolerance recorded. No feature history, joints, constraints or render-ready textures. |
| IGES / IGS | Declared standard units, available names/colours, authored surface groups | Choose source up axis. OpenCascade required. Surface groups remain groups; they do not become invented mechanical parts. |
| OBJ | Polygon geometry, object/group names | Explicit units and up axis; Blender worker. Geometry-only OBJ accepted. References to MTL/textures require a packed GLB or `.blend` instead. |
| STL | Triangle geometry | Explicit units and up axis; Blender worker. ASCII and binary supported. Standard STL does not supply reliable units, materials or a part tree. |
| Proprietary CAD / other formats | — | Export a self-contained STEP or GLB. Native SolidWorks, Fusion, Rhino, DWG/DXF, FBX and USD are not accepted by this importer. |

Units choices are millimetres, centimetres, metres, inches and feet. STEP/IGES use their declared units. STL/OBJ require a choice before Import becomes available. Blender's “Use file units” remains the default; when its unit system is unset, one unit means one metre. An explicit override replaces that scale and is recorded in metadata. The importer does not infer physical size from the product's name.

All products must span three nonzero dimensions; standalone 2D drawings, wires and flat zero-thickness planes are outside the current product contract. Source uploads and converted GLBs are limited to 128 MiB. Conversion has a 180-second timeout. The common validator caps active vertices at ten million; CAD additionally caps 100,000 faces and two million generated triangles. More than one million vertices produces a performance notice. Validation success does not guarantee responsive editing of dense geometry.

## Blender materials and scene content

Direct Glass BSDF converts to transmission. Compatible Mix Shader branches become static parameter maps. Supported procedural colour, math, roughness, masks and normals bake locally without scene lighting. Unused material slots do not block the visible product. Linked constant IOR is frozen at the saved frame.

Bakes are bounded to 1024px maps, 48 images and 32 megapixels. Source UV artwork is retained. Glass/liquid appearance can differ between WebGL and Cycles even though geometry and material assets match.

Unsupported node groups or shader branches, spatially varying IOR, material volume/displacement inputs, UDIM/video textures, missing or unpacked material resources, and material conversion/bake failures replace only the affected materials with opaque neutral surfaces. Geometry, parts, UVs and supported neighbouring materials remain. The report names each replacement, its cause, affected objects and optional repair steps; the editor keeps this history under **Import notes** in Product and Material. To retain the original finish, follow those steps in Blender and reimport. Otherwise, assign a new material in the library. Preview and export use the same fallback stored in the imported GLB; the source `.blend` is unchanged.

External geometry/simulation caches, unsupported object types and unrealized collection/Geometry Nodes instances can still require preparation in Blender. File, geometry, resource-budget and process failures still stop an incomplete import. A source saved in a newer Blender cannot silently import through an older runtime. Material fallback does not promise recovery from a crashed or timed-out Blender process.

Cameras, lights and confidently identified ground/light cards are omitted. Other geometry stays unless an object/collection has `gesso_role = environment`; `gesso_role = product` explicitly keeps it. This avoids deleting a product base or emissive product part merely because it resembles staging.

## Dependencies

Use the repository's Python 3.12 environment:

```sh
.venv/bin/python -m pip install -e '.[cad]'
.venv/bin/python -m film serve --data-dir workspace-data \
  --blender /path/to/Blender-4.3.2 \
  --import-blender /path/to/Blender-5.1.1 \
  --ffmpeg /path/to/ffmpeg-7.1.5
```

`--import-blender` / `GESSO_IMPORT_BLENDER` is optional; absent an override, imports use the rendering executable. Export remains pinned to Blender 4.3.2 and FFmpeg 7.1.5. Set `GESSO_CAD_PYTHON` to a separate Python environment containing `cadquery-ocp==7.8.1.1` if the server environment should remain small. No upload or paid provider is involved in conversion.

`scripts/dev-serve.sh` accepts `GESSO_PYTHON`, `BLENDER` and `FFMPEG` overrides, validates Python 3.12 and discovers installed tools. It preserves supplied credentials and certificates. That shortcut selects Metal/denoising by default; the ordinary CLI's reference render remains CPU without denoising.

## Evidence

- **Esteban Paris Ambre bottle:** the actual user-supplied Blender 2.79 file converts with both 4.3.2 and 5.1.1. Ten mesh parts and 17 material maps remain; Ground, Camera and FillLight are excluded. Source hash unchanged. Explicit centimetres yields 61.14 × 111.80 × 36.86 mm; this is a chosen scale, not a manufacturer measurement. A 5.1.1 import was exported through 4.3.2 with a 20mm animated cap lift and a PNG diagnostic still.
- **Artemide Nessino STEP:** 320 × 223.00276 × 320 mm; all 86 faces retained, eight solids plus 30 free surface shells, 38 selectable meshes, 30,059 vertices and 52,700 triangles. The assembly remains above the parts. Generated technical names become Part/Group labels while original references stay in metadata; no semantic part names are invented.
- **CAD/mesh fixtures:** STEP millimetres/metres, IGES millimetres/inches, both source axes and signed instance placement, repeated/named/coloured parts, open surface sheets, OBJ negative indices, ASCII/binary STL, missing MTL, malformed input, timeout, source changes and atomic failure recovery. Thirteen tests passed with actual OpenCascade/Blender processes.
- **Blender fixtures:** 32 cases exercised successfully on each tested runtime, covering saved-frame geometry/materials, hierarchy, modifiers, packed artwork, scale, shader conversions, IOR, unused slots and failures. A 5.1-created source is rejected by 4.3.2.
- **Teammate gallery:** exact product GLB hashes and hierarchies validate for Omega, Ambre, Sasha, Leica and Theo. Sasha is 71.3 MB / 2.19 million vertices; use a simplified source when browser memory or interaction speed matters.
- **Existing editor/export:** native Blender round trips check part transforms, packed artwork, geometry and all sampled fixture poses. This establishes asset/transform consistency, not pixel-identical WebGL/Cycles shading or universal file support.

Run the ordinary Python and web suites from the README. For the optional native CAD suite:

```sh
GESSO_TEST_CAD_PYTHON=/path/to/python-with-cad \
GESSO_TEST_BLENDER=/path/to/blender \
.venv/bin/python -m unittest tests.test_cad_import -v
```

Public asset availability and a successful import do not change source ownership or reuse terms. Test models and generated outputs remain outside Git.
