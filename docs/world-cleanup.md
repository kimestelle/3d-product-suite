# World structure cleanup

In the connected editor, open **Stage → Environment → Structure cleanup**. Choose the current GLB or a generated Gaussian world's official HQ mesh sibling, then press **Inspect mesh candidates**. Inspecting a sibling temporarily shows that mesh using its own saved alignment. It does not replace the Gaussian until Apply.

The first pass proposes connected, nearly planar triangle regions. It does not recognize objects. Inspect the highlighted source faces, optionally frame the region, then confirm Floor, Wall, Pool rim or Other surface. A geometric proposal can include an unwanted patch; a label requires visual review.

**Preview separate mesh** writes an immutable GLB copy. The selected group becomes a named mesh; unassigned surroundings remain. Separation references the original vertex attributes and retains the source texture atlas, material and triangle count. It does not remove floaters or fill holes.

After reviewing separation, optional **Flatten interior** requires an explicit planarity confirmation and maximum movement in source units. Boundary and externally shared positions stay fixed. The repair is checked for displacement and triangle distortion. Unsupported or unsafe repairs report a reason instead of replacing the world. A fixed boundary can leave a nonplanar transition band. Source units are not calibrated millimetres, and flattening geometry does not straighten lines or lighting baked into a texture.

Compare **Source mesh** and the prepared copy at the same inspection camera. **Return to current world** discards the view. **Apply** makes one undoable environment edit; campaign Save remains separate. Loading, cancellation, campaign changes and late responses cannot commit a preview. Save, presets, export and still captures require applying or returning first. Existing saved worlds and source files remain available.

The selected-face overlay uses actual source triangle IDs and the existing renderer. It has no picking or capture ownership. Large face lists load only for the selected region, and idle review adds no render loop. Analysis results bind the source hash, source axis and algorithm settings. Derived assets use the normal scene and immutable-asset validators.

This implementation runs in the Python backend. The Vercel static demo identifies that requirement and does not simulate analysis. The current pass does not provide semantic AI labels, multiview segmentation, independent object recognition, hidden-surface reconstruction, remeshing, texture rebaking or repaired Gaussian splats. Architectural cleanup remains a reviewable mesh operation.
