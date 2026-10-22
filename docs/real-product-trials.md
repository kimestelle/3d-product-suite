# Real product trials

The editor accepts prepared static product GLBs, Blender snapshots, STEP/IGES CAD and direct STL/OBJ/PLY meshes alongside the original synthetic fixtures. Prepared GLBs retain their imported geometry, hierarchy and materials. Other formats are normalized locally to self-contained GLBs. `sizeM` records measured bounds; it never stretches the model. An explicit `materialOverride: true` replaces imported materials with the scene component material.

The editor and `product-import` CLI also accept `.blend` files through a local Blender conversion to that same static GLB contract. This imports the active scene at its saved frame, with packed textures and supported materials; it does not preserve Blender's editable modifiers or animation system. See the [import workflow and limits](../README.md#editor-and-world-workflow). The trial evidence below still describes its original inputs.

Prepared GLBs use right-handed Y-up meters and a bounding-box center at the local origin. The importer measures decoded vertex positions, checks the active node hierarchy and refuses external dependencies, animation, skins, morph targets, compressed geometry and inconsistent dimensions. STEP/STP and IGES/IGS now convert locally in the import flow; STL/OBJ/PLY also convert with explicit units. Native CAD formats still require a STEP or GLB export. See [current compatibility and checks](import-compatibility.md). The importer does not infer mechanical movement.

## Prepare a product

```sh
python -m film product-import /path/to/normalized.glb \
  --output /path/to/prepared-product \
  --name 'Product trial' \
  --owner 'Manufacturer or asset owner' \
  --source 'https://manufacturer.example/product' \
  --reuse-basis 'Permission or license covering this use' \
  --workspace workspace-data
```

This writes `scene.json` and a content-addressed asset, fits three rigid camera shots and optionally creates a project in the local editor. The Product panel also accepts these inputs. Uploaded meshes are kept in the local workspace; no provider upload or paid generation occurs. Jobs bundle and verify product assets with their source scene so a later file replacement cannot change a queued render.

## Mesh inputs

In **Product → Import product**, choose a file, its source units (millimeters, centimeters, meters, inches or feet) and its Z/Y up axis. Units are required for STL/OBJ/PLY rather than guessed from the model's size. STL and OBJ convert with the editor's mesh worker (see [import compatibility](import-compatibility.md)); polygon PLY uses the bounded normalizer in `film/mesh_import.py`, which requires the pinned Blender 4.3.2 even when a newer import Blender is configured. That normalizer centers the actual mesh bounds, preserves independent mesh objects and PLY vertex colors, and exports a validated, static Y-up GLB in meters. The product metadata records the source hash, format and normalization transform under `meshImport`.

```sh
python -m film product-import /path/to/product.ply \
  --source-units mm --source-up z \
  --output /path/to/prepared-mesh \
  --name 'Supplier product' --owner 'Product owner' \
  --source 'Supplier export revision 3' \
  --reuse-basis 'Owner supplied model' \
  --workspace workspace-data
```

Use `--blender /absolute/path/to/blender` if it is outside `PATH`. Inputs and converted GLBs have a 128 MiB limit, conversion is bounded, and models must have polygon faces and nonzero three-dimensional bounds. Gaussian PLY splats use the separate World import flow; ordinary point clouds need reconstruction before product import. PLY has no standard PBR material or texture representation. FBX, multi-file glTF and native CAD archives are not accepted in this mesh intake.

Imported products are rigid assemblies with three camera shots. Separate mechanisms, part selection for articulation and automatic material reconstruction remain outside this intake.

Verify PLY normalization with `RUN_BLENDER_TESTS=1 python -m unittest tests.test_mesh_import -v`. `web/tests/product-import-smoke.mjs` was written for main's earlier editor and its import form; it needs updating before it can drive the gesso editor.

## Selected products and verified status

| Product | Official sources | Trial status |
| --- | --- | --- |
| Artemide Nessino | [Product and technical downloads](https://www.artemide.net/en/product-specs/?product=nessino-table-orange), [STEP](https://artemide.net/Data/Tech/STP/Lamp_Design_Table_Nessino_00390X5A_3D_STP.stp) | Actual STEP downloaded and tessellated, including all 86 faces: eight solids and 30 surface shells. Normalized dimensions 0.320 × 0.223003 × 0.320 m. Orange PBR is an unmeasured approximation, not a manufacturer material asset. Local Blender still verified. |
| Bang & Olufsen Beosound A5 | [Official support and 3D download](https://support.bang-olufsen.com/hc/en-us/articles/14985091842833-Beosound-A5) | Official model ZIP is linked, but the workspace proxy returns HTTP 403 for its Azure host. A current official technical sheet was downloaded. Geometry, archive formats and part structure remain unverified until the actual model is obtained. |
| Audo Bottle Grinder, Ceramic | [Official product and resources](https://audocph.com/products/bottle-grinder-ceramics-2-piece) | Public photos, press sheet and care documents obtained. The product's generic 2D/3D button leads to the general catalogue: no Bottle Grinder geometry was found in the complete 387-file public 3D catalogue. Manufacturer CAD or a separately licensed model is still required. |

The Audo ceramic press sheet lists H207 × Ø75 mm, while the current product page lists H205 × Ø80 mm. Resolve the source revision before calibrating a reconstruction or judging dimensional accuracy.

These are commercial product designs. Public availability is not an open-source license or an unrestricted advertising license. Artemide's [terms](https://www.artemide.com/en/terms-and-conditions) limit ordinary website use to personal information, research and study and require written agreement for commercial use. Brand assets and derived product geometry stay outside this repository. The private trial does not imply brand approval, commercial clearance or a completed comparison for unavailable models.
