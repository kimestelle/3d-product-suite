# Design decisions

Recorded retrospectively on **2026-10-19** from Estelle's decisions in the working conversation and the implementation in this checkout. Earlier entries are ordered by the design's development, not assigned invented dates. This is a decision record, not a claim that every prototype interaction has passed a usability study or that Figma and code are currently identical.

## How to use this log

The latest explicit correction takes precedence. Preserve the reason for a change and mark the earlier direction as superseded rather than silently rewriting history. Source geometry, scene data and actual rendering capabilities take precedence over marketing claims.

- **In code**: the named implementation contains the behavior; this does not by itself certify every runtime state.
- **Direction**: accepted product or design intent, with implementation coverage that may be partial.
- **Open**: requested or discussed, but not established as completed by the inspected source.
- **Superseded**: retained to explain a later decision, not a rule to implement again.

For future changes, append a dated entry with a stable ID, **decision, reason, scope, status, source/verification**, and the ID it replaces when relevant. Update this file in the same change as the implementation. Record failed experiments when they explain a constraint; omit abandoned incidental pixel nudges once a shared rule replaces them. Never log secrets, private product files or unsupported attribution.

## Product premise and visual direction

### D01 — Serve the process

**Direction.** Gesso is a product for making images, not a showcase that asks the user to learn its visual language. Build around recurring decisions about an existing physical product: parts, finish, artwork, setting, camera and motion. The useful unit is an editable composition that survives the next revision.

### D02 — A finished result is reachable from any step

**Direction, with limits.** Rule #1 is that a user can jump from any stage to a polished still or film, while retaining editable decisions. Start from a complete composition rather than an empty canvas. This is a product promise to work toward, not evidence that the current renderer can automatically complete any imported asset. Validation, asset preparation and render prerequisites remain real gates. See [product description](../web/src/productDescription.ts), [validation plan](validation-plan.md) and [real-product trials](real-product-trials.md).

### D03 — People who know their physical product

**In code / direction.** The core audience is physical product designers and builders who lack the time or budget for a large studio production, or need recurring content. They know the product better than they know a general-purpose 3D editor. Offer fewer decisions up front than a full DCC tool, but more explicit control and repeatability than prompt-only image/video generation. The About page states this positioning through [shared copy](../web/src/productDescription.ts).

### D04 — Lightbox, not a sterile white application

**Direction / in code.** Treat the product as the lit specimen and the surrounding interface as its frame. Early white-primary / Chalk-alternative branding was narrowed: Product inspection uses a white lit scene; the editor chrome is dark so colors, materials and final-video quality carry the image. Chalk remains an alternative surface token. A single permanent accent color must not dictate every scene. See [interface tokens](../web/src/interface-system.css) and [viewport](../web/src/viewport.ts).

### D05 — Halyard, editable text

**In code / direction.** Use Halyard throughout, with Text for interface/body and Display for display typography. Keep Figma typography editable rather than converting it to outlines to work around remote font access. The temporary Instrument Sans direction was superseded by restoring Halyard. The repo resolves locally installed Halyard; it does not redistribute Adobe font files, so a fallback is expected on machines without it. See [type tokens](../web/src/interface-system.css) and [asset provenance](../web/src/assets/gesso/ASSETS.md).

### D06 — A short dictionary entry and a concrete manifesto

**Direction / partially in code.** Replace “Brand Manifesto” with a dictionary treatment of *gesso*. Use **“A ground applied to a surface before painting.”** as the philosophy cover title, followed by a short bridge to the product. About carries product description and audience; the philosophy page carries design intent. Copy should also work as a marketing pitch without repeating About. Estelle's [notes](https://softcopy.digital/notes/) informed the requested brevity; no authorship or quotations are transferred from unrelated work.

**Open:** the user rejected “Keep what’s been decided” and its surrounding abstract copy as ambiguous. That passage remains in [ShapeLightPage.tsx](../web/src/ShapeLightPage.tsx) at this recording. A requested Figma copy revision must not be treated as already deployed.

### D07 — References inform a mechanism, not vague endorsements

