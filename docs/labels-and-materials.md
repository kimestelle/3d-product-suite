# Labels and materials

**Status in the gesso editor (D160).** Scenes may store `labelTexture` records
(below); they validate, preview in the browser, bundle with jobs and render in
Cycles. The gesso editor authors product artwork through **Product → Decals** and
does not show main's label panel yet, so the steps below describe
`LabelMaterialPanel`, which remains in the source unwired. The viewport's UV-guide
export (`labelTemplate`) is kept for it.

Open **Product → Labels & materials** and choose the product part to edit. These
controls work locally and do not generate another world or use API credits.

## Place label artwork

1. Choose **Face projection**, **Cylinder wrap**, or **Existing UVs**. Face
   projection works without UV preparation; choose the front, back, left, right,
   top or bottom. Cylinder wrap follows the vertical axis. Existing UVs use an
   imported mesh's first UV map; meshes without UVs can use projection instead.
2. Optionally download the **UV guide**. This SVG shows the actual selected
   geometry's UV wireframe. Use it as a guide in your design app, hide its guide
   layer and export only the artwork as a PNG or JPEG. The guide has a square
   1024 × 1024 UV artboard; front/wrap placement also offers automatic aspect fit.
3. Upload artwork. Transparent PNG preserves the underlying product around the
   print; JPEG covers its rectangular image area. Artwork is fitted to the mapped
   area with its proportions preserved.
4. Drag the 2D preview or edit width, height, position and rotation. Keep **Lock
   artwork proportions** checked to resize without stretching. **Center artwork**
   changes position; **Reset fit** restores the automatic fit. Check the 3D view
   for the final fit, seams and curved surfaces.
5. Choose **Matte paper**, **Glossy vinyl** or **Metallic foil**. Adjust tint,
   opacity, roughness and metallic response independently of the product surface.
6. Save the revision. Undo/redo, approved revisions and renders preserve the image,
   mapping and finish settings together.

One artwork image is supported per product component. Uploading artwork on the
fictional fixture's existing label replaces its procedural typography visually;
removing the artwork restores that typography. Imported meshes keep their source
artwork and materials underneath the new print. Labels follow their rigid part
during animation.

Use static PNG or JPEG files up to 8 MiB, 8192 pixels per side and 32 million
pixels total. Export without EXIF rotation so the editor and renderer share the
same orientation. The upload preserves the image bytes; assets are local,
content-addressed and checked before use. SVG, PDF and layered source files should
be exported as raster artwork first.

## Choose product materials

The separate **Product surface** controls affect the selected component. Choose
a plastic, ceramic, metal or glass preset, then adjust color, roughness, metallic,
transmission and index of refraction. Roughness controls gloss, metallic controls
metal response and transmission controls light passing through the surface.

An imported part starts with **Original mesh materials**. Selecting a finish
explicitly overrides that component's surfaces; **Restore original mesh
materials** restores the imported materials. Applying a label alone preserves the
source materials outside the printed area. Geometry and embedded source UV maps
remain unchanged.

The editor preview and Blender use the same projection and placement settings.
Request a Cycles still to review final reflections, foil and glass; viewport
lighting remains an approximation. Printed artwork is a surface coating, without
physical thickness, embossing, displacement or automatic UV unwrapping. A UV guide
is a placement aid, not a manufacturing dieline or color-managed print proof.

## Saved assets

Each component can store `labelTexture` with an immutable PNG/JPEG asset,
mapping settings and a printed-surface material. Project revisions, comparisons,
still renders and reel jobs verify and bundle those images alongside geometry.
Saved Blender files pack the image so reopening does not depend on its original
upload location. Keep the local workspace when moving or backing up a project.
