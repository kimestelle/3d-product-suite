# Real product trials

The editor accepts prepared static product GLBs and direct OBJ/STL/PLY meshes alongside the original synthetic fixtures. Prepared GLBs retain their imported geometry, hierarchy and materials. Other mesh formats are normalized locally to self-contained GLBs. `sizeM` records measured bounds; it never stretches the model. An explicit `materialOverride: true` replaces imported materials with the scene component material.

Prepared GLBs use right-handed Y-up meters and a bounding-box center at the local origin. The importer measures decoded vertex positions, checks the active node hierarchy and refuses external dependencies, animation, skins, morph targets, compressed geometry and inconsistent dimensions. Native CAD formats such as STEP/IGES still require export to a supported mesh format. The importer does not infer mechanical movement.

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

In **Product → Import a product mesh**, choose a file, its source units (meters, centimeters, millimeters, inches or feet) and its Y/Z up axis. Units and orientation are required for OBJ/STL/PLY rather than guessed from the model's size. Blender 4.3.2 must be installed locally for conversion; prepared GLB import works without Blender. The importer centers the actual mesh bounds, preserves independent mesh objects and supported vertex colors, and exports a validated, static Y-up GLB in meters. The product metadata records the source hash, format and normalization transform.

```sh
python -m film product-import /path/to/product.stl \
  --units mm --source-up Z \
  --output /path/to/prepared-mesh \
  --name 'Supplier product' --owner 'Product owner' \
  --source 'Supplier export revision 3' \
  --reuse-basis 'Owner supplied model' \
  --workspace workspace-data
```

Use `--blender /absolute/path/to/blender` if it is outside `PATH`. Inputs and converted GLBs have a 128 MiB limit, conversion is bounded, and models must have polygon faces and nonzero three-dimensional bounds. Gaussian PLY splats use the separate World import flow; ordinary point clouds need reconstruction before product import. STL and plain OBJ inputs have no authored material appearance; OBJ/PLY vertex colors are retained where present. OBJ files referencing MTL, texture or other sidecar files are rejected with instructions to export an embedded GLB. FBX, multi-file glTF and native CAD archives are not accepted in this mesh intake.

Imported products are rigid assemblies with three camera shots. Separate mechanisms, part selection for articulation and automatic material reconstruction remain outside this intake.

Verify mesh normalization with `RUN_BLENDER_TESTS=1 python -m unittest tests.test_mesh_import -v`. With a fresh local server on port 8791, `node web/tests/product-import-smoke.mjs` checks a real OBJ upload, explicit millimeter/Z-up conversion, measured dimensions, immutable GLB delivery, browser preview, reopen and a successful Cycles still. Set `PRODUCT_SUITE_URL` to use a different local server; use a disposable workspace for this check.

## Selected products and verified status

| Product | Official sources | Trial status |
| --- | --- | --- |
| Artemide Nessino | [Product and technical downloads](https://www.artemide.net/en/product-specs/?product=nessino-table-orange), [STEP](https://artemide.net/Data/Tech/STP/Lamp_Design_Table_Nessino_00390X5A_3D_STP.stp) | Actual STEP downloaded and tessellated, including all 86 faces: eight solids and 30 surface shells. Normalized dimensions 0.320 × 0.223003 × 0.320 m. Orange PBR is an unmeasured approximation, not a manufacturer material asset. Local Blender still verified. |
| Bang & Olufsen Beosound A5 | [Official support and 3D download](https://support.bang-olufsen.com/hc/en-us/articles/14985091842833-Beosound-A5) | Official model ZIP is linked, but the workspace proxy returns HTTP 403 for its Azure host. A current official technical sheet was downloaded. Geometry, archive formats and part structure remain unverified until the actual model is obtained. |
| Audo Bottle Grinder, Ceramic | [Official product and resources](https://audocph.com/products/bottle-grinder-ceramics-2-piece) | Public photos, press sheet and care documents obtained. The product's generic 2D/3D button leads to the general catalogue: no Bottle Grinder geometry was found in the complete 387-file public 3D catalogue. Manufacturer CAD or a separately licensed model is still required. |

The Audo ceramic press sheet lists H207 × Ø75 mm, while the current product page lists H205 × Ø80 mm. Resolve the source revision before calibrating a reconstruction or judging dimensional accuracy.

These are commercial product designs. Public availability is not an open-source license or an unrestricted advertising license. Artemide's [terms](https://www.artemide.com/en/terms-and-conditions) limit ordinary website use to personal information, research and study and require written agreement for commercial use. Brand assets and derived product geometry stay outside this repository. The private trial does not imply brand approval, commercial clearance or a completed comparison for unavailable models.