**Direction.** The conversation used James Turrell's light and spatial openings as visual reference, KeyShot and Blender as editor comparisons, Premiere as a timeline reference, and Michel Beaudouin-Lafon, Mitchel Resnick and Brian Silverman as computation/design references. The user rejected vague quotations in favor of concrete opinions relevant to this product. No unverified quotation is reproduced here, and no claim is made that those people endorse Gesso. Two visual references were requested in Figma; their exact identity is not recoverable from the supplied text, so this log does not invent them.

## Composition, navigation and controls

### D08 — One grid across pages and rails

**In code / direction.** Public pages share the landing's seven-column Swiss grid, outer margins and navigation slots. Editor panels share the layout's side margins; headings, labels, controls and sidebar proportions follow the same system. Keep words and shapes inside the padding, including narrow viewports. Align navbar “enter studio” to the right margin; align secondary actions to the same grid slots. See [site grid](../web/src/site-grid.css), [interface system](../web/src/interface-system.css) and [frame-clearance checks](../web/src/frameClearance.test.ts).

### D09 — Spacing is a shared rule

**In code.** Use multiples of 4px, with 2px half-steps where needed. Preserve the explicit button exception: **3px top / 5px bottom optical padding**, not a blanket 4px replacement. Type metrics, hairlines, shape geometry and live coordinates retain their own units. Earlier local top-bar and padding adjustments feed the current tokens rather than separate competing rules. See [interface-system.css](../web/src/interface-system.css).

### D10 — Selection through color, not an extra outline

**In code / direction.** Selected top labels use color; no underline. Highlighted controls do not acquire decorative outlines. Keep keyboard focus visible as a separate accessibility state. Use translucent selected/hover states in public navigation, including the About link on About itself. Top-bar text remains light in weight. See [interface system](../web/src/interface-system.css) and [site grid](../web/src/site-grid.css).

### D11 — One icon language and explicit status

**In code.** Use Lucide Option, Undo, Redo and History glyphs with consistent sizing, baseline and breathing room; the smaller Option glyph is a trailing superscript annotation. Export reuses the public-site arrow. Select chevrons belong inside their control's alignment, not outside its spacing. Saved is green, Saving is yellow; text/icon state remains visible so color is not the only signal. See [UiIcon](../web/src/UiIcon.tsx), [save status](../web/src/saveStatus.ts) and [asset credits](../web/src/assets/gesso/ASSETS.md).

### D12 — Visible, consistent shortcuts

**In code.** Category shortcuts use Option/Alt + number, shown after the label as superscripts; do not alternate modifier conventions across the same navigation. The current four categories use 1–4. G / R / S starts position, rotation and scale in the viewport, with axis constraints and cancel/confirm behavior, rather than merely focusing a numeric field. Preserve text-input editing and familiar undo/redo shortcuts. See [navigation](../web/src/navigation.ts), [EditorNavigation](../web/src/EditorNavigation.tsx) and [TransformShortcuts](../web/src/TransformShortcuts.tsx).

### D13 — Four primary workspaces

**In code.** The final top level is **Product / Material / World / Film**. Camera belongs in Film, with Still / Video mode. Product is for structure and mechanisms; Material gets finishes and decals. Static placement and object animation live in Film. Earlier Product placement/animation tabs, a separate Camera category and the two-row top-bar experiment were superseded. Old deep links resolve to the replacement locations. See [navigation.ts](../web/src/navigation.ts).

### D14 — Controls follow the active layer

**Direction / in code.** Keep layer choices present so the user sees a process without onboarding. Clicking the image operates the current layer's controls; it must not unexpectedly switch layers. Prefer one visible specimen and contextual rails over many unrelated floating windows. Remove redundant workspace headings such as “Product” when navigation already establishes the context.

### D15 — Reveal hierarchy without hiding the main task

**Direction / in code.** Important choices should be recognizable without hunting through scrolling panels. Group controls by cause, keep action buttons available, and disclose detailed editing where needed. This evolved into pinned samples and independently scrolling properties, rather than forcing arbitrarily long content to fit without scrolling. The central product remains visible when the right inspector opens.

