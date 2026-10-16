# Original synthetic room fixtures

`neutral-room.glb` and `neutral-room.ply` are **original synthetic QA fixtures**,
not World Labs exports, photogrammetry, or examples of generated-world quality.
They contain the same simple limestone/plaster room, ivory inset and muted bronze
architectural fins. No external textures, scripts or other assets are required.

Regenerate both assets and their exact hash/size manifest with standard Python:

```sh
python scripts/create_world_fixtures.py
```

The generator has no dependencies, timestamps, random sampling or provider calls.
`manifest.json` records source geometry, material factors, bounds, landmarks,
provenance, immutable file hashes and one common geometry digest. Regenerating
the fixtures in the same Python implementation produces identical bytes.

Both assets are canonical **Y-up in meters**, with identity alignment. The camera
starts on positive Z and looks toward the product origin; the back wall's visible
face is Z = -0.50 m. The distant floor top is Y = -0.025 m and begins at
Z = -0.13 m, behind the example scene's separate contact plinth. There is no bottle,
product proxy, contact plinth or collision mesh in either file. Keep the exact
near-field plinth from the scene when selecting either world.

The GLB is a self-contained glTF 2 visual mesh, with normals and opaque rough PBR
materials. The PLY is binary little endian, with standard 3DGS properties:
`x y z nx ny nz f_dc_0 f_dc_1 f_dc_2 opacity scale_0 scale_1 scale_2 rot_0 rot_1
rot_2 rot_3`. Its 0.03 m surface sample grid uses degree-0 spherical harmonics,
logit opacity, natural-log scales, and **wxyz** quaternion order. Explicitly choose
`sourceUp=Y` when importing the PLY. Its surface-aligned Gaussian centers derive
from the exact same box faces as the mesh. Colors are constant display RGB
derived from the mesh's linear base-color factors.

Use the pair to compare loading, axis/scale alignment, camera framing, immutable
asset bundling and Gaussian plate composition. The PLY is a coarse surface
approximation, not a trained radiance field: rounded/smeared edges, color and
lighting differences are expected. It has no learned illumination, shadows,
view dependence, reflection, glass transmission or near-field contact evidence.
The plate renderer also cannot supply those properties to Cycles. Neither fixture
establishes a real provider export's quality; both remain `unreviewed` until an
explicit reviewer changes that state in the world library.

The fixtures are original project work with no third-party source assets. See
`manifest.json` for the complete provenance record and precise dimensions.
