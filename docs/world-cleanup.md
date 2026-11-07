# World structure cleanup

In the connected editor, open **Stage → Environment → Structure cleanup**. Choose the current GLB or a generated Gaussian world's official HQ mesh sibling, then press **Inspect mesh candidates**. Inspecting a sibling temporarily shows that mesh using its own saved alignment. It does not replace the Gaussian until Apply.

The first pass proposes connected, nearly planar triangle regions. It does not recognize objects. Inspect the highlighted source faces, optionally frame the region, then confirm Floor, Wall, Pool rim or Other surface. A geometric proposal can include an unwanted patch; a label requires visual review.

**Preview separate mesh** writes an immutable GLB copy. The selected group becomes a named mesh; unassigned surroundings remain. Separation references the original vertex attributes and retains the source texture atlas, material and triangle count. It does not remove floaters or fill holes.

After reviewing separation, optional **Flatten interior** requires an explicit planarity confirmation and maximum movement in source units. Boundary and externally shared positions stay fixed. The repair is checked for displacement and triangle distortion. Unsupported or unsafe repairs report a reason instead of replacing the world. A fixed boundary can leave a nonplanar transition band. Source units are not calibrated millimetres, and flattening geometry does not straighten lines or lighting baked into a texture.

Compare **Source mesh** and the prepared copy at the same inspection camera. **Return to current world** discards the view. **Apply** makes one undoable environment edit; campaign Save remains separate. Loading, cancellation, campaign changes and late responses cannot commit a preview. Save, presets, export and still captures require applying or returning first. Existing saved worlds and source files remain available.

The selected-face overlay uses actual source triangle IDs and the existing renderer. It has no picking or capture ownership. Large face lists load only for the selected region, and idle review adds no render loop. Analysis results bind the source hash, source axis and algorithm settings. Derived assets use the normal scene and immutable-asset validators.

This implementation runs in the Python backend. The Vercel static demo identifies that requirement and does not simulate analysis. The current pass does not provide semantic AI labels, multiview segmentation, independent object recognition, hidden-surface reconstruction, remeshing, texture rebaking or repaired Gaussian splats. Architectural cleanup remains a reviewable mesh operation.

## Conservative Gaussian interior proposals

`scripts/gaussian_interior_cleanup.mjs --samples /path/to/sweep.json --output /path/to/empty-assessment --voxel-size-m .1` assesses a declared inside-camera sweep. It retains the two outer voxel layers, sparse or translucent cells, large splats, and every ambiguous record. Only small opaque records enclosed behind retained dense shell cells are candidates.

The sample document and its content-addressed asset share a directory tree. An assessment cannot install a reduced world. Adding `--verify --url http://127.0.0.1:8787 --width 1280 --height 720 --device auto` compares source and candidate pixels using the existing renderer. Verification covers the declared cameras, optics and resolution. Ordinary exports reject this proposal policy, and the interactive editor retains the source.

On November 6, a 54-pose survey sampled the interior quarter-points and center, looking in all six axis directions within each room's bounds. It proposed zero removals from both refined two-million-splat rooms. The conservative tests could not establish safely removable interiors. Atlas imports record source retention when no reviewed sweep is available.

## Splat-to-mesh conversion

Atlas provides a native `splats2Mesh` task with interior anchor cameras, optional extraction bounds and textured GLB output. Geometry must be visible to its render cameras to be reconstructed. Keep the original SPZ and compare the separate mesh from the actual shooting cameras before applying it. Conversion does not establish straight walls or physical material separation. [Atlas task reference](https://docs.atlas-beta.worldlabs.ai/api-reference/splats2-mesh)

The local `film.splat_mesh.convert_splat` density conversion remains experimental. A November 6 Water-light Pavilion trial at resolution 128 with 200,000 retained splats produced a valid 275,102-triangle GLB. The matched overview failed visually: an opaque reconstructed sheet sat approximately 5.4 cm in front of the camera. Its vertex colors also omit view-dependent appearance. The trial was kept separately and did not replace the source or world catalog.

A single native conversion request then used the refined provider asset, interior auto anchors, an 8192 px atlas and no decimation. Atlas rejected it with HTTP 402 before returning an operation ID. No retry was made. Its durable request receipt and the local GLB comparison are retained under `workspace-data/world-mesh-tests/water-light-pavilion-2026-11-06/`. The account balance and project spend limit must be checked before retrying the saved request. [Atlas billing](https://docs.atlas-beta.worldlabs.ai/billing)