## Product, materials and world

### D16 — The tree describes the product; the viewport previews it

**In code / direction.** Show a scene/parts tree in Product instead of another redundant object thumbnail. Selection isolates the relevant parts while other meshes become translucent. Support renaming parts, parent editing and recoverable source hierarchy. Use the explicit labels **Part details / Parent / Object** and define Object where it first appears; do not overload “Structure” for several meanings. Remove “Show assembly / Frame” from the Product workspace and the confusing “This source node moves with product / Select product” explanation. See [ProductPanel](../web/src/ProductPanel.tsx), [PartNameField](../web/src/PartNameField.tsx) and [hierarchy](../web/src/hierarchy.ts).

### D17 — Mechanisms are product facts; their timing is film work

**Direction / partially in code.** Parts, hinges, joints, pivots and axes belong to product definition. Applying movement over time belongs in Film. Imported metadata should inform hierarchy before inferred grouping does, and the source hierarchy must remain recoverable. LLM inference was discussed as an aid, not as verified engineering evidence. Current fixture grouping is bounded; direct CAD import and automatic mechanism inference remain open. See [hierarchy.ts](../web/src/hierarchy.ts), [implementation contract](implementation-contract.md) and [real-product trials](real-product-trials.md).

### D18 — A material library, not a pair of tabs

**In code.** Replace Materials / Properties tabs with saved material presets. Clicking a preset opens its editor directly, without a separate “Edit preset” button. The library sits on the left, the editor on the right, with the product in the center. Add new starts with material type and editable properties; opening Material exposes the new-preset chooser. Saved presets are campaign-scoped. See [MaterialLibrary](../web/src/MaterialLibrary.tsx) and [material presets](../web/src/materialPresets.ts).

### D19 — Put assigned objects under their material

**In code.** The material library is one column. Attach objects or sections under a material, and move assignments between materials by drag interaction. The grouping answers “what uses this finish?” without switching to a separate mapping view. Hovering a material keeps its assigned meshes opaque and makes the rest translucent; restore normal opacity when contact ends. Outside this preview, the full product remains opaque in Material. See [MaterialAssignments](../web/src/MaterialAssignments.tsx), [materials](../web/src/materials.ts) and [viewport](../web/src/viewport.ts).

### D20 — The material sample is an instrument

**In code.** Ball swatches show material response; pointer position within the sample window moves the preview light. Selecting a preset enlarges and fixes its sample while properties scroll beneath it. A small opacity-based sphere / rectangle icon toggle sits at the sample's top right. Standard types and maps are available, with optional fal Patina generation and Poly Haven assets. See [MaterialSwatches](../web/src/MaterialSwatches.tsx), [MaterialLibrary](../web/src/MaterialLibrary.tsx) and [material asset service](../film/material_assets.py).

### D21 — Preview is not save

**In code.** Apply material drafts visibly to the actual product with a top-right Preview label. Keep large Save / Cancel actions fixed at the bottom of the right panel. Saving updates attached objects/sections; cancel restores the saved state. Unsaved drafts must not silently become scene revisions or exports. See [MaterialLibrary](../web/src/MaterialLibrary.tsx) and [App](../web/src/App.tsx).

### D22 — Decals use the product's UV map

**In code / direction.** Overlay the UV map across the viewport, select components through the tree, place artwork, and expose height/bevel controls. No timeline is needed for this task. UV hover maps to a **solid red dot with a red ring** on the translucent target mesh; the earlier glowing-point proposal was superseded. When the user is not dragging the decal itself, pointer gestures operate the scene normally. The intermediate opposite-side slide-in UV panel was superseded by the full-viewport overlay. See [DecalEditor](../web/src/DecalEditor.tsx), [decals](../web/src/decals.ts) and [UV probe checks](../web/src/uvProbe.test.ts).

### D23 — Reuse real assets and keep provider boundaries clear

**In code / direction.** Integrate Poly Haven for CC0 textures, props and HDRIs; retain asset source metadata. Keep World Labs / Marble for world generation after considering fal worlds. fal Patina is a texture path, not a replacement world provider. The current app supports authored defaults and imported worlds; preview/render approximation and external-provider prerequisites must remain explicit. See [Poly Haven service](../film/polyhaven.py), [World panel](../web/src/WorldPanel.tsx) and [World Labs workflow](worldlabs-api.md).

### D24 — Campaigns preserve the whole composition

**In code / direction.** Make the lamp campaign and its world accessible as a campaign, not a disconnected promotional render. Keep the non-Gaussian textured world available for full scene views. Opening shots should be straight unless a tilt is deliberately composed. The Nessino rendering records a rigid leveling correction; do not casually rotate or deform source CAD geometry to conceal a camera/assembly problem. See [asset provenance](../web/src/assets/gesso/ASSETS.md) and [real-product trials](real-product-trials.md).

### D25 — World objects get rendered previews and a separate inspector

**In code.** Show world-object renderings, names, type and dimensions in the left library. Clicking one opens geometry/surface controls in the right rail. Use the same primitive/source geometry as the real viewport, with bounded preview rendering and cleanup; do not substitute unrelated decorative thumbnails. See [WorldObjectPreviews](../web/src/WorldObjectPreviews.tsx), [WorldObjectEditor](../web/src/WorldObjectEditor.tsx), [worldObjectPreview](../web/src/worldObjectPreview.ts) and [shared scene objects](../web/src/sceneObjects.ts).

## Film, rendering and recovery

### D26 — Shot-first authoring, with detailed control underneath

**In code / direction.** Prefer a legible sequence of shots and named motion decisions over presenting every possible keyframe track immediately. New frame flow is **create frame → select object(s) and motion → select camera target and motion**. Distinguish movement belonging to one shot from movement continuing across cuts. Keep detailed curves/keyframes available for refinement. See [NewFrameFlow](../web/src/NewFrameFlow.tsx), [FilmWorkspace](../web/src/FilmWorkspace.tsx) and [film motion](../web/src/filmMotion.ts).

### D27 — The scene is the source of truth

**In code.** Shots, base poses, named motions and explicit keys are scene data; displayed timelines and evaluated frames derive from them. Do not maintain an independent visual timeline that disagrees with playback/export. Trim and stretch are separate operations because changing duration need not retime an action. Canonical units, IDs and assembly transforms survive editing and renderer conversion. See [scene contract](implementation-contract.md), [sequence](../web/src/sequence.ts), [film motion](../web/src/filmMotion.ts) and [keyframes](../web/src/keyframes.ts).

### D28 — Camera information belongs where the image is composed

**In code / direction.** Show camera frame/aspect, target and focus-related controls in the viewport, following the original prototype. “Focus radius” means optical depth of field, not only a decorative target circle. Keep numerical controls and actual optical preview behavior connected. See [FilmViewportControls](../web/src/FilmViewportControls.tsx), [camera framing](../web/src/cameraFraming.ts) and [DepthOfFieldPreview](../web/src/DepthOfFieldPreview.ts).

### D29 — A compact timeline that enters with the frame

**In code / direction.** The Film bottom panel slides into view as the frame adjusts, with rounded lower corners. Reduce empty vertical space and align track/control columns; do not make label, unit and field spacing depend on adjacent text length. Earlier oversized timeline space was superseded. See [film shell](../web/src/film-shell.css), [FilmWorkspace](../web/src/FilmWorkspace.tsx) and [EditorControls](../web/src/EditorControls.tsx).

### D30 — One shot row, one playback position

**In code; latest correction.** Shots sit in a row. The playback ticker is a line **inside the shot boxes**, not a separate seek line below them. Click or drag the shot row to scrub; detailed motion editing refers to the same frame. See [FilmShotStrip](../web/src/FilmShotStrip.tsx), [FilmWorkspace](../web/src/FilmWorkspace.tsx) and their corresponding tests.

### D31 — Both Film rails identify the same active shot

**In code; latest correction.** When the active shot determines both sidebars, both start with its number and name. Headers derive from the same current frame/shot used by playback and scrubbing. Output settings retain their own scope rather than being mislabeled as an individual shot. See `FilmShotHeader` in [FilmWorkspace](../web/src/FilmWorkspace.tsx) and its use in [App](../web/src/App.tsx).

### D32 — Export for the next real destination

**In code.** Offer PNG for lossless design handoff, JPEG for sharing/catalogs, WebP for web images, MP4/H.264 for web/social video, MOV/ProRes 422 for editing, and PNG sequences for compositing. Expose format prerequisites, resolution/samples, progress, failure and downloadable artifacts. Export snapshots the current validated scene; an unsaved material preview must be saved or discarded first. Export does not require the whole campaign to have been saved as a revision. See [export model](../web/src/exportModel.ts), [ExportPanel](../web/src/ExportPanel.tsx), [export formats](../film/export_formats.py) and the [README](../README.md).

### D33 — Loading is a visible state, not a blank canvas

**In code.** While a new world/scene is loading, show a pulsing-opacity viewport overlay and “Loading” with staggered ellipses. Clear it only when the current view is ready; preserve reduced-motion behavior. Keep the previous usable frame during resize/change until a new rendered frame is available. See [ViewportLoading](../web/src/ViewportLoading.tsx), [viewport loading styles](../web/src/viewport-loading.css) and [viewport](../web/src/viewport.ts).

## Shared frame and public pages

### D34 — One deforming boundary across the product

**In code.** Landing, About, philosophy and studio share one dynamic wrapper and frame renderer, with content explicitly inside or outside the opening. Keep 64 corresponding Bézier anchors across shapes; the frame is persistent identity rather than a new unrelated mask per page. The shell/nav can remain fixed while the content behind it changes. See [DynamicFrame](../web/src/DynamicFrame.tsx), [frame geometry](../web/src/frameGeometry.ts), [frame morph](../web/src/frameMorph.ts) and [StudioEntry](../web/src/StudioEntry.tsx).

### D35 — Landing opens from a rounded X

**In code / direction.** Center the wordmark within the rendering; put “your product” and “your world” on opposing sides. Cursor proximity expands the rounded X through a circle into a rectangle, pushes surrounding words away and reveals Enter studio. Play one continuous reversible animation on enter/exit. The expanded endpoint follows the linked Figma landing frame; the rectangle is not the default shape. See [LandingPage](../web/src/LandingPage.tsx), [landing morph](../web/src/landingMorph.ts) and [landing styles](../web/src/landing.css).

### D36 — Halo and image have different jobs

**In code / direction.** The centered wordmark takes the halo color, replacing the earlier outer-background-color proposal. Keep a broad chromatic light edge, remove the dark exterior drop shadow, and use a restrained inner vignette on the video. A requested darker result means darken the broad light/background and shift hue optically; do not tighten it into a conspicuous neon rim. See [dynamic frame styles](../web/src/dynamic-frame.css), [landing styles](../web/src/landing.css) and [asset provenance](../web/src/assets/gesso/ASSETS.md).

### D37 — Public pages have related, distinct pigments

**In code.** Landing uses its Figma red ground / orange light; About uses blue, and philosophy uses purple. Match the cover's relationship between hue and darkness across those palettes rather than copying numeric brightness. The About logo can remain white; the endnote Enter studio action is blue. See [landing](../web/src/landing.css), [About](../web/src/about.css) and [philosophy styles](../web/src/shape-light.css).

### D38 — Real prototype footage, quieter overlays

**In code / direction.** Use a sequence of real prototype renders within the landing window, including a straight lamp shot and geometric close-up. Expanded-window overlays can suggest editing, but remove the material controls, lower-left annotations and bottom play/pause clip controls. Put time at the top right and product name in the following column. The blinking recording dot sits before the alignment edge, so the text itself aligns to the grid. See [LandingVideoOverlay](../web/src/LandingVideoOverlay.tsx), [landing reel](../web/src/landingReel.ts) and [render provenance](../web/src/assets/gesso/ASSETS.md).

### D39 — Studio entry is centered and lightweight

**In code.** Contract the opening to a centered loader, then expand into the real editor window after it is ready. The latest loader begins as a circle and changes through perspectives of an oval; it replaces a rotating perimeter and a more complex catalog-shape cycle. Settle the ellipse while small before expansion to avoid wrinkled full-screen edges. Put a quiet “← back” control with the loading state. See [studioLoading](../web/src/studioLoading.ts) and [StudioEntry](../web/src/StudioEntry.tsx).

### D40 — About is a fixed window with grid-aligned reading

**In code / direction.** Keep the window and navbar fixed as their own layer, with changing/scrolling content behind. Arrange headings on the left and body on the right according to the grid. Product description, audience, four workspaces and repeat-use value belong here. The updated Figma About layout supersedes the earlier arrangement. See [AboutPage](../web/src/AboutPage.tsx), [product description](../web/src/productDescription.ts) and [About styles](../web/src/about.css).

### D41 — Philosophy is a sequence of distinct configurations

**In code / direction.** After the dictionary cover, introduce the principles with a less formal heading (“How we make things”). Each principle has a different shape/configuration: result, product, interface, person. Remove the unrelated “Move the boundary” live-editor section from this narrative. Keep the experimental curve editor separate. Do not add a footer that clips the content; soften the header edge with a fade. See [ShapeLightPage](../web/src/ShapeLightPage.tsx).

### D42 — Text makes room for the moving contour

**In code / direction.** Use Pretext to measure and lay out real HTML text around the current shape. Keep intended left/right reading placement and outer padding, and enlarge/centralize shapes enough to meaningfully affect the composition. Shift the cover rectangle right to prevent an isolated “g”/broken title. Preserve stable line identity and motion between layouts instead of repeatedly replacing whole text blocks. See [philosophy text](../web/src/philosophyText.ts), [line layout](../web/src/philosophyLineLayout.ts), [text motion](../web/src/philosophyTextMotion.ts) and [sequence](../web/src/philosophySequence.ts).

### D43 — Scroll should settle without stopping twice

**Direction / in code.** Settle toward finished philosophy keyframes in the direction of scroll momentum. Avoid a visible pause followed by a second abrupt snap, fighting active input, flickering contents or jumping line breaks. Keep shape, text and material updates coordinated, with interruption and reduced-motion handling. This is a perceptual constraint, not proof that every device feels identical. See [philosophy motion](../web/src/philosophyMotion.ts), [text motion](../web/src/philosophyTextMotion.ts) and [ShapeLightPage](../web/src/ShapeLightPage.tsx).

### D44 — Glassine is the opening material study

**In code / direction.** Use an interactive glassine specimen with iridescent aberration for the first philosophy opening. Reuse Estelle's scan and glassine work, with spectral behavior informed by the [rainbow canvas study](https://softcopy.digital/studies/rainbow-canvas.html). Other sections may use product screenshots rather than separate WebGL studies. The implementation includes a deterministic still for compact screens/fallback; no claim is made that all later screenshot assets are complete. See [GlassineStudy](../web/src/GlassineStudy.tsx), [glassine renderer](../web/src/glassineRenderer.ts) and [asset provenance](../web/src/assets/gesso/ASSETS.md).

### D45 — Form-preserving morphs, not a universal circle detour

**In code.** Keep all destinations true to their shapes and inspect middle frames, not only endpoints. Use shape-aware interpolation and consistent anchor/tangent conventions. The landing cross can travel through a circle; arbitrary rectangles and other forms should not all become circles. SDF interpolation was considered, not accepted as a requirement to replace the working renderer. See [frameMorph](../web/src/frameMorph.ts) and [morph tests](../web/src/frameMorph.test.ts).

### D46 — Performance must preserve the effect

**Direction / in code.** Prioritize the persistent frame, separate expensive content work, cache measurements/morph preparation, share rendering where useful and pause hidden/offscreen work. Avoid rebuilding the entire application per animation frame. Disable whole-page transitions on compact/mobile layouts and retain content under reduced motion. GPU offload was investigated as a means, not a requirement to move all geometry computation into shaders. See [DynamicFrame](../web/src/DynamicFrame.tsx), [philosophy text](../web/src/philosophyText.ts) and [material swatches](../web/src/MaterialSwatches.tsx).

### D47 — A 16-shape catalog using the same 64-point engine

**In code.** The stripped-down `/curves` demo selects two shapes from a left catalog and interpolates them in the main window, using the production morph engine rather than a halo demo. Sixteen distinct shapes replace repetitive variants: circle, square, rectangle, capsule, triangle, diamond, pentagon, hexagon, trapezoid, octagon, arch, corner, cross, plus, eight-point star and oval. Oval replaces chevron. Old specimen URLs have aliases. See [CurveDemo](../web/src/CurveDemo.tsx) and [curve presets](../web/src/curvePresets.ts).

### D48 — Guides must explain a boundary

**In code; revised.** Marketing shape guides are fine white dotted hairlines at **50% opacity**, tracking the animated opening and aligning settled poses to the layout grid where possible. Thicker and fully opaque experiments were superseded. Guides sit behind interactive UI; menus appear above them.

The latest editor correction removes the decorative viewport-spanning guides from studio. Dotted rules instead separate meaningful groups **within the same sidebar's margins**—for example Objects / Part details, Geometry / Surface, or material properties. Retain short tree stems that express actual assignment/hierarchy. See [frame guides](../web/src/frame-guides.css), [guide geometry](../web/src/frameGuides.ts) and [interface system](../web/src/interface-system.css).

### D49 — “Form + light” is the public name

**In code; latest correction.** Rename “shape + light” to **“form + light”** in navigation, displayed copy and document title. Keep existing `/aperture` URLs and internal identifiers where they preserve links and avoid an unrelated migration. See [ShapeLightPage](../web/src/ShapeLightPage.tsx), [AboutPage](../web/src/AboutPage.tsx) and [StudioEntry](../web/src/StudioEntry.tsx).

## Design source and known limits

The supplied design source is the [gesso Figma file](https://www.figma.com/design/yeSSVUrYYw45JLkN7mnv52/gesso). Relevant requested references include [landing 40:1124](https://www.figma.com/design/yeSSVUrYYw45JLkN7mnv52/gesso?node-id=40-1124), [philosophy 40:1130](https://www.figma.com/design/yeSSVUrYYw45JLkN7mnv52/gesso?node-id=40-1130), [philosophy continuation 184:7913](https://www.figma.com/design/yeSSVUrYYw45JLkN7mnv52/gesso?node-id=184-7913), [About 184:7680](https://www.figma.com/design/yeSSVUrYYw45JLkN7mnv52/gesso?node-id=184-7680) and [landing overlays 167:4269](https://www.figma.com/design/yeSSVUrYYw45JLkN7mnv52/gesso?node-id=167-4269). The file has been manually edited throughout the process. These are reference locations, **not a current synchronization claim**.

Early Figma-first prototypes, a proposed Paper migration, and later code-first edits were workflow choices, not a requirement to maintain several independent product implementations. Keep this repo's real engine and scene state as the executable artifact. When updating Figma, preserve editable type/components and explicitly reconcile the latest manual padding/layout changes rather than overwriting them with an older capture.

The implementation contracts and test results remain the authority for technical capability. Current limitations include asset preparation before GLB import, bounded hierarchy/mechanism support, provider/renderer dependencies, local-font availability, and differences between live preview and final Cycles rendering. The broad “finished image at any step” direction must not erase these limits from the product's actual states.

## Future entries

Append below this line. Example structure:

```text
YYYY-MM-DD — D50 — Short decision title
Status: Direction | In code | Open | Superseded
Decision: The selected behavior and the state it governs.
Reason: The concrete confusion, constraint or workflow it resolves.
Scope: Affected views/data; any intentional limits.
Replaces: Dxx, if applicable.
Source / verification: Request, code/design links, and checks actually performed.
```
