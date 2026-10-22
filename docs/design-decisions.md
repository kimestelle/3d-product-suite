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

**In code / direction; Halyard restored for numeric values in D71.** Use Halyard throughout, with Text for interface/body and Display for display typography. Keep Figma typography editable rather than converting it to outlines to work around remote font access. The temporary Instrument Sans direction was superseded by restoring Halyard. The repo resolves locally installed Halyard; it does not redistribute Adobe font files, so a fallback is expected on machines without it. See [type tokens](../web/src/interface-system.css) and [asset provenance](../web/src/assets/gesso/ASSETS.md).

### D06 — A short dictionary entry and a concrete manifesto

**Direction / partially in code.** Replace “Brand Manifesto” with a dictionary treatment of *gesso*. Use **“A ground applied to a surface before painting.”** as the philosophy cover title, followed by a short bridge to the product. About carries product description and audience; the philosophy page carries design intent. Copy should also work as a marketing pitch without repeating About. Estelle's [notes](https://softcopy.digital/notes/) informed the requested brevity; no authorship or quotations are transferred from unrelated work.

**Resolved in the app by D52:** the user rejected “Keep what’s been decided” and its surrounding abstract copy as ambiguous. The passage was still present at the retrospective recording; D52 replaces it with concrete scene/product language. No corresponding Figma update is claimed.

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

**In code.** Category shortcuts use Option/Alt + number, shown after the label as superscripts; do not alternate modifier conventions across the same navigation. The original four categories used 1–4; D118 supersedes that mapping with three categories on 1–3. G / R / S starts position, rotation and scale in the viewport, with axis constraints and cancel/confirm behavior, rather than merely focusing a numeric field. Preserve text-input editing and familiar undo/redo shortcuts. See [navigation](../web/src/navigation.ts), [EditorNavigation](../web/src/EditorNavigation.tsx) and [TransformShortcuts](../web/src/TransformShortcuts.tsx).

### D13 — Four primary workspaces

**Superseded by D118.** The earlier top level was **Product / Material / World / Film**. Camera belongs in Film, with Still / Video mode. Product is for structure and mechanisms; Material gets finishes and decals. Static placement and object animation live in Film. Earlier Product placement/animation tabs, a separate Camera category and the two-row top-bar experiment were superseded. Old deep links resolve to the replacement locations. See [navigation.ts](../web/src/navigation.ts).

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

**In code; rectangle choice superseded by D82.** Ball swatches show material response; pointer position within the sample window moves the preview light. Selecting a preset enlarges and fixes its sample while properties scroll beneath it. A small opacity-based sphere / rectangle icon toggle sits at the sample's top right. Standard types and maps are available, with optional fal Patina generation and Poly Haven assets. See [MaterialSwatches](../web/src/MaterialSwatches.tsx), [MaterialLibrary](../web/src/MaterialLibrary.tsx) and [material asset service](../film/material_assets.py).

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

**Viewport settings placement superseded by D136; optical behavior retained.** Show camera frame/aspect, target and focus-related controls in the viewport, following the original prototype. “Focus radius” means optical depth of field, not only a decorative target circle. Keep numerical controls and actual optical preview behavior connected. See [FilmViewportControls](../web/src/FilmViewportControls.tsx), [camera framing](../web/src/cameraFraming.ts) and [DepthOfFieldPreview](../web/src/DepthOfFieldPreview.ts).

### D29 — A compact timeline that enters with the frame

**In code / direction.** The Film bottom panel slides into view as the frame adjusts, with rounded lower corners. Reduce empty vertical space and align track/control columns; do not make label, unit and field spacing depend on adjacent text length. Earlier oversized timeline space was superseded. See [film shell](../web/src/film-shell.css), [FilmWorkspace](../web/src/FilmWorkspace.tsx) and [EditorControls](../web/src/EditorControls.tsx).

### D30 — One shot row, one playback position

**In code; latest correction.** Shots sit in a row. The playback ticker is a line **inside the shot boxes**, not a separate seek line below them. Click or drag the shot row to scrub; detailed motion editing refers to the same frame. See [FilmShotStrip](../web/src/FilmShotStrip.tsx), [FilmWorkspace](../web/src/FilmWorkspace.tsx) and their corresponding tests.

### D31 — Both Film rails identify the same active shot

**Superseded by D64; label treatment was refined by D63.** When the active shot determines both sidebars, both start with its number and name. Headers derive from the same current frame/shot used by playback and scrubbing. Output settings retain their own scope rather than being mislabeled as an individual shot. See `FilmShotHeader` in [FilmWorkspace](../web/src/FilmWorkspace.tsx) and its use in [App](../web/src/App.tsx).

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

**Reflow behavior superseded by D116.** Pretext now wraps fixed lines on font/width changes; scrolling moves whole lines horizontally.

**In code / direction.** Use Pretext to measure and lay out real HTML text around the current shape. Keep intended left/right reading placement and outer padding, and enlarge/centralize shapes enough to meaningfully affect the composition. Shift the cover rectangle right to prevent an isolated “g”/broken title. Preserve stable line identity and motion between layouts instead of repeatedly replacing whole text blocks. See [philosophy text](../web/src/philosophyText.ts), [line layout](../web/src/philosophyLineLayout.ts), [text motion](../web/src/philosophyTextMotion.ts) and [sequence](../web/src/philosophySequence.ts).

### D43 — Scroll should settle without stopping twice

**Direction / in code; settling policy refined by D51, then D70.** Settle toward finished philosophy keyframes in the direction of scroll momentum. Avoid a visible pause followed by a second abrupt snap, fighting active input, flickering contents or jumping line breaks. Keep shape, text and material updates coordinated, with interruption and reduced-motion handling. This is a perceptual constraint, not proof that every device feels identical. See [philosophy motion](../web/src/philosophyMotion.ts), [text motion](../web/src/philosophyTextMotion.ts) and [ShapeLightPage](../web/src/ShapeLightPage.tsx).

### D44 — Glassine is the opening material study

**In code / direction; opening material treatment superseded by [D147](#2026-10-21--d147--press-the-grid-into-the-paper).** Use an interactive glassine specimen with iridescent aberration for the first philosophy opening. Reuse Estelle's scan and glassine work, with spectral behavior informed by the [rainbow canvas study](https://softcopy.digital/studies/rainbow-canvas.html). Other sections may use product screenshots rather than separate WebGL studies. The implementation includes a deterministic still for compact screens/fallback; no claim is made that all later screenshot assets are complete. See [GlassineStudy](../web/src/GlassineStudy.tsx), [glassine renderer](../web/src/glassineRenderer.ts) and [asset provenance](../web/src/assets/gesso/ASSETS.md).

### D45 — Form-preserving morphs, not a universal circle detour

**In code.** Keep all destinations true to their shapes and inspect middle frames, not only endpoints. Use shape-aware interpolation and consistent anchor/tangent conventions. The landing cross can travel through a circle; arbitrary rectangles and other forms should not all become circles. SDF interpolation was considered, not accepted as a requirement to replace the working renderer. See [frameMorph](../web/src/frameMorph.ts) and [morph tests](../web/src/frameMorph.test.ts).

### D46 — Performance must preserve the effect

**Direction / in code.** Prioritize the persistent frame, separate expensive content work, cache measurements/morph preparation, share rendering where useful and pause hidden/offscreen work. Avoid rebuilding the entire application per animation frame. Disable whole-page transitions on compact/mobile layouts and retain content under reduced motion. GPU offload was investigated as a means, not a requirement to move all geometry computation into shaders. See [DynamicFrame](../web/src/DynamicFrame.tsx), [philosophy text](../web/src/philosophyText.ts) and [material swatches](../web/src/MaterialSwatches.tsx).

### D47 — A 16-shape catalog using the same 64-point engine

**Original pair interaction superseded by D92.** The stripped-down `/curves` demo selects two shapes from a left catalog and interpolates them in the main window, using the production morph engine rather than a halo demo. Sixteen distinct shapes replace repetitive variants: circle, square, rectangle, capsule, triangle, diamond, pentagon, hexagon, trapezoid, octagon, arch, corner, cross, plus, eight-point star and oval. Oval replaces chevron. Old specimen URLs have aliases. See [CurveDemo](../web/src/CurveDemo.tsx) and [curve presets](../web/src/curvePresets.ts).

### D48 — Guides must explain a boundary

**In code; revised.** Marketing shape guides are fine white dotted hairlines at **50% opacity**, tracking the animated opening and aligning settled poses to the layout grid where possible. Thicker and fully opaque experiments were superseded. Guides sit behind interactive UI; menus appear above them.

An earlier interpretation removed viewport-spanning guides from studio; **superseded by D56**, which restores them alongside the sidebar rules. Dotted rules separate meaningful groups **within the same sidebar's margins**—for example Objects / Part details, Geometry / Surface, or material properties—with their inline header placement defined by D55. Retain short tree stems that express actual assignment/hierarchy. See [frame guides](../web/src/frame-guides.css), [guide geometry](../web/src/frameGuides.ts) and [interface system](../web/src/interface-system.css).

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

### 2026-10-19 — D50 — Regular prose, selective emphasis

**In code.** About's product description, process note and main narrative heading, plus Form + Light's narrative headings and prose, use Halyard Regular. Preserve the existing four-step section, numbered wayfinding, navigation and footer emphasis. Hierarchy should come from role and scale instead of making every paragraph look important.

Body copy already requested weight 400 and the installed Halyard Regular faces resolved correctly. A browser comparison identified heavier white-on-dark edge rendering; scope `-webkit-font-smoothing: antialiased` to the reading text on supporting browsers instead of substituting a lighter font and calling it Regular. Narrative display headings change from 500 to 400. Keep layout, type families, sizes, colors and the shared text-flow engine intact. Extends D05 and D40–D42. See [About styles](../web/src/about.css) and [Form + Light styles](../web/src/shape-light.css).

### 2026-10-19 — D51 — Scroll leads; snapping only finishes a nearby position

**Superseded by D70.** Let wheel gestures stop between Form + Light keyframes. Settle only toward a stop ahead in the final scroll direction, within 14% of its neighboring interval and at most 96px. Never pull backward toward a departed frame or turn a small notch into a whole-page movement. Shorten the correction to 160–240ms (down to 120ms for a fast continuation); preserve a bounded, monotone trajectory. New wheel input or resumed native movement cancels the correction, including compositor movement that arrives before its scroll callback. Mobile, reduced motion, selected text and fine keyboard reading retain their existing exclusions.

The earlier mandatory nearest-stop policy could turn a roughly 133px wheel gesture into a 660px page turn. A native CSS proximity experiment was discarded because the same small gesture returned to the starting stop in the tested browser. The accepted rule preserves that 133px reading position, settles only when approaching the next stop, and allows immediately leaving it in reverse. Shape and text still use the actual scroll offset and the existing shared renderer; no independent visual scroll clock was added. Refines D43. See [stop selection](../web/src/philosophyMotion.ts), [scroll controller](../web/src/philosophyScroll.ts), and their regression tests. Verified through local wheel/anchor interactions, the focused motion/layout tests, and the production build.

### 2026-10-19 — D52 — Name what changes and what stays

**In code.** Replace the Product principle's abstract language about interpretation and approval with **“Same product. Different scene.”** and **“Change the room, light, or camera. Your product keeps its dimensions, parts, materials, artwork, and motion.”** Name the actual editable things and the consequence; omit an implied approval workflow. This resolves the stale passage recorded under D06. Scope: [Form + Light Product principle](../web/src/ShapeLightPage.tsx); no Figma change. Keep its existing frame, typography and text-flow renderer.


### 2026-10-19 — D53 — Arrows promise disclosure; section labels have a type role

**In code; optical-family comparison available.** Remove disclosure arrows from Product's Part details, Material's Library/Decals, World's Environment/Objects/Lighting, and Film's section selectors. These buttons select one active section and cannot collapse it. Use `aria-current` for that selection, retain their button identity, focus and shortcuts, and reserve chevrons plus expanded-state semantics for actual disclosures: the object tree, Mechanics, material properties, libraries and camera options.

The original section-label treatment used uppercase Halyard Regular with 0.04em tracking at the existing sizes; **superseded by D55**. Preserve mixed-case product/part/shot names, values, units, summary text, and ordinary controls. **View → Section headings** compares Halyard Text (default), Micro and Display; only the optical family changes between treatments. This is session-local UI state, separate from the scene and undo history. The installed Halyard faces do not provide OpenType `smcp`/`c2sc`; the original treatment used regular capitals, not synthesized small caps. Micro resolves licensed local fonts, with Text as fallback; no font files are redistributed.

Reason: an arrow should predict a real action, and a section should be distinguishable from an editable name without shrinking the type. Scope: editor sidebars, their actual disclosures and fixed section labels; page typography and top-level navigation remain unchanged. Source: user's hierarchy correction; [interface styles](../web/src/interface-system.css), [View comparison](../web/src/App.tsx), and Product/World/Film panel selectors. Verification: 40 focused panel tests and production build passed; browser checks compared all three families, exercised mouse/keyboard section selection and real Alignment/material-property collapse.

### 2026-10-19 — D54 — Menus and cabinets reveal their contents in place

**In code.** File, Edit, View and History share a persistent menu surface that transitions to its measured content height. Sidebar cabinets originally transferred their available height over 240ms; D60 replaces that expansion with natural content height. Content fades in over 160ms with a short 16ms row cascade capped at 64ms. Closing fades take 120ms without stagger. New input reverses the current transition. Preserve the existing typography, spacing, selection rules, scene state and scrollable controls.

Retain outgoing cabinet content only for the closing transition, including its existing portal destination. Closing controls become inert and leave the accessibility tree; Escape from menu fields returns focus to the menu trigger. Genuine native disclosures and material-property groups animate intrinsic height where supported, with ordinary functional disclosure as fallback. Film's Output inspector keeps its natural content height. Compact/touch layouts and reduced-motion preferences use the existing static-motion policy.

Reason: reveal the relationship between a section and its controls without a sudden height jump or a long decorative sequence. Scope: [shared menu/cabinet components](../web/src/editorMotion.tsx), [motion styles](../web/src/editor-motion.css), [native/material disclosures](../web/src/editor-disclosures.css), and [disclosure focus/inert handling](../web/src/editorDisclosureState.ts). Verification: production build and 45 focused panel/disclosure tests passed. Browser checks exercised menu switching, Escape from a field, rapid cabinet reversals, material properties, native Alignment and Mechanics disclosure, and Film Output sizing.

### 2026-10-19 — D55 — Section labels lead into dotted rules

**In code.** Restore section names to their authored case, use Halyard at weight 600 with normal tracking, and place the existing fine dotted rule in the same row after the label. Where a summary, count, or action appears on the right, the rule fills the space between it and the label. Remove the earlier separate rules above these groups. Keep metadata at regular weight, existing sizes and spacing, and real disclosure chevrons and animation behavior.

Reason: distinguish sections through weight and a visible boundary without uppercase styling. Scope: Product, Material, World and Film sidebar section selectors, fixed section labels, and disclosures; object names, field labels, top navigation, and public pages keep their existing roles. Supersedes D53's uppercase treatment and refines D48's placement of sidebar rules. D59 narrows this treatment to main headers, removing it from nested subheadings. See [interface styles](../web/src/interface-system.css). Verification: production build and diff whitespace checks passed; browser checks covered Product, both Material panels, World, and Film headers.

### 2026-10-19 — D56 — Frame guides remain visible in studio and loading

**In code; settled-editor visibility superseded by D66.** Restore the shared dotted boundaries around the editor window and the morphing studio loader. Sidebar header rules coexist with these frame guides. Remove the studio-route visibility override, which also hid the loader because it uses the same route. Let the shared ground provide the topbar and sidebar backdrops so opaque chrome does not conceal the guides; controls and menus keep their own surfaces. Preserve the original .75px rounded dots at 50% white opacity, the shared curve-extrema geometry, and the layer beneath content and menus. This corrects D48's overbroad interpretation of the sidebar-divider request; it does not change D55's header treatment. See [frame guides](../web/src/frame-guides.css), [shared frame styles](../web/src/dynamic-frame.css), and [shared renderer](../web/src/DynamicFrame.tsx).

Verification for D56: production build and diff whitespace checks passed. Browser captures confirmed the dynamic loader and settled editor guides; the File popup remains opaque above them.

### 2026-10-19 — D57 — Solid crosses mark guide intersections

**In code.** Place an 8-unit solid white plus mark with a 1px stroke at each of the four dotted-guide intersections. The lines retain their .75px stroke and 50% opacity. Compute both paths from the same displayed curve bounds and update them on the shared render clock, including morphs, loading, and resizing. Markers share the guides' layer beneath controls and menus, with no pointer interaction. Apply the same geometry in the curve catalog.

Reason: make the intersections explicit while preserving the fine dotted boundaries. Scope: shared page/editor/loader frame renderer and curve demo. Extends D48 and D56. See [guide geometry](../web/src/frameGuides.ts), [guide styles](../web/src/frame-guides.css), [shared renderer](../web/src/DynamicFrame.tsx), and [curve demo](../web/src/CurveDemo.tsx).

Verification for D57: production build, 69 existing shared-frame tests, and diff whitespace checks passed. Browser captures confirmed crosses on the loading shape and all four settled editor intersections.

### 2026-10-19 — D58 — Left sidebar dividers reach the screen edge

**In code.** Extend the dotted section rules through the left sidebar's outer gutter to the screen edge. Leave an 8px gap before each label; keep labels, controls, metadata and the existing trailing rules on their grid. Expand the clipping boxes with compensating padding so cabinet and disclosure height transitions retain their existing behavior. Keep the right inspector and shared frame guides unchanged.

Reason: section boundaries should reach the outside edge instead of appearing inset with the controls. Scope: Product, Material, World and Film left sidebar section headings and disclosures. Extends D55's inline rule treatment. See [interface styles](../web/src/interface-system.css).

Verification for D58: production build and diff whitespace checks passed. Browser checks covered all four left rails and opening/closing Original materials; heading boxes start at x=0 with their original 40px content padding and no horizontal overflow.

### 2026-10-19 — D59 — Rules distinguish main sections from subheadings

**In code.** Keep dotted rules and Halyard 600 on main cabinet headers and the Objects tree header. Use Halyard 500 without either leading or trailing rules for nested labels such as Surroundings, Background, Environment light, Studio rig, Ambient, Material slots, Path and Generate texture. Nested disclosures follow the lighter treatment while retaining their working chevrons and right-aligned metadata. Preserve sizes, copy, control alignment and motion.

Reason: the shared rule had made subheadings compete with their containing section. Scope: editor sidebar heading hierarchy. Refines D55 and limits D58's gutter extension to main dividers. See [interface styles](../web/src/interface-system.css).

Verification for D59: production build and diff whitespace checks passed. Browser checks confirmed 500-weight, rule-free Environment and Lighting subheadings, with 600-weight main headers and their edge-reaching rules preserved. Alignment still opens and closes with its metadata and chevron aligned to the right.

### 2026-10-19 — D60 — Content determines sidebar section height

**In code.** Stop expanding the open cabinet into unused sidebar height. Stack sections at their content height, shrinking the open body into its existing scroll area only when needed. Animate body height rather than distributing free space between cabinets; preserve exit presence, inert controls, focus restoration, reduced motion and disclosure behavior. Use 32px main header rows, 24px nested disclosure rows, 8px section gaps, and 4px between a subheading and its first control. Reduce the panel title's bottom padding to 8px.

Reason: flex growth placed short sections far apart, while nested disclosure rows inherited main-header spacing. Scope: editor sidebar cabinets and heading spacing. Refines D54's height-transfer implementation and D59's hierarchy; typography, dotted rules, horizontal grid and copy are preserved. See [interface styles](../web/src/interface-system.css) and [cabinet motion](../web/src/editor-motion.css).

Verification for D60: production build, 33 focused panel/disclosure tests and diff whitespace checks passed. Browser checks confirmed that the Environment section uses only its content height, the main rows stay visible, and Lighting retains a scrollable body with its final controls reachable.

### 2026-10-19 — D61 — Form + Light has a broader halo

**In code.** Double the philosophy page's halo blur and spread together: 136px blur and 64px spread at its reference scale. Double the static mobile halo's extent as well. Keep the purple palette, opacity, shapes, text layout and shared frame renderer. Other pages retain their existing light.

Reason: give Form + Light a much wider field of light while preserving its soft falloff. Scope: [Form + Light frame source](../web/src/ShapeLightPage.tsx) and [mobile fallback](../web/src/shape-light.css); extends D36–D37's broad, hue-shifting light treatment.

Verification for D61: production build and diff whitespace checks passed. Desktop browser captures confirmed the wider halo on the cover and the narrower Product chapter, without a visible hard filter edge.

### 2026-10-19 — D62 — Loader perspective becomes more pronounced

**In code.** Tilt the loading circle into a much narrower oval: its minor axis now reaches 18% of its diameter instead of 42%. Keep the same 5.6-second cycle, centered 92px envelope, exact elliptical geometry, dotted guides and reduced-motion behavior. Return it to a front-facing circle while small before expanding into the editor.

Reason: make the perspective change legible at the loader's small size without collapsing it into a line or reintroducing wrinkled expansion edges. Scope: [loading geometry](../web/src/studioLoading.ts) and [geometry checks](../web/src/studioLoading.test.ts); refines D39's circle-to-oval loader.

Verification for D62: production build, 76 loading/shared-frame tests and diff whitespace checks passed. Geometry checks cover the stronger aspect ratio, centering, finite thickness, loop continuity and ripple-free expansion from every sampled phase. A local browser visit confirmed the centered loader still completes into the editor.

### 2026-10-19 — D63 — Film sidebars name the scene explicitly

**In code; dual-rail placement superseded by D64.** Show “Scene 01” as the quiet context label above the saved title, such as “Reveal”, in both Film sidebars. Keep a 4px gap, Halyard, the existing rail margins and the full title on hover. Derive numbering from the active shot exactly as before; preserve saved names, timeline behavior and the separate Output settings heading.

Reason: a bare number next to the title did not explain what it identified. Scope: `FilmShotHeader` in [FilmWorkspace](../web/src/FilmWorkspace.tsx) and [Film rail styles](../web/src/film-shell.css). Refines D31's heading presentation without changing the scene data model.

Verification for D63: production build and diff whitespace checks passed. The local Film view showed the explicit scene label above the title in both sidebars, aligned to the existing rail margins.


### 2026-10-19 — D64 — Objects left, properties right, time below

**In code.** The left Film rail identifies the selected scene and contains Camera, Whole product and expandable Parts with motion counts. The right rail identifies the selected target and owns framing/position, Add motion, assigned motions and their parameters. Selecting a motion reveals its amount, axis where relevant and easing immediately; pose fields, exact timing/scope, curves and custom keys remain reachable through disclosures. Keep Halyard and the shared 8px section / 4px control spacing without dotted nested headings.

The shallow timeline spans the workspace below the viewport and both rails, expanding when detailed curve or key editing needs room. Scene boxes and the selected target’s motion lanes use one global film time scale. A single playhead stays inside the scene boxes. New scenes start as “Untitled” with a collision suffix, leaving scene numbering to the context label. Rename scenes inline; use the contextual scene menu for duplicate, reorder, duration and removal, and the scene edge for trimming. Keep Export in the top bar and Output settings in the timeline.

Playback moves the preview frame without changing the scene being edited. A property edit pauses playback and resumes that editing scene; explicit “Return to Scene” and “Edit this frame” actions let the user return to the selection or adopt the preview frame. The left header shows this stable scene context; the right header names the target. This supersedes D31’s shared playback-driven headers and D63’s placement in both rails, while retaining D63’s explicit scene label.

Reason: each area should own one task, motion lengths should mean the same thing across rows, and crossing a camera cut should not silently redirect an edit. Scope: Film layout and editing context; existing scene data, motion evaluation and rendering remain the source of truth. Refines D26–D30 and D60. See [rails](../web/src/FilmWorkspace.tsx), [rail styles](../web/src/film-rails.css), [workspace shell](../web/src/film-shell.css), [timeline](../web/src/FilmTimeline.tsx), [time mapping](../web/src/filmTimelineModel.ts), [scene strip](../web/src/FilmShotStrip.tsx), [playhead state](../web/src/useFilmPlayhead.ts) and [app integration](../web/src/App.tsx).

Verification for D64: production build and all 853 tests passed (two test workers). Real browser checks confirmed that playback crossing cuts preserves the editing scene, editing a property resumes that scene, scene trimming can be undone, and discarding a new scene restores the sequence. Still mode hides the dock; the scene menu overlays the frame guides and Escape returns focus to its trigger. The dock measured 136px without motions and 168px with one motion at the tested desktop size. No browser console errors were reported.

### 2026-10-19 — D65 — Cover labels meet the outer grid margins

**In code; closed-state placement and offset calculation refined by D67.** When the landing window expands, “your product” moves to the left outer grid margin and “your world” to the right. Interpolate their inner text offsets with the existing aperture progress; preserve the closed composition, Halyard, shape timing, and compact-screen arrangement. CSS uses each label’s real width and the shared grid column, so font metrics and resize do not need another measurement loop.

Reason: the expanded text was centered within the outer columns instead of meeting the layout edges. Scope: [landing styles](../web/src/landing.css); refines D08 and D35. Verification: production build passed; browser measurements at the expanded endpoint placed both text edges within 0.01px of the shared 40px grid margins.

### 2026-10-19 — D66 — Frame guides fade once the editor opens

**In code.** Retain dotted bounds and solid intersection crosses through loading and the opening morph, then fade their shared SVG to zero opacity over 420ms when the frame renderer reports studio/settled. Restore them over 180ms when leaving the editor. Sidebar section rules and camera guides stay independent. Mobile and reduced-motion modes resolve visibility without the fade.

Reason: show the frame’s construction during the transition, then leave the editor’s content and controls clear. Scope: [shared guide styles](../web/src/frame-guides.css). Supersedes D56’s persistent settled-editor guides; retains its loading visibility and D57’s cross geometry.

Verification for D66: production build and diff whitespace checks passed. Browser inspection showed guide opacity 1 during studio expansion, 0 when studio settled, and 1 after returning to Landing; sidebar dotted rules remained visible.

### 2026-10-19 — D67 — Closed cover labels use exact column edges

**In code.** Anchor “your product” to column 2’s left edge and “your world” to column 6’s right edge in the closed landing composition. Move each outward by one column plus one gutter as aperture progress reaches 1, preserving D65’s outer-margin endpoint. Replace aperture-width travel and text-width compensation with the shared grid pitch. Keep Halyard, the existing reversible animation and mobile positions.

Reason: the closed text was approximately placed by shape width and could drift from the seven-column layout when viewport proportions changed. Scope: [landing styles](../web/src/landing.css); refines D08, D35 and D65. Verification: production build passed; desktop browser measurements matched the closed column edges within 0.01px.

### 2026-10-19 — D68 — Public navigation uses quieter Regular text

**In code.** Keep About and Form + Light in Halyard Text Regular (400), explicitly scoped to their shared navigation links, and apply the antialiased rendering already used for narrative copy. Preserve type size, grid positions and hover/current-page opacity. Enter studio retains weight 600.

Reason: the links already computed to weight 400, but white-on-color rendering made them appear heavier than editor text. Scope: public navigation on Landing, About and Form + Light in [site-grid.css](../web/src/site-grid.css); extends D50’s rendering treatment. Verification: production build and diff whitespace checks passed; the browser showed 400/antialiased on both links and the existing 600/auto on Enter studio.

### 2026-10-19 — D69 — OCR-B for measured values

**Removed; superseded by D71.** The local trial used locally activated OCR B Std for numeric inputs, Film time labels and numeric viewport readouts, and the cover timecode. Keep Halyard for names, labels, actions and status words, including Focus “Off.” Use a shared measure token; do not apply monospace to entire panels or navigation. The trial fell back to Halyard when OCR-B was unavailable, recorded font readiness, and did not bundle Adobe font files.

The installed OCR-B digit outlines are approximately 9–10% taller than Halyard Text Regular at equal nominal size, despite similar lowercase x-heights. Apply 91% size adjustment to the OCR face, with inverse ascent/descent overrides that preserve Halyard's effective line metrics. This also brings its monospaced digit advance close to Halyard's tabular digits. Keep 13px / 18px value type in 32px fields, regular weight, normal tracking and no synthesized weight. Use 12px / 18px for the cover clock, reserving eight characters without moving its grid anchor or recording dot. Raise the 9px Film ruler and curve labels to 10px / 12px; preserve larger controls and row geometry.

Reason: distinguish measurements from instructions without making the interface feel taller or adding decorative technical labels. Nominal font size and x-height alone would not correct the numeral size or baseline. Scope: shared interface font loading/tokens and controls, Film readouts/timeline, and the landing clock. Refines D05's Halyard-only type system for this limited trial; does not change copy or the document state model.

Verification: browser confirmed OCR-B and Halyard loaded, numeric fields computed to 400 at 13px / 18px, and the cover clock to 12px / 18px with a 62.9px advance. A negative decimal (-12.5) fitted the compact 44px coordinate field; material percentages and IOR were checked beside their Halyard labels. Test edits were undone and the temporary material preset discarded. Production build and all 17 Film viewport tests passed.


### 2026-10-19 — D70 — One rolling scroll position, with a live tuning window

**In code, opt-in since D75, with an on-page tuning panel.** On desktop with a fine pointer and no reduced-motion preference, wheel input drives one position/velocity model through six measured minima. The real scroll offset still drives the shared shape renderer and Pretext layout. Remove the scrollend wait and separate quintic snap: use a continuous quartic hill profile between stops, gradual pull as input fades, and damped integration in bounded substeps. Stops can be approached from either side, so slightly passing 03 no longer excludes it. Small departures temporarily release the stop just left; crossing into another basin or reversing toward the old stop restores attraction. Account for browser-rounded scroll offsets separately from the exact settling threshold.

The fixed “scroll study” panel shows the actual position, velocity, pull force, target and measured landscape. Its stop buttons and same-page contents links travel through the same integrator. Pull, damping ratio and input response are editable; smooth/native comparison and reset remain available. Tuning persists locally. Collapse the panel or hide/reopen it with Alt + Shift + D. The marker follows animation frames while numeric readouts update at 10Hz; hidden/collapsed panels stop their animation loop. This is a development control surface, not marketing copy.

Zoom, horizontal input, nested controls, selected text, pointer contact, fine keyboard navigation, compact/touch devices and reduced motion keep native behavior. New wheel input interrupts an explicit seek; resize, navigation, visibility and policy changes cancel motion. Preserve current copy, shapes, halo and text placement. Supersedes D51's forward-only 96px capture rule and its native-wheel/gesture-end ownership, which caused the missed 03 stop and two-stage pause. Scope: [physics](../web/src/philosophyScrollPhysics.ts), [input controller](../web/src/philosophyScroll.ts), [page integration](../web/src/ShapeLightPage.tsx) and [debug window](../web/src/PhilosophyScrollDebug.tsx).

Verification for D70: production build and 63 focused physics, input, sequence and text-motion tests passed. Tests cover all six minima from both sides, overshoot at 03, tiny departures, browser-rounded offsets, reversal, 30/60/120Hz consistency, long-frame bounds, native-policy exclusions and cleanup. Live wheel checks settled 04 → 03; debug seeking and the 03 contents link moved through intermediate scroll positions before resting. Tuning persisted through reload and was reset after testing; hide/reopen worked. No browser errors were reported.


### 2026-10-19 — D71 — Restore Halyard values; invert Film Output

**In code.** Remove the OCR-B font face and loader. Numeric controls, timecodes and debug readouts return to Halyard through the shared measurement token, keeping their current sizes and line heights. Remove the cover clock’s OCR-specific reserved width. The Film timeline’s Output action uses a light fill with dark text and icon, including a light hover state; retain its existing size, optical button padding and keyboard focus treatment.

Reason: the OCR trial did not fit the interface, and Output needs clearer emphasis as the Film section’s finishing action. Supersedes D69 and restores D05’s Halyard-only direction. Scope: shared type tokens/loading, landing clock and Film timeline styles.

Verification for D71: production build and diff whitespace checks passed. The browser confirmed Halyard loaded for numeric fields and timeline timecodes, and Output rendered with a light fill, dark text/icon, and unchanged 3px / 8px / 5px padding. Clicking it opened the existing Output settings inspector.


### 2026-10-19 — D72 — Shapes contract slightly during travel

**Initial trial; amount superseded by D74.** Apply an 8% uniform contraction at the midpoint of Form + Light’s inter-section morphs and ordinary page-to-page frame transitions. A symmetric quartic envelope returns to full scale with zero scale slope at each endpoint. Scale all anchors and handles together about the existing center after clearance fitting, preserving finished geometry, grid alignment, corners and reversibility. Identical route contours do not pulse.

Reason: give the changing silhouette more space before it settles into its finished composition. Use the real contour so clipping, halo, dotted guides, Glassine bounds and Pretext avoidance agree; no separate CSS transform or animation clock. Preserve landing hover, the curve catalog’s pure interpolation, and studio loading/expansion. Mobile and reduced-motion paths still resolve directly to their existing endpoints. Scope: [shared morph](../web/src/frameMorph.ts), [route driver](../web/src/DynamicFrame.tsx) and [philosophy sequence](../web/src/philosophySequence.ts).

Verification: production build and 127 focused morph, sequence, route, landing, loading and text-motion tests passed. Tests cover exact endpoints, 8% midpoint dimensions, unchanged centers, reversal, interruption, tangent continuity, padding and reduced-motion behavior. The browser was inspected at an intermediate Form + Light position with native scrolling to hold the contour still.


### 2026-10-19 — D73 — Live shrink control in the scroll study

**In code; default superseded by D74.** Add a shrink slider from 0–50% in 1% steps, defaulting to D72’s 8% contraction. The readout describes the maximum reduction at the midpoint; 0% disables contraction. Changing it redraws the current Form + Light contour, guides and text avoidance without moving the scroll position or restarting its controller. Finished shapes remain exact. The same saved setting controls subsequent ordinary page transitions. Reset restores 8% alongside the scroll defaults.

Reason: compare the contraction in the real composition rather than repeatedly changing code. Store the value locally, clamp invalid values, and retain mobile/reduced-motion behavior. Keep the new slider beside pull, damping and response; use two columns in the narrower debug window. Scope: [debug controls](../web/src/PhilosophyScrollDebug.tsx), [frame settings](../web/src/DynamicFrame.tsx), [sequence](../web/src/philosophySequence.ts) and [live invalidation](../web/src/ShapeLightPage.tsx). Extends D70 and D72.

Verification for D73: production build and 123 focused tests passed. Live browser checks changed the contour at a stationary 1,051px scroll position without moving it, verified 0% / 50% limits and 1% keyboard steps, restored the saved value after reload, and reset to 8%.


### 2026-10-19 — D74 — Set contraction to 30%

**In code.** Set the shared transition contraction default and debug reset to 30%, replacing the 8% trial in D72–D73. Keep the 0–50% slider, local persistence, exact endpoints, existing timing and the shared contour used for text and guides. Reason: Estelle selected 30% after the live control was added. Scope: shared morph default and scroll-study reset.

Verification for D74: production build and 107 morph, sequence and route checks passed. Set the browser’s saved shrink to 30% and confirmed it persisted after reload.


### 2026-10-19 — D75 — Native scroll and 30% shrink by default

**In code.** Start Form + Light in native scroll mode, with D74’s 30% midpoint shrink. Reset returns to that same pair. Keep the smooth physics mode available as an explicit debug choice and preserve saved settings. Reason: Estelle selected native scroll after comparing the two modes. Supersedes D70’s enabled-by-default physics; the real scroll position still drives the shape and text. Scope: scroll tuning defaults and the existing debug reset.

Verification for D75: production build and 36 scroll tests passed. Browser Reset selected native mode with 30% shrink; both persisted after reload.


### 2026-10-19 — D76 — Give the halo room at every shape size

**In code.** Size the shared SVG halo filter in viewport pixels from the contour’s true bounds, plus its stroke spread, four blur standard deviations and a 2px rasterization guard. Round the bounds outward. Reuse the bounds already calculated for the dotted guides; update the region with the contour and halo in the same paint.

Reason: percentage filter bounds contracted with the shape while the blur stayed the same pixel size, cutting the glow into a visible box around edge-on loader ovals and shrinking Form + Light shapes. Preserve the existing halo color, opacity, spread and softness. Keep the loader’s filter local to its small contour. Scope: shared frame renderer, halo bounds and guide bounds reuse.

Verification for D76: production build and 87 focused renderer, halo and loader tests passed. Checks include 81 loader poses, contracted Form + Light shapes across four viewport sizes, and halo changes without a contour change. The rebuilt browser rendered the contracted Form + Light midpoint without the local box cutoff; its SVG filter uses the new pixel bounds.


### 2026-10-19 — D77 — Movie duration, black gaps and image shots

**In code; black gaps, editable start times and independent empty duration superseded by D79; the separate Add image entry superseded by D135.** The Film timeline has an editable total duration in seconds, rounded to whole frames. `render.durationFrames` owns the movie clock; legacy scenes derive it from their last shot. Start times place clips explicitly. Trim and delete leave black time; insertion shifts following clips, while reordering retains the intervening gap. Reject overlaps and shortening the movie past existing clips, shared movement or keys. Preserve authored motion timing unless Stretch is chosen.

Show black intervals on the same timeline row as scene and image clips. The single playhead travels through occupied and empty intervals. Selecting a gap shows Black rather than another scene’s controls. Add image accepts PNG, JPEG and WebP from the local computer; it fills up to three seconds at the current gap, or appends after existing content. Image clips have a thumbnail, name, start, duration and Fit image / Fill frame. Image selection replaces object/camera controls with image controls; playback still keeps the editing selection stable.

Preview uses the existing viewport canvas and sampled film clock. Preload verified images, keep their sRGB colors with an unlit pass, and bypass 3D rendering during images and gaps. Export writes matching image/black frames before encoding the movie. Images are normalized and stored locally with content hashes, included in project revisions and export asset bundles. The native `.blend` preserves editable 3D, packed image assets and timeline metadata; final flat composition runs in the Film export worker. This is not a Blender video-sequencer reconstruction.

Reason: movie length and clip length are separate decisions; empty time must remain visible and predictable, and still images should belong to the same edit. Extends D64’s shared timeline and stable editing context. Scope: sequence model, Film timeline/clip inspector, shared viewport, image import, Python sampling and export.

Verification for D77: production build and 899 web tests passed; 369 Python tests completed with 14 opt-in skips. A real Blender export mixed black frames, an image hold and a 3D scene; image colors and black letterboxing matched the source. Browser checks extended a 10-second movie to 15 seconds, imported a three-second image into its gap, changed fit, rejected a duration that would cut existing content, and played through to the black final frame. The dock stayed 136px tall without horizontal page overflow. Test edits were undone rather than saved into the campaign.


### 2026-10-19 — D78 — Material actions belong to each name row

**In code.** Add a quiet three-dot trigger to the right of each library material’s name, separate from the swatch’s edit button. Its menu contains Rename, Duplicate, Attach objects and Delete. Rename focuses and selects the existing editor name field; Save commits it. Duplicate creates an independent, unassigned library copy and opens it for editing. Move the former editor-heading Duplicate action into this menu.

Unused materials delete immediately. Attached materials explain the surface change before confirmation: imported meshes return to their original or inherited finish; primitive objects use one visible Neutral fallback because they require a material. Preserve other section assignments. Delete the record and assignments together, using the existing undo history. Deleting an attached Neutral replaces it with another neutral record; it cannot leave a primitive without a surface.

Keep the menu above guides and outside sidebar clipping. Support arrows, Home/End, type-ahead, Escape, outside-click dismissal and focus restoration; preserve row editing, hover highlighting and object dragging. Use the existing Halyard type, colors, 4px spacing and 3px / 5px optical button padding. Reason: secondary actions should remain available beside their material without adding another row of controls. Scope: MaterialLibrary, MaterialAssignments, MaterialSwatches, MaterialPresetMenu and materialPresets.

Verification for D78: 41 focused material/panel tests passed. Browser checks exercised keyboard duplication, selected-text Rename, attaching a copy, attached and unused Delete, Escape focus restoration and Undo restoring the deleted material plus its attachment. Restored the campaign after testing. A code review caught same-preset Rename focusing a field below the scroll area; Rename now returns that editor to the top first.


### 2026-10-19 — D79 — Keep the film continuous

**In code.** Remove D77’s black gap UI and editable clip start controls. Shot order and duration define adjacent cuts. Trimming or deleting closes the space; insertion and duplication move subsequent shots; image shots insert after the selected scene. Keep the one playhead in the shot row and the compact dock.

The movie Duration control stretches all shots and their motion proportionally, rounded to frames, instead of adding empty time. Retime camera duration, shot motions, shared motions, mechanical actions and animation keys together. Preserve the selected shot and its relative editing position. Reject collapsed keys/motions or a trim that would cut off authored movement across shots, rather than silently discarding it.

Open older gap experiments as an undoable, unsaved continuous edit and show a notice; report timing collisions if conversion cannot succeed. Keep the backend’s legacy gap reader for existing files and exports. Reason: Estelle removed the black-gap direction while retaining image shots and editable movie duration. Scope: sequence timing, Film timeline/inspectors, shared Film edit commits, project loading and README.

Browser verification for D79: changed a ten-second movie with two five-second scenes to fifteen seconds; both became 7.5 seconds with adjacent boxes. Trimming the first to six seconds moved the next cut and reduced the total to 13.5 seconds. Restored the original campaign through Undo.

Final verification for D78–D79: production build and diff whitespace checks passed. All 99 focused Film checks passed. The full web run passed 906 tests with one loader timeout under parallel load; all seven loader tests passed when rerun alone. No browser console errors appeared during the material and Film checks.


### 2026-10-19 — D80 — Reorder scenes directly on the film

**In code.** Drag a scene body to a marked insertion point in the Film timeline. Commit once on release, keeping cuts contiguous and preserving scene durations, cameras, images and local motion. Keep the currently edited scene and its local time selected when another scene moves around it. Film-wide animation keeps its absolute timing. Each move uses the existing undo history.

Separate the gestures: scene bodies reorder; the time ruler scrubs the same film playhead; scene names remain editable; end handles trim. Require 6px of travel before treating a press as a drag. Cancel on Escape, pointer cancellation, window blur, resize or release outside the timeline. Scroll the timeline at its edges during a drag. Focused scene buttons also support left/right and Home/End, restore focus after the edit and announce the resulting position. During playback, scene clicks seek but reordering waits until paused.

Reason: scene order should be editable directly where the sequence is visible, without adding another lane or a separate ordering panel. Extends D79. Scope: sequence model, FilmShotStrip, FilmTimeline and timeline styles.

Verification: production build and 60 focused Film/model tests passed, including unequal durations, distant moves, images, invalid edits and undo/redo. Browser checks confirmed pointer reordering, keyboard reordering, preserved editing context and focus, destination announcements and Undo.


### 2026-10-19 — D81 — Keep panel identity above scrolling controls

**In code.** Keep New preset and its Cancel action outside the material-type scroll area. Apply the same structure to the Film target/Image inspector, new-scene titles and step navigation, and Import product heading. Controls scroll in their own body below the title; interior section labels stay with their controls. Preserve rail gutters, typography, existing fixed material sample and Save/Cancel footer.

Reason: the user should still see which panel they are editing after scrolling through its controls. Scope: MaterialLibrary and material-library.css, FilmWorkspace/FilmClipDetails/NewFrameFlow and film-shell.css, Product import in App and condensed-editor.css.

Verification: production build, 30 existing panel tests and diff whitespace checks passed. In a short browser window, New preset stayed at the same vertical position while its body scrolled 158px; Camera stayed fixed through 278px of inspector scrolling; Import product stayed fixed while its form scrolled. Cancel, reopening the chooser and selecting a material retained the existing behavior. New-scene layout was visually checked; its test scene was discarded, restoring the saved campaign.


### 2026-10-19 — D82 — Turn the material sample in place

**In code.** Drag inside the selected material sample to rotate its mesh. Use a grab hand at rest and a grabbing hand during the gesture. Replace the thin rectangle choice with a 40mm cube with slightly rounded edges; retain the sphere and quiet opacity-based icons at the top right. Rotation persists while switching shapes or adjusting the material, without modifying the product or saving preview orientation into the preset.

Hold the hover-driven light steady during a drag, then resume its pointer response. Arrow keys turn 5°, Shift turns 15°, and Home, native button activation or double-click resets orientation. Escape, pointer cancellation, focus loss and resize cancel an active turn. Reuse the existing demand-rendered canvas and materials; only the mesh quaternion changes. The sample remains fixed above scrolling controls, with the shape buttons above its rotation hit area.

Reason: inspect how a material behaves across faces and edges without moving the product or confusing object rotation with lighting movement. Extends D20 and supersedes its rectangle toggle. Scope: MaterialLibrary, MaterialSwatches, materialSampleRotation and material-library.css.

Verification: production build, 24 focused rotation/material/panel tests and diff whitespace checks passed. Browser checks confirmed pointer rotation, sphere/cube switching, keyboard rotation/reset, transparent keyboard focus and grab cursor. Rotation left the campaign saved and playback stopped. No browser console errors appeared.


### 2026-10-19 — D83 — Keep sample rotation tied to the gesture

**In code.** Derive each drag pose from its starting orientation and total pointer displacement, using a single rotation about a camera-plane axis. Pointer-event frequency must not change the result, and returning to the press position must restore the starting pose. Guard double-click reset when either press traveled more than 4px, so repeated drags cannot reset the cube. Keep pointer capture, keyboard controls and explicit cancellation.

Ease the selected sample's hover light back into position after release instead of moving the reflection abruptly. Hold it still during rotation and stop rendering once it settles. Preserve the existing material renderer, shape toggles, panel layout and transient preview state.

Reason: event-by-event Euler rotations accumulated different poses under different event rates, and a release could look like a jump from either accidental reset or lighting. Refines D82. Scope: MaterialSwatches, materialSampleControls and materialSampleRotation.

Verification: production build, TypeScript, 40 focused material/panel tests and diff whitespace checks passed. Regression tests cover event density, out-and-back motion, repeated drags, double-click intent, foreign pointers, cancellation, keyboard controls and teardown. Browser checks confirmed diagonal dragging, captured release outside the sample, reset and sphere/cube switching; preview rotation left the campaign saved.


### 2026-10-19 — D84 — Import Blender products through the existing scene pipeline

**In code.** Accept `.blend` alongside GLB in Product import and the `product-import` CLI. Use the configured local Blender 4.3.2 executable to snapshot the saved active scene and view layer at its saved frame, then validate and store a centered, meter-scale GLB through the same product pipeline. Preserve object names, parent relationships, material slots, UVs and supported packed artwork. Bake evaluated geometry and transforms; exclude cameras, lights and render-hidden geometry. This is a static product import, not an editable Blender project or animation import.

Show import progress with the existing viewport loading overlay. Pack textures before saving; unsupported procedural materials, linked resources, instances and simulation dependencies receive actionable preparation errors. Report unset units as an explicit one-unit-to-one-meter assumption. Store the source hash, scene/frame, unit conversion and conversion details with the product metadata. Run file scripts disabled, bound upload/conversion size and duration, and publish only validated output. Failures leave existing campaigns untouched.

Reason: accept a product designer's Blender file without requiring a separate GLB export, while keeping the real renderer, selection tree, material editing and export paths shared. Scope: Product importer/UI, local Blender converter, CLI, README and real-product workflow notes.

Verification: production build, 44 product/scene tests, 14 API tests and all 14 converter tests passed, including the real Blender cases. Checked saved-frame geometry and animated material values, millimeter normalization, hierarchy, evaluated modifiers, hidden collections, mirrored winding, packed artwork after deleting its external image, disabled file scripts and failure cleanup. Browser import displayed the fixture with its nested parts and measured 130 × 35 × 40 mm dimensions; existing user campaigns were untouched.


### 2026-10-19 — D85 — Convert simple Blender glass without baking its appearance

**In code.** Accept a Glass BSDF connected directly, or through reroutes, to the active material surface. Convert it in the isolated importer to a Principled transmission material: transmission 1, metallic 0, alpha 1, with the saved-frame color, roughness, IOR and supported tangent normal maps. Preserve shared material identity and packed textures. Resolve constant linked IOR and normal strength into numeric values because the pinned exporter otherwise drops those links. The original `.blend` remains unchanged.

Record the named conversion in import notices and metadata. This is a material-model approximation, not optical equivalence with Blender. Do not invent wall thickness; browser transmission does not reproduce nested glass/liquid ray tracing. Shader mixtures, volume absorption/scattering, varying IOR and unsupported normal inputs remain explicit errors instead of becoming silently opaque or losing their settings.

Reason: a perfume liquid using ordinary Glass BSDF was rejected by D84's Principled-only allowlist. Surface transmission and refraction cannot be retained by baking an image of their appearance. Refines D84's supported-material contract. Scope: scripts/import_blend_product.py, its real Blender tests and README.

Verification: the 18-case converter suite passed with Blender 4.3.2; three focused checks passed after the final normal-input guard, covering 20 unique cases in total. These include shared Glass surfaces, saved-frame roughness/IOR, packed color/normal maps, rerouted Value inputs, unchanged source hashes and explicit rejection of unsupported mixtures, volumes and varying inputs. A CLI product import succeeded; the app's installed Three GLTFLoader read its two LiquidPerfume meshes as MeshPhysicalMaterial with transmission 1, IOR 1.47, roughness 0.23 and opaque alpha. Syntax and whitespace checks passed. This validates conversion and material values, not a visual match to the user's unseen source scene.


### 2026-10-19 — D86 — Preserve masked surfaces and procedural finishes during import

**In code.** Normalize Mix Shader branches made from Principled and Glass surfaces into spatial PBR parameters, respecting the original factor and branch order. Require matching IOR rather than averaging two optical media. Constant endpoint factors discard only the mathematically unused branch. Bake unsupported linked surface inputs into separate 1024 px color, roughness, metallic, transmission, alpha and tangent normal maps with local Cycles; retain ordinary exportable image inputs. This stores surface properties, not scene lighting or a rendered view. Mixed reflectance remains a documented approximation.

Bake evaluated local geometry before normalizing its world transform. Preserve original UV references for artwork; generate a separate atlas when existing UVs overlap, degenerate or lie outside the usable range. Copy materials per object when object-dependent maps require it. Bound work to 48 images / 32 megapixels and the existing conversion timeout. Keep ray-dependent graphs, volumes, incompatible branches and varying IOR explicit errors. Record the map channels, object, source material, atlas and resolution in import metadata and notices. The source `.blend` is never saved.

Handle a legacy curve's dependency-graph self-entry without treating it as a real instance; genuine instances still require realization. Cache evaluated transforms/material IDs before scene switches and reacquire UV handles after atlas creation to avoid invalid Blender data references during baking.

Reason: the supplied perfume bottle uses an image mask to separate printed detail from glass, another mask for its label, and procedural finishes on its cap and cord. Removing the Mix Shader error alone would lose those regions or expose the next unsupported material. Supersedes D84/D85's blanket rejection of shader mixtures and procedural surface inputs for these supported cases. Scope: Blender importer, blend_material_mix, blend_material_bake, native import tests and README.

Verification: the full 22-case converter suite and a genuine-instance safeguard passed (23 unique cases). Pixel tests verify correlated masked color/transmission/roughness and gold/dark label regions, plus non-flat procedural roughness and tangent normals. The exact user-supplied bottle completed import: 12 meshes, 17 generated maps, 12.68 MiB GLB, unchanged source hash. The local editor displayed the bottle, printed detail and label without console errors in an isolated campaign. Syntax and whitespace checks passed. This verifies the import and browser presentation; it does not claim optical equivalence with the source Cycles scene.


### 2026-10-20 — D87 — Import the product without its studio setup

**In code.** Before material validation, baking or dimension measurement, exclude Blender cameras/lights/helpers and conservatively identified scene surfaces. Automatic ground/backdrop removal requires a named planar surface, scale separation and a plane outside the product. A lighting card must be named, planar, emissive and separated from the product. Shared product ancestry protects flat and emissive parts. Unknown geometry stays. Only inspect geometry when a plausible setup name exists; cap that inspection at two million vertices and fall back to explicit roles above the budget.

Use the string custom property `gesso_role=product` or `gesso_role=environment` on objects or collections for other files. The nearest object/parent tag wins over collection roles; conflicting collection memberships favor product. A product child can override an environment parent. Bypass excluded ancestors while preserving world-space geometry and the remaining hierarchy. Scope material, library and instance checks to retained content so unrelated setup does not block import. Retain actionable errors for unsupported product content.

Report excluded names in the import notice and reasons in bounded metadata. Keep the source file unchanged; do not silently rewrite existing campaigns. Reimport to apply the new extraction. Reason: the supplied perfume file contains a large Ground plane and an emissive FillLight mesh that were previously measured as product parts. Refines D84's snapshot boundary. Scope: blend_scene_filter, Blender converter, native import tests and README.

Verification: all 26 native Blender import tests passed, including scene-plane exclusion, preserved labels/base/screen/unknown planes, explicit overrides, unsupported environment materials and particles, excluded-ancestor bypass and unchanged source hashes. The supplied bottle imports as 10 product meshes with all 17 generated maps; Ground, FillLight and Camera are excluded. The resulting GLB is 12.67 MiB. Original material conversion limits still apply.

Pre-push checks: 944 web tests passed with two workers; the default highly parallel run had timed out in two exhaustive geometry tests. The Python suite ran 397 tests with 31 optional integrations skipped, and the native import suite ran separately. Production build, nine capture-script tests and whitespace checks passed. Compared all retained bottle triangles against the prior conversion: geometry is unchanged apart from recentering and float rounding. Also fixed empty legacy Film recovery and publishing the updated movie duration when creating a scene.

### 2026-10-20 — D88 — Edit a light preview; render a still on demand

The Blender-backed viewport still below is superseded by D89. Its preview pixel budget and resource-lifetime fixes remain.

**In code.** Bound the live editor to one pixel per CSS pixel, at most 1280 pixels on its longest edge and 921,600 pixels total. Preview shadows use 512px maps. Resize owned imported bitmap textures sequentially to a 2048px longest edge before publishing the browser scene; retain original files for Blender and capture. Product and Material defer imported room meshes and splats until World or Film needs them; the product's lighting stays available. Empty/hidden material swatches do not initialize WebGL. Preserve one presentation-camera identity so Three's transmission buffers are reused across frames.

Put **Render still** at the viewport's top right. It sends an immutable snapshot of the current camera and film frame to the existing local Blender queue, renders a PNG with a 2048px long edge and 64 samples, and displays that image in the same window. Pause live drawing while the still is displayed. **Back to preview** resumes editing; changing the scene, workspace, frame or inspection angle invalidates pending stills. Keep cancel, failure and retry states visible. Resolve material/transform drafts first; comparison and image clips retain their existing export flows.

Reason: editing should not require continuously paying for output quality. A still uses the real scene renderer outside the browser, while the original model, textures, film cameras and export settings remain unchanged. Product/Material stills use a white inspection stage; a physically rendered image can differ from the WebGL approximation.

Scope: browser resource lifetime, preview resolution, viewport still workflow and temporary render snapshots. Sources: `viewport.ts`, `previewResolution.ts`, `previewTextures.ts`, `MaterialSwatches.tsx`, `ViewportStillOverlay.tsx`, `viewportStill.ts`, `film/scene.py`, `scripts/blender_scene.py`.

Verification: a real-browser transmission check reproduced texture growth from 1 to 12 over 12 camera clones. Reusing the camera held texture counts steady across 120 frames of both the lamp and glass bottle. The lamp check also confirmed that Product/Material did not load the hidden 104.8 MiB room.

Validation: the web suite covered 1,000 tests (995 passed in the full run; the four stale fixture expectations and one added buffer-budget case passed in the focused rerun). All 44 Python scene/lighting/still tests passed. Production build and whitespace checks passed. In the live app, a 2048 × 1932 lamp still completed, decoded in place, and returned to the preview; opening World then loaded and displayed the room successfully.

### 2026-10-20 — D89 — A viewport still is one high-resolution viewport frame

Use the same live WebGL renderer, scene, camera, materials and optical preview for **Render still**. Draw once at a 2048px longest edge, copy the pixels before clearing the buffer, then restore the low-resolution buffer and release temporary resources. Display a decoded local PNG in place; pause drawing while it is visible. **Back to preview** resumes the live view. Material drafts and hidden parts remain visible exactly as they are being edited. No render queue, polling, second WebGL context or asset reload.

Reason: D88 sent an inspection image through CPU Cycles; the lamp test took four minutes and changed the appearance from the browser draft. The viewport button should inspect the current work at a higher pixel resolution. **Export** remains the separate physically rendered output path, using original assets and its existing settings. The inline still retains the loaded preview textures and shadow quality; it does not claim Cycles equivalence.

Only one capture runs at a time. Wait for a complete scene/material frame; cancel stale captures when the view changes. Restore the preview on abort or failure, retain retry and cancel actions, and revoke temporary image URLs when leaving the still. Scope: `viewport.ts`, `ViewportStillOverlay.tsx`, `App.tsx`, and their focused tests. Removed the unused temporary Blender-stage/request path introduced by D88.

Verification: 140 focused viewport/capture and overlay tests passed, including cancellation, stale scene/material changes, restored buffer budgets and image URL cleanup. Production build and whitespace checks passed. In the live browser, the lamp still appeared in 427 ms in Material and 402 ms in World, including the UI handoff; these are individual measurements, not a latency guarantee. The World PNG measured 1784 × 2048 while the live canvas returned to 610 × 700. Navigation cleared the still and restored editing, with no new Blender render job. Hidden viewport controls are inert while the still is shown.


### 2026-10-20 — D90 — One bottle, one label asset, one sampled part pose

**In code.** Derive imported part identities, parent relationships, bounds and source matrices from the verified GLB. Store editable motion separately from those immutable source transforms. Apply a parent-space move/rotation/scale around the measured center or an explicit pivot. Film controls, camera targets, custom keys and G/R/S use the same stable IDs and saved names. Physical source children inherit motion; editorial tree grouping does not change the mechanics. No joints are inferred.

Replace label artwork on one selected source mesh using its original UV0. Default to **Plain label**, removing old color and printed finish maps only on that surface. Offer **Keep original finish** and **Restore original artwork**. Decode uploaded PNG/JPEG/WebP locally, normalize profile/orientation once, and save a bounded hash-addressed PNG. Rasterize new decal text once using the packaged Studio Sans face. Save and bundle that same image for browser and Blender. Existing legacy text stays compatible until explicitly reapplied.

Both renderers consume the same sampled node matrices. Blender keeps a separate motion parent so multiplying a delta by a nonuniform source transform does not lose shear. Split projected decals by their actual source mesh so independently moving descendants retain their artwork. Address UV0 explicitly for new artwork without disturbing baked original finish maps on UV1. Keep shared sibling materials intact and dispose replaced GPU resources only when no live surface uses them. Delay focus translucency until canonical artwork is installed.

Reason: make one real bottle workflow reliable before adding another editing model. Preserve the current Halyard/grid interface, original product files and low-resolution browser budget. Consistency means the same parts, pixels, UVs, pivots and timing; browser optical shading still differs from Cycles. Unsupported or missing UVs remain an explicit limit.

Verification: focused API checks cover image import, recovery, save/reopen and asset bundling. Native Blender checks reopen the exported scene and compare parent/child matrices, packed image hashes, UV0/UV1 bindings, unmodified siblings and restoration. Final checks: 1,032 web tests passed; 418 backend tests ran with 35 optional integrations skipped. Nine native Blender tests passed separately. The actual filtered perfume bottle also reopened with all ten source-node matrices matching across three frames (maximum error 4.23e-7), and exact packed Sticker artwork. A rendered four-quadrant image confirms orientation. Production build and whitespace checks passed. Live browser checks passed in a separate QA campaign: Sticker image upload, finish switching, save/reopen, restore/undo, and independent Cap movement in Film. The local video exporter currently reports FFmpeg 7.1.5 missing; native Blender parity remains verified.


### 2026-10-20 — D91 — A fixed part inspector beneath the tree

**Partially superseded by D121:** keep the fixed identity block; remove the optional Organize and File details views.

**In code at the time.** Keep the selected **Object** name, measured dimensions and **Parent** in one stable area beneath the independently scrolling Product tree. Opening **Organize…** or **File details…** reveals optional controls below that identity block, with its own scrolling region. Organize contains parent editing, fixture grouping and source-hierarchy recovery; File details retains original names, parents, node paths and material evidence, and switches the tree to its explicitly labelled source view. Keep the selected alias visible while inspecting the file.

Reason: implement the selected Fixed inspector comparison without moving details into individual tree rows or replacing the name and dimensions when an action opens. Editorial grouping changes the list, not motion; state this beside the parent control. Preserve D16’s **Part details / Parent / Object** labels, Halyard/grid styles, current part identities, renaming and visibility. Do not restore the removed Product **Show assembly / Frame** buttons. Cancel, successful parent changes and Escape return focus to the disclosure control; closed content is hidden and inert. Existing cabinet transitions remain, with reduced-motion and mobile fallbacks.

Scope: [ProductPanel](../web/src/ProductPanel.tsx), [condensed editor styles](../web/src/condensed-editor.css), and [panel tests](../web/src/ProductPanel.test.tsx). The hierarchy and renderer are unchanged. A recoverable pre-change copy is saved in the task workspace under `work/gesso/inspector-baseline`.

Verification: 40 focused panel, hierarchy and disclosure tests passed, covering saved aliases, source metadata, closed controls, preserved recovery and existing Material/Film boundaries. Live browser checks passed for F2 renaming, source metadata with the alias retained, parent apply/recovery, and Escape focus return. The name field stayed at the same measured vertical position when opening disclosures and when selecting the final node in the 39-part lamp tree. Optional details scroll below the fixed identity block.


### 2026-10-20 — D92 — Compose a pattern in the curve demo

**In code.** Keep the 16-shape catalog and production 64-anchor renderer. Replace the A/B picker with an ordered pattern along the bottom of `/curves`. Catalog clicks append a shape; selecting a numbered step exposes Replace, Duplicate, Remove and earlier/later controls. Drag steps to reorder, or use Alt + arrow keys. Repeated entries hold their shape. Keep at least one entry and bound the pattern to 64 steps.

Each adjacent pair uses the shared `createFrameTransition` with 30% midpoint contraction and eased timing: full size at each shape, 70% at the midpoint. Precompile transitions when the pattern changes; update the SVG, guides, playhead and readouts on one animation clock. Loop adds a visible return step and a real last-to-first morph. Playback pauses when hidden; compact screens and reduced motion retain scrubbing without autoplay. Existing endpoint/anchor inspection and SVG export remain available.

Store the ordered IDs, progress, transition duration and loop setting in the URL. Migrate old `a` / `b` links and retired preset aliases. Editing pauses playback, preserves step identity through reordering, and keeps newly added steps visible. A restored endpoint selects the visible step; leaving Loop at its completed return keeps the first shape in view.

Reason: inspect a repeatable sequence of shapes with the same size change as the live frame, rather than testing isolated pairs with different motion. Supersedes D47’s pair-only interaction and applies D74’s contraction to the demo. Scope: [CurveDemo](../web/src/CurveDemo.tsx), [pattern model](../web/src/curvePattern.ts), [styles](../web/src/curve-demo.css), and [pattern tests](../web/src/curvePattern.test.ts).

Verification: 65 focused pattern, catalog, geometry and morph tests passed, including exact endpoints, 70% midpoint bounds, duplicate holds, URL recovery, reverse playback and the loop seam. Production build passed. Browser checks covered adding, replacement/cancel, duplicate/remove, drag and keyboard reorder, loop return, playback and saved URL state.


### 2026-10-21 — D93 — Imported products start on the world's floor

**In code.** New product campaigns keep the explicit contact plinth as the deterministic support surface but create it with `visible: false`. The product therefore sits at the world's ground level (Y 0) and the white platform appears only when the user shows it from World → Objects. Existing campaigns and the MORA fixture are unchanged.

Reason: with a generated world under the product, the default porcelain block read as "a random white platform" rather than a staging choice. Scope: `film/products.py` prepared-scene defaults; the plinth schema, evaluation and the Show plinth control are untouched. Verification: `tests.test_products`, `tests.test_scene` and `tests.test_renderer_bundle` pass (48 tests); six Khronos sample imports open with the product on the floor.


### 2026-10-21 — D94 — Generated worlds: splat plus free collider and panorama, no paid mesh

**In code.** `scripts/worldlabs_generate.py` creates one world from a local inspiration photo and text prompt (1,580 credits), polls it, downloads the 500k SPZ, the provider's collider GLB and the equirectangular panorama, and imports the splat into the local library with the provider's metric scale and ground offset. The collider and panorama stay beside the provider state for the renderer and lighting. The 3,500-credit HQ mesh export is not requested. `scripts/pano_to_hdr.py` turns the LDR panorama into a Radiance HDRI (highlight expansion, 2048 × 1024) that the existing `lighting.hdri` path accepts, so glass and metal reflect the world's own palette.

Reason: the demo budget is 7,000 credits for four environments; the free assets cover placement and lighting, and the splat already provides the look in the browser and the camera-matched plate in Cycles. Scope: generation and lighting scripts; the schema, importer and server are unchanged. Verification: the Velvet jewel-box world imported with scale 1.250 and ground 1.081; the HDRI passes `validate_hdri`; balance 7,000 → 5,420.


### 2026-10-21 — D95 — Gaussian worlds receive the product's contact shadow

**In code.** For `splat` environments the Blender adapter adds an invisible Cycles shadow catcher plane at the support height (the plinth top). It is excluded from glossy and transmission rays and only writes shadow alpha, which the existing transparent-film AlphaOver compositor darkens over the camera-matched plate. The limitation text no longer claims the plate has no shadow equivalence.

Reason: without geometry under the product, films in generated worlds showed the product floating over the plate. Scope: `scripts/blender_scene.py` `environment()`; mesh and authored worlds are unchanged, and the plate still provides no occlusion. Verification: adapter compiles; a Metal still of the MORA fixture renders; splat-world verification follows with the first showcase loop.


### 2026-10-21 — D96 — Render acceleration is an opt-in environment choice

**In code.** `GESSO_CYCLES_DEVICE=METAL` switches Cycles to the Metal GPU and `GESSO_CYCLES_DENOISE=1` enables OpenImageDenoise; both are read inside the Blender adapter and recorded in `render-config.json` (`device`, `denoising`). The pinned CPU, no-denoise profile remains the reference and the default. `scripts/dev-serve.sh` starts the local server with the pinned Blender 4.3.2 and FFmpeg 7.1.5 paths, keychain secrets and these flags.

Reason: the demo loops need hundreds of frames in hours, not days; a 960 × 540 Metal still with 64 samples completed in four seconds after a one-time 55-second kernel compile. Scope: adapter configuration and the launcher script; job profiles, digests and tests are unchanged. Verification: `render-config.json` reports `"device": "GPU"`, `"denoising": true` for the test still.


### 2026-10-21 — D97 — Generated worlds enter the studio as meshes

**In code; refines D94.** The studio keeps the product and its world as meshes so they occupy one space: the product rests on world geometry, casts shadows onto it and is occluded by it in both the browser and Cycles. `scripts/collider_world.py` wraps the provider's free collider GLB, which already carries per-vertex colours and normals, in a `KHR_materials_unlit` vertex-colour material and imports it as a `mesh` world with the same metric alignment as the splat. `tools/render/surface_probe.py` (video project) reads the same geometry to find pedestal and floor heights for placement. The splat entry stays in the library for comparison only; the paid HQ textured mesh (3,500 credits) can replace the collider mesh when credits allow.

Reason: the user's correction that models and environments must interact; a camera-matched splat plate cannot occlude, reflect or receive the product. Scope: world import scripts and the demo matrix; the schema, viewport and Blender mesh path are unchanged. Verification: three worlds (Velvet jewel-box, Flooded marble hall, Brutalist atrium) imported as meshes; the watch sits on the velvet pedestal at 0.53 m in the browser with the drapes behind it.


### 2026-10-21 — D98 — Films carry a soundtrack

**In code.** A scene may carry one soundtrack as an optional top-level `scene.audio` record: a content-addressed MP3, WAV or M4A asset, `offsetS` (−600…600), `gain` (0…4), an optional `bpm` (30…300) and the measured `durationS`. Validation only: documents without sound stay byte-identical and keep their digest, and `evaluate()` output is unchanged. The server accepts uploads at `POST /api/audio/import` with the same local-origin checks as image shots, recognizes the container from its leading bytes, caps files at 64 MiB, measures the duration once with `ffprobe` (found beside the configured `ffmpeg`, otherwise on `PATH`), stores the bytes unchanged under their SHA-256 and streams them from `/api/assets/<sha>.<ext>` with an audio content type. Asset verification and render bundling treat the soundtrack like HDRIs and image shots, so a job directory is self-contained.

In the Film workspace, Output gains a Sound section with the shared Halyard section label and dotted rule: Add sound…, then Tempo, Offset, Gain, Replace sound and Remove sound. Edits go through the same scene-edit commit as other panels, validated on a draft first so an out-of-range value never enters the history. Offset is the film time where the sound starts; negative values trim its beginning. While the film plays, one audio element is created per attached asset and becomes the master clock as soon as it is audibly running — the frame clock only fills in before the sound starts, while it buffers and after it ends — so picture stays locked to sound. Gain previews up to unity. A tempo draws bar ticks every four beats and lighter beat ticks across the timeline ruler, anchored at the soundtrack offset, in the existing hairline style. MP4 exports mux AAC 192 kb/s and ProRes exports mux 16-bit PCM, with `-itsoffset` / `-ss` placing the file, `volume=` applying the gain, silence padding so the picture keeps its length, and `-shortest` ending at the last frame. PNG sequences, stills, artifact names and the no-audio ffmpeg command are unchanged.

Reason: a product film is cut to music; the edit needs the actual track under the playhead, its beat grid on the ruler and the same track in the delivered file, without a second asset path or timeline model. Scope: [film/audio.py](../film/audio.py), [scene validation](../film/scene.py), [server routes](../film/server.py), [asset bundling](../film/worlds.py), [export muxing](../film/jobs.py), [FilmPanel](../web/src/FilmPanel.tsx), [filmAudio](../web/src/filmAudio.ts), [useFilmAudio](../web/src/useFilmAudio.ts), [beatGrid](../web/src/beatGrid.ts), [FilmTimeline](../web/src/FilmTimeline.tsx) and README.

Verification for D98: 969 web tests passed across 81 files, including new beat-grid, Sound-section and ruler-tick tests; production build passed. The Python suite ran 410 tests with 26 optional skips; the new audio module covers validation, byte sniffing, ffprobe discovery, a real ffprobe measurement, bundling and the HTTP import, and `tests/test_jobs.py` asserts the exact ffmpeg commands with and without a soundtrack, for ProRes and for PNG sequences. One pre-existing failure, `test_renderer_bundle`, comes from the renderer-helper change in 9d6917b and is unrelated. Against the running local server, a generated 10-second 440 Hz click file imported with `durationS: 10.0`, streamed back byte-identical as `audio/wav`, and a junk upload was rejected with 400. The exact export arguments muxed that track into a 120-frame test film with ffmpeg 7.1.5 for both MP4 (h264 + aac) and ProRes (prores + pcm_s16le), each keeping the 5-second picture length.


### 2026-10-21 — D99 — About shows what the studio made

**In code.** About gains a "Made with gesso" row between the four steps and the endnote: a two-up grid of short loops rendered by Gesso from the sample products in generated rooms, each with the product, the room and the model credit. Loops are muted, preload nothing, play only while on screen and stay as posters under reduced motion. Media lives outside the repository in `web/public/media/gallery/<slug>.{mp4,jpg}`.

Reason: the page described the four steps but never showed an output; the loops are the evidence that one setup works across rooms. Scope: [AboutPage](../web/src/AboutPage.tsx), [productDescription](../web/src/productDescription.ts) and [About styles](../web/src/about.css); the grid, type roles and endnote are unchanged (D40). Verification: TypeScript build passes; browser check follows once the loops are rendered.


### 2026-10-21 — D101 — Gaussian worlds keep their collider for contact, shadow and occlusion

**In code; refines D97.** A `splat` world entry may carry `environment.collider` (a mesh asset record aligned like the splat). Cycles imports it invisibly as a shadow catcher and holdout, so the product casts its shadow onto the room and is cut out where room geometry stands in front of it, while the camera-matched Gaussian plate supplies the look. The browser loads the same collider as a shadow-receiving `ShadowMaterial` beneath the splat. Renders bundle the collider with the world asset.

Reason: the user judged the vertex-coloured collider too blurry as the visible room, but still requires the product and room to interact. The splat is the photoreal representation the provider ships; the collider is its geometry. Scope: scene validation, asset bundling, the Blender splat branch, the viewport splat loader and the three generated world entries; mesh worlds and the plane fallback are unchanged. Verification: scene, worlds and renderer-bundle suites pass; a watch draft in the velvet splat room is rendering for review.


### 2026-10-21 — D102 — Form + light shows the studio's own films inside the opening

**Superseded for Form + Light by D115.** The original decision below records the earlier film treatment.

**In code.** After the glassine cover, each principle chapter fills the shared window with a loop rendered by Gesso (watch, stained-glass lamp, sunglasses, candle holder, barn lamp), positioned to the live contour bounds like the glassine still and switched by the scroll sequence stage. Loops are muted, preload only metadata, play only while their stage is current on wide layouts, and the glassine canvas keeps the cover. Media comes from the same `public/media/gallery` loops as About (D99).

Reason: the user asked that the opening show what the tool makes, not a grey specimen. Scope: [GlassineStudy](../web/src/GlassineStudy.tsx) and [Form + light styles](../web/src/shape-light.css); shapes, text flow and scroll behaviour are unchanged. Verification: production build; a browser scroll to chapter 02 showed the sunglasses loop playing inside the arch with the glassine hidden.
### 2026-10-21 — D100 — Spot and ambient light with motion

**In code.** A studio light may declare `type: "spot"` (absent means the original area disk) with `coneDeg` (1–170, handoff default 40) and `blend` (0–1, default .3); the lighting block may carry an optional `ambientColor` next to `ambientStrength`. Validation only checks fields that are present and never inserts defaults, so saved rigs and `examples/bottle.scene.json` stay byte-identical. In Cycles a spot is `bpy.data.lights.new(..., "SPOT")` with `spot_size`, `spot_blend`, `energy = powerW` and `shadow_soft_size = diameterM / 2`, aimed with the same track quaternion as the area disk; an ambient colour reaches every non-camera ray through a Light Path mix while the camera keeps the world colour. In the browser a spot is a shadow-casting `THREE.SpotLight` (2048² map, bias −0.0002, near/far fitted to the aim distance) whose intensity is `powerW / 4π`: Cycles specifies a spot's watts like a point light's (the cone masks, it does not concentrate) and Three's `SpotLight.power` uses the same lumens-to-candela convention, so the spot sits on the same scale as the area lights' watts-per-steradian.

Lights are Film motion targets addressed as `$light:<id>`: `orbit` (Y axis, degrees around the light's own aim point, the camera orbit math), `move` (metres along an axis) and the new `aim` kind (moves the aim point). A light must exist in the saved rig and be enabled; animating the implicit legacy rig persists it first. The composition is order-independent (orbit of the authored offset, then aim and move offsets), an orbit owns the whole position while moves and aims own one axis each, and a light orbit never triggers the camera distance rule. Only scenes with at least one enabled light motion add `"lights": [{id, positionM, targetM}]` to every evaluated sample; the Blender adapter keys each tagged light's location and tracking rotation from those samples with the same constant interpolation as the camera, and the viewport moves the matching Three light and its target per frame. World → Lighting gains Add light ▾ (Area / Spot), Remove light, a Type selector, Cone and Blend for spots, an Ambient value (practical 0–3) with an optional ambient colour, and a one-click "Dramatic spot" preset (ambient .15, one warm 35° spot above-front of the product, small emitter for a hard shadow) beside Reset studio rig. The Film rail lists enabled lights after Parts under "Lights", the new-scene object step offers them with Orbit / Move / Aim (defaults 60°, 100 mm, 50 mm, the whole shot, ease), and a selected light exposes its base Position and Aim.

Reason: the user asked for an adjustable ambient and spot light with movement for dramatic effect, in the register of luxury launch films: a dark field, one hard spot sweeping the product and a strong contact shadow. Scope: [film/scene.py](../film/scene.py) lighting validation, motion validation and `evaluate`; [scripts/blender_scene.py](../scripts/blender_scene.py) `spot_light`, `environment`, `configure_scene` and `animate`; [viewport](../web/src/viewport.ts); [world](../web/src/world.ts), [WorldPanel](../web/src/WorldPanel.tsx), [filmMotion](../web/src/filmMotion.ts), [FilmWorkspace](../web/src/FilmWorkspace.tsx), [NewFrameFlow](../web/src/NewFrameFlow.tsx), [frameSetup](../web/src/frameSetup.ts) and a small [FilmLightPose](../web/src/FilmLightPose.tsx) rail panel. Area lights, the HDRI path and the legacy rig are unchanged.

Verification: `tests.test_scene`, `tests.test_lighting`, `tests.test_film_motions`, `tests.test_keyframes` and `tests.test_renderer_bundle` pass (93 tests, 10 new: spot and ambient validation, light motion rejections, orbit/move/aim evaluation, samples that gain `lights` only with a light motion, the AST-driven Blender handoff of cone, blend, radius and scene ID), including the byte-identical legacy digest. The web build passes and the touched suites pass (141 tests, 11 new, including a prototype-built viewport with a spot that moves from sampled poses). A Cycles still of the chronograph watch with the Dramatic-spot rig and a 90° orbit (Metal, denoised, 640 × 360, 32 samples) shows a hard contact shadow on the plinth, and frames 1 and 60 show the pool and shadow swept across the surface.


### 2026-10-21 — D103 — The authored studio is a colour field

**In code.** The authored studio's curved sweep takes the scene's `worldColor` in both the browser and Cycles instead of a fixed grey-green, so a campaign can sit in a saturated colour field lit by a coloured ambient (D100) and a hard spot. The default studio keeps its former look because the fixture's world colour is the same grey-green.

Reason: the user asked for surreal colour backgrounds alongside real rooms, in the manner of luxury launch films and the "infinity" teaser trend. Scope: `scripts/blender_scene.py` sweep material and `web/src/viewport.ts` `makeStudio`; no schema change. Verification: Leica and teapot campaigns saved in deep-blue and burnt-orange fields; renders follow with the spot-lit loops.

### 2026-10-21 — D104 — The showcase is five products, one setting each

**Form + Light media superseded by D115; the About gallery remains as described below.**

**In code.** The About gallery (`PRODUCT_GALLERY`) and the Form + light loops show only the five Blendswap products — the chronograph in the velvet jewel-box, the Ambre bottle in the brutalist atrium, the Sasha ring in the flooded marble hall, the rangefinder camera in a blue field, the Theo teapot in an orange field — rather than the earlier mix of eleven. No product repeats a setting, so the row reads as five different films instead of variations on three rooms.

Reason: the user asked for the five models they supplied, each in a different environment, and judged the Khronos sample set redundant once a real chronograph was in. Scope: `web/src/productDescription.ts` (list and note), gallery media under `web/public/media/gallery/`; the Khronos campaigns stay in the workspace but are not shown. Verification: `npm run build --prefix web`; the About row renders five tiles with their credits; Form + light stages 1–5 play the same five loops.


The following four entries retain their original dates. Their IDs were renumbered during branch integration because D93–D96 were also used on the teammate branch.

### 2026-10-20 — D105 — Keep curve handles consistent with the moving edge

**In code.** Rectangle → star and star → plus revealed small scallops between the intended corners. Moving anchors while independently blending handle angles and lengths created extra changes of curvature. For contours sampled on matching radial rays, recover each tangent's angular derivative, interpolate that derivative, then restore the interpolated handle shortening. Check correspondence before using this path; semantic windows and other freeform contours retain their existing interpolation.

Reason: fix the contour itself without hiding the problem behind timing or a circle detour. Keep all 64 anchors, exact finished shapes, reverse playback, and the 30% midpoint contraction. The ray origin comes from intersecting opposite rays, so asymmetric polygons do not acquire a false center. Scope: [shared morph](../web/src/frameMorph.ts) and [regressions](../web/src/frameMorph.test.ts).

Verification: 69 focused tests passed, including all 256 ordered catalog pairs, curvature-reversal limits for both reported transitions, endpoint continuity, reverse symmetry and 70% midpoint bounds. Production build and whitespace checks passed. Browser inspection covered the intermediate contours and reverse playback in the five-shape pattern; no console errors were reported. A recoverable baseline remains in the task workspace under `work/gesso/morph-baseline`.

### 2026-10-20 — D106 — Compare whole-contour interpolation before changing the live frame

**Experimental comparison, not a replacement.** Add `/curves?compare=1` for rectangle → star and star → plus. Show the current production morph beside two alternatives: a blended signed-distance field and blended radial distances. Both alternatives receive the same intermediate-only angular smoothing. They retain exact endpoint curves and use the same timing, 64-anchor output, coordinate scale and separate 30% size envelope. There is no landmark correspondence solver in this experiment. Intermediate areas may differ; they are not secretly normalized to match.

Flatten the actual authored Béziers for the distance fields, recover their blended zero contour on 64 rays, and reconstruct a cubic outline. The 0.08-unit flattening tolerance is not a guarantee on the final 64-anchor fit. Precompute 33 states per pair, interpolate them with shared temporal derivatives, and restore authored endpoint handles smoothly. All three views use one animation clock; checkpoints at 0 / 25 / 50 / 75 / 100% are inspection controls, not pauses along the path. Cache the two compiled pairs and leave the production renderer untouched.

Keep the Halyard/editor chrome, two-pair rail, equal specimen windows and fixed playback dock. Select a method to inspect it larger. Include endpoint and anchor guides, forward/reverse playback, optional back-and-forth repeat, keyboard scrubbing, and URL recovery. Mobile and reduced-motion preferences retain scrubbing with playback disabled. Return to the original pattern and position through the Pattern link.

Reason: D105 reduced small handle ripples, but did not decide how source features should disappear as destination features emerge. Compare a whole-outline rule against the lighter radial alternative before choosing a new shared motion model. Scope: [comparison UI](../web/src/CurveComparisonDemo.tsx), [experimental geometry](../web/src/curveComparison.ts), [tests](../web/src/curveComparison.test.ts), and the curve-study entry link.

Verification: 80 focused geometry, pattern and comparison tests passed, including endpoint identity and continuity, finite non-crossing samples, symmetry, reverse paths, 70% midpoint bounds and continuous checkpoint velocity. Production build passed. Browser inspection confirmed distinct intermediate contours, identical endpoint SVG paths, forward/reverse playback and fixed shared progress. A recoverable UI/renderer baseline is in the task workspace under `work/gesso/comparison-baseline`.

### 2026-10-20 — D107 — Give each comparison frame a controllable surface

Superseded by D108 after Estelle clarified that the effect belongs to the object itself. The image overlay implementation was removed; the recoverable baseline remains in the task workspace.

**Experimental study.** Place the existing leveled Nessino scene render inside each live comparison contour. Each frame owns Clear, Translucent, or Burned mesh settings. The selected frame's rail exposes surface opacity, opening, and cell size; Reset clears that frame, while Apply to all frames restores a controlled comparison. Keep the 64-anchor paths, common clock, exact endpoints, and 30% midpoint contraction. Product toggles the image and original silhouette; editing a surface brings its image back. Save independent settings in the URL with bounded recovery from malformed values.

Reason: inspect how a surface obscures and reveals the product while its boundary changes. Estelle specified a translucent perforated surface with singed edges, rather than the product's 3D wireframe. This is an image-layer study, not a reconstruction of hidden product geometry or a new editor material. The shared photograph/crop stays fixed so content changes do not obscure the morph comparison.

Use one existing image asset, native SVG clipping, static diffusion, and deterministic tiled openings with thin, dark edges. No new WebGL contexts, video decoders, or animation loops. Zero opacity returns the clean image. Decode before showing it; retain silhouette and Retry if loading fails. Keep native keyboard sliders, pause morph playback while adjusting a value, and preserve the existing compact-screen / reduced-motion policy.

Scope: [comparison](../web/src/CurveComparisonDemo.tsx), the former `curveSurface.ts`, `CurveSurfaceLayer.tsx`, and their focused tests. Existing render credit remains in the asset manifest. A recoverable baseline is in the task workspace under `work/gesso/effects-baseline`.

Verification: 87 focused surface, geometry, comparison, and pattern tests passed; the 18 surface/comparison checks passed again after the membrane refinement. Production build passed. Browser checks covered mouse/keyboard sliders, zero-opacity recovery, independent treatments, Apply to all, per-frame Reset, reload recovery, playback, and identical endpoint contours. No console errors were reported.

### 2026-10-20 — D108 — Reveal the product's own mesh

Replace D107's perforated image overlay with the actual Nessino geometry. Each comparison frame has Solid, Translucent and Wireframe views, with independent object opacity, edge opacity and back-edge visibility. Drag the product or use Turn to rotate all views together; Reset affects the selected frame and Apply to all restores a matched comparison. Keep settings in the URL. Old surface links recover their mode without reinterpreting perforation size as a physical mesh property.

Reason: Estelle clarified that the effect should expose the object itself. Use its real triangles and imported transforms, not a texture suggesting hidden structure. Radial smoothing is now the comparison's default after the visual comparison; the live website's morph remains unchanged. Preserve the 64 anchors, exact endpoints, common clock and 30% midpoint shrink.

Load only the verified local product GLB (about 2.2 MB, 38 meshes), without the room. One 750 × 450 WebGL buffer draws the visible views on demand, then copies them into cached canvases; morph playback changes only their SVG clips. Original geometry and materials remain intact, inspection materials are reusable, and teardown releases shared buffers once. Default edge opacity is 12% so dense triangles do not overwhelm the object. Loading, missing assets and context loss have explicit status and retry. This study uses the source GLB finish, not later campaign material/artwork edits, and requires the local Nessino campaign. Skinned, instanced and morph-target meshes are explicitly unsupported here.

Scope: [comparison UI](../web/src/CurveComparisonDemo.tsx), [product loader](../web/src/curveProductAsset.ts), [object renderer](../web/src/curveProductRenderer.ts), [settings](../web/src/curveProductSettings.ts), and their focused tests. The previous image study is recoverable in the task workspace under `work/gesso/mesh-study-baseline`.

Verification: 96 focused geometry, pattern, asset, renderer and settings tests passed; production build and whitespace checks passed. Browser checks covered the real lamp, independent frame modes, object/edge opacity, back edges, drag rotation, keyboard editing, Apply to all, Reset, product/silhouette switching, morph playback and URL reload recovery. No console errors were reported.

### 2026-10-21 — D109 — Import parts and dimensions through one product handoff

**In code.** STEP/STP, IGES/IGS and STL/OBJ join GLB and Blender in the existing product import. All paths produce the same validated, hashed GLB and source-part catalog used by preview, animation and export. OpenCascade preserves available CAD assembly names, surface shells and display colours; its tessellation tolerance is recorded. Native CAD features and mechanical constraints are not inferred. Failed conversions publish nothing.

Reason: a product designer should not need an external conversion step for common interchange files, but importing must not silently change size, drop surface-only parts or invent material/assembly information. Nessino proved why reading only solids was insufficient: 30 of its 38 selectable parts are surface shells.

Units stay explicit. STEP/IGES read their documents. STL/OBJ require a choice. Blender uses file units with an optional override, because the actual perfume file declares none. Import can use a newer Blender while exports retain the reference 4.3.2 renderer. Unsupported shaders/resources initially returned preparation instructions; **D111 supersedes that blocking material policy**. Unused material slots no longer block otherwise supported geometry. Dense products report their vertex cost instead of silently losing detail.

The teammate integration preserves audio, moving lights, shadow colliders and gallery films alongside local artwork, part animation, low-resolution preview and curve studies. Contact checks also restore D93's intended behavior: when the plinth is hidden in an authored studio, the floor meets its support height in both renderers.

Scope: `film/products.py`, `film/cad_import.py`, `film/blend_import.py`, import worker scripts, Product import controls, CLI/server options and [compatibility evidence](import-compatibility.md). Existing campaigns and source files are preserved; this is support for the documented formats and tested cases, not a claim that every Blender or native CAD file can be represented.

### 2026-10-21 — D110 — Fit the product inside the world's projected bounds

**In code.** Selecting an imported world fits the product once into that world's projected bounding rectangle, inset 10% on each edge. **Fit product to scene** repeats the operation for the current shot. A dotted box shows the target. Use the saved shot camera and output aspect ratio, so changing the sidebar width cannot change the fit.

Reason: product files and generated worlds arrive at independent scales. Keep the imported dimensions as source data; use one uniform placement scale to compose the product within the scene. The fit keeps the support pivot, camera, world, proportions, materials and part coordinates intact. It enters undo history and saves with the campaign. Absolute product scale keys receive the same multiplier; relative Film motions keep their values. The canonical evaluator supplies the animated pivot and scale, rather than estimating them from the viewport.

This is a composition fit, not a claim about a generated room's physical dimensions or a collision-free placement. Measure loaded mesh geometry, or a Gaussian world's collider. Missing bounds, off-screen support and out-of-range scales produce a recoverable error. Existing campaigns are not refitted on open. Both sides of an A/B comparison use one shared scale.

Scope: `web/src/productWorldFit.ts`, `viewport.ts`, `WorldPanel.tsx`, `ProductFitGuide.tsx`, `App.tsx`, and the opt-in placement sample in `film/scene.py` / `film/server.py`.

### 2026-10-21 — D111 — A material failure must not discard the product

**In code.** If a Blender material cannot be converted, use an opaque neutral surface for that material and continue importing. Keep supported materials, geometry, part assignments, UVs and source dimensions. Preserve working Glass/Mix conversions and static map baking; isolate failures by material. The source file stays untouched. The fallback lives in the imported GLB, so preview and export receive the same material.

Reason: a node group such as `Metal / Group.003` should not prevent someone from working with their model. Requiring a Blender repair before opening the product makes material fidelity a gate for every other task. Show one import warning and retain names, affected objects, causes and optional repair steps in a collapsed **Import notes** disclosure in Product and Material. Explain how to keep the original finish by fixing the source and reimporting; users can also assign replacements in the material library. These notes describe the import, not whether the user has since edited the finish.

This supersedes D109's blocking policy for material graphs/resources. Invalid geometry, unreadable files, unsafe external scene dependencies, process failure and global limits still stop incomplete imports. No claim is made that an unsupported shader's appearance survives the fallback.

Scope: `scripts/import_blend_product.py`, the bounded report reader in `film/blend_import.py`, `web/src/ProductImportNotes.tsx`, `ProductPanel.tsx`, `productImport.ts`, and the Blender import regressions.

Verification: actual Blender 5.1.1 imports and focused 4.3.2 regressions cover unsupported groups, shared materials, missing images, bake failures, optional repairs and unchanged geometry/UVs/source files. The larger warning report passes the atomic import wrapper. Twenty-five frontend checks and the production build pass. Browser import of a mixed-material fixture succeeds, preserves the supported blue-gray/red surfaces, renders the neutral replacement, and keeps repair notes after reload. Detailed notes are bounded and report omitted counts for large files.

### 2026-10-21 — D112 — Explain the reusable setup on the cover

**Expanded copy and action superseded by [D146](#2026-10-21--d146--one-studio-entrance-and-one-mobile-navigation-row); footer line retained.** Estelle's cover line is **“a reusable studio for product activation content.”** The expanded window adds **“Set up your product once. Change the finish, setting, or camera for the next image.”** Its action is **“make a still or film”;** navigation keeps **“enter studio.”** Both enter the existing resumable editor.

Reason: name repeatability on the cover, explain what gets reused on contact, and name the output in the action. The copy does not promise instant generation or a new project on each visit. Keep Halyard, the site grid, centered wordmark, shared morph and video lifecycle. Compact screens move the helper into a reserved footer row so it cannot collide with the video or side labels. The collapsed entrance is inert; keyboard and touch reveal the same content.

Scope: `web/src/LandingPage.tsx`, `web/src/landing.css`. Original files remain in the task workspace under `work/gesso/cover-copy-baseline`. Production build and whitespace checks pass; browser checks confirm the expanded copy, keyboard reveal, regular text weight and compact layouts at 433px and 356px CSS widths.

### 2026-10-21 — D114 — Let the browser own scrolling

**In code.** Remove Form + Light's scroll debugger, its shortcut and its experimental scroll controller from the public page. Saved study settings cannot re-enable custom scrolling. Native scroll position still drives the shared shape and text flow; retain the 30% default midpoint shrink and native section links. The study modules remain in source for reference.

Reason: the page should follow the person's scroll, without a second controller waiting for or redirecting the gesture. About now accepts native scrolling across the full page, including the header and margins. Its navigation and shared window remain fixed while the content scrolls through them.

Scope: `ShapeLightPage.tsx`, `shape-light.css`, `AboutPage.tsx`, `about.css`. Recoverable baselines are in the task workspace under `work/gesso/native-scroll-baseline`. Production build and whitespace checks pass. Browser verification covers the removed debugger and shortcut, native scrolling, principle links, and About scrolling over its margin and header.

### 2026-10-21 — D115 — Show the editor behind each principle

**In code.** Replace the five Form + Light video loops with static captures of the actual editor: Film and its timeline, still export, the parts tree, material controls, and bottle label controls. Each image fills the existing moving contour with a crop chosen for that section. Keep the glassine cover, copy, shared shape renderer, native scrolling, and 30% midpoint shrink.

Reason: the principles describe how the workspace behaves. Relevant interface details show that work directly. An initial fit that kept every screenshot edge inside the shape made the controls too small; full-bleed crops preserve useful scale. Desktop waits for an image to decode before replacing the previous capture; compact layouts use the same assets in their static shapes. Five separate lossless WebP files total 669 KB. About's video gallery is unchanged.

Scope: `GlassineStudy.tsx`, `ShapeLightPage.tsx` static specimens, `philosophyScreenshots.ts`, `shape-light.css`, and `assets/gesso/editor-stills/`. Asset sources and capture limits are recorded in `assets/gesso/ASSETS.md`. The task workspace retains the full browser captures and implementation baseline.

Verification: production build, 23 existing sequence/motion/text regressions, and whitespace checks pass. Browser checks cover all five sections, reverse scroll, cover handoff, and the compact layout at 433px CSS width. All five captures decode, Form + Light contains no video elements, and the glassine renderer stops outside its cover. No console errors were reported.

### 2026-10-21 — D116 — Keep the reading lines, move them around the shape

**In code.** Form + Light's scrolling compositions stay inside columns 2–6. The outer columns carry no moving text or shape geometry. Reduce and reposition the windows to leave two columns for reading and up to three for the specimen; retain the fixed navigation, different silhouettes, screenshots, glassine cover, and 30% contraction between shapes.

Reason: the earlier flow kept recalculating line breaks, then moving words between rows. Smoothing those moves still made the copy jump. Pretext now measures complete lines only when fonts or viewport width change. Scrolling moves each line horizontally against the actual contour; its words, baseline, and paragraph height remain fixed. A 64px vertical approach/release range softens the response to a flat shape edge without adding a second animation clock. Text is bounded by the inner columns. Shapes must leave enough room for the widest line and its 24px clearance. Concentrate horizontal shape travel around the contracted midpoint, after the outgoing copy has cleared; use a common centered vertical composition for the chapters.

Scope: `ShapeLightPage.tsx`, `shape-light.css`, `philosophySequence.ts`, and `philosophyTextDom.ts`. Compact screens retain native text and static shapes. Baselines remain in the task workspace under `work/gesso/centered-line-flow-baseline`.

Verification: production build and 31 focused tests pass, covering fixed line content/baselines/heights, selectable node cleanup, no warm-path text/layout measurements, reversible contact, smooth crossing boundaries, inner-column shape bounds, grid-aligned endpoints, 64 anchors, and 30% midpoint shrink. Browser checks confirm centered desktop/narrow-desktop compositions and unchanged line breaks through forward/reverse scroll. Sampled transitions at 1422px and 1000px CSS widths report no blocked line lanes or outer-column overflow; the 433px compact layout retains native text. No console errors were reported.

### 2026-10-21 — D117 — Align the left copy toward the window

**In code.** Right-align Form + Light's left-side headings, body, section labels and contents links. The right-side copy remains left-aligned. Each measured line begins from its aligned position before the contour applies clearance; scrolling still preserves its words and baseline. Contents links keep 24px clearance from the specimen lane, and compact text boxes share a right edge.

Reason: the left copy should face the central window without changing its reading order or rewrapping during movement. Scope: `philosophyTextDom.ts` and `shape-light.css`. Production build and nine existing text-flow tests pass. Desktop and compact browser checks confirm the alignment; forward/reverse scrolling retains line content and baselines.

### 2026-10-21 — D118 — Three tabs, one continuous editor surface

**In code.** Use **Product / Stage / Film**, following Figma frame `313:8359` and Estelle's confirmed naming. Product owns Model, Materials and Decals, kept visible in a fixed sidebar row. Each material view has one static section heading rather than a second set of selectors. Stage retains the existing world controls; Film retains Still / Video.

The tab labels start on columns 2–4 of the seven-column grid. Keep Halyard, trailing Option shortcuts, the current application menu icons and save states. The top bar is pure black. A single #131313 tab surface has rounded top corners and concave joins into the editor; a 16px strip of editor ground keeps that join intact above the viewport. Its broad neutral halo travels with it, confined to the black top bar. The halo follows only the tab’s exposed edge and is clipped at the editor join, so the tab and editor remain uniformly #131313. Animate only the shared surface's horizontal transform over 380ms, so another selection redirects the same moving object. Labels stay in place. Reduced motion removes this transition.

Reason: Product, the set, and the film are the three main decisions. Finishes belong to the product; navigation should show which part of the same workspace is active. This implements the three-tab direction without adding the still-discussed dice or generation flow. Old Material URLs normalize to Product; existing world/film links and history remain valid. Option/Alt 1–3 selects a main tab; 5 onward selects its controls. Materials still shows the whole product at full opacity; Decals retains its UV overlay and part focus.

Scope: `EditorNavigation.tsx`, `navigation.ts`, `App.tsx`, `ProductPanel.tsx`, `interface-system.css`, and `condensed-editor.css`. The exact 10px Figma Option export is local; the older Instrument Sans and text Undo/Redo header in the reference do not replace the established Halyard/Lucide system. Baselines remain under the task workspace's `work/gesso/tabbar-baseline`. Production build and 119 focused navigation/history/panel/material/decal/frame tests pass. Browser checks at 1280px and 1000px verify the three tabs, exact black/#131313 surfaces, local 10px shortcut assets, Materials/Decals access, Option shortcuts, Back navigation and legacy Material links. Leaving Model clears stale import-file state when its file input unmounts.

Halo correction: production build and browser checks across Product, Stage and Film pass; the glow remains above the editor join while the shared surface translates. No browser errors were reported.

### 2026-10-21 — D119 — Inspect the editor’s layout columns

**In code.** View → Column guides toggles seven full-height columns using the editor’s existing pitch, 40px outer margins and 20px gutters. Show both edges with a faint fill; keep menus and header controls above the guides. The overlay cannot intercept clicks or enter the keyboard/accessibility tree. It is off by default and remembers the preference locally.

Reason: inspect alignment against the actual editorial grid without moving the interface or adding guides to scene state, undo history, renders or exports. The overlay is seven DOM spans with CSS sizing; no renderer or animation loop is added. Scope: `App.tsx` and `interface-system.css`.

Verification: production build and whitespace checks pass. Browser checks cover pointer and Space-key toggling, focus return to View, unchanged playback, reload persistence, and exact column bounds at 1280px and 1000px. Menus remain above the guides; no browser errors were reported.

### 2026-10-21 — D120 — Remove parts from the scene, retain the source

**In code.** Product → Model places a three-dot menu beside each object: Rename and Remove part. A group shows the affected count and confirms removal of its children. After removal, focus moves to a surviving part; removing everything leaves an Import action and an Undo instruction. Existing Undo/Redo restores the exact scene revision. The temporary eye control keeps its separate preview-only role.

Reason: someone cleaning an imported product should be able to remove unwanted geometry without returning to CAD or accidentally exporting hidden parts. Store removal as stable IDs in `product.removedPartIds`; keep source geometry, materials, motion and labels intact. Resolve editorial children when the command runs, and always include native source descendants. The sampled removal list drives both the live renderer and Blender, including labels and decals attached to removed objects. Other parts keep their transforms; existing motion and camera references remain valid. Removed objects disappear from part/material assignment and new motion/target choices; reusable finishes remain in the library.

Scope: `PartOptionsMenu.tsx`, `ProductPanel.tsx`, `App.tsx`, `partRemoval.ts`, `partTargets.ts`, `filmMotion.ts`, `keyframes.ts`, `CameraPanel.tsx`, `viewport.ts`, `film/part_visibility.py`, `film/scene.py`, and `scripts/blender_scene.py`. The menu uses the existing material-menu surface and keyboard behavior; it clears scroll clipping without changing row height. Baselines are in the task workspace under `work/gesso/part-removal-baseline`.

Verification: production build, 244 focused frontend tests, 22 Python checks and two native Blender build/reopen checks pass. Coverage includes imported subtrees, procedural parts, attached artwork, all-parts removal, full Undo/Redo restoration, saved revisions, export digest changes, deep source graphs and retained motions through subsequent Film edits. In the browser, a lamp part removes cleanly (39 → 38), full-product removal leaves an empty live viewport, Undo returns all 39 parts, and the campaign returns to Saved. No source asset is rewritten. The local server remains running with the new sampler.

### 2026-10-21 — D121 — Edit the parent where it is named

**In code.** Put the objects tree on the existing lighter gray field surface (#242424), with 8px inset and rounded corners. Keep selection, visibility and three-dot actions within each row. Replace the static Parent value with a dropdown that changes grouping immediately. Remove Organize…, File details… and their secondary views.

Reason: the person should select a part and change its parent in place, without opening another editing mode or applying the same choice twice. Invalid parents (the object itself or its descendants) are excluded. Reveal a collapsed destination so the selected part remains visible. Undo restores the previous grouping. The original source graph, geometry and motion remain intact; this dropdown organizes the list. Keep the name and measured dimensions in the fixed Part details block. This supersedes D91’s extra inspector views.

Scope: `ProductPanel.tsx`, `condensed-editor.css`, and `ProductPanel.test.tsx`. Baselines remain under `work/gesso/direct-parent-baseline` in the task workspace.

Verification: production build and 28 focused panel/hierarchy checks pass. Browser checks confirm the #242424 tree surface, direct parent selection, Undo restoring the original grouping, and the three-dot menu remaining accessible. Source metadata and motion are unchanged; the dev server stays running.

### 2026-10-21 — D122 — Put the thing being edited above its controls

**In code.** Each editing task begins with a visual asset. Model shows a wireframe of the loaded product; hovering or keyboard-focusing a tree row fills that part's faces. Materials begins with red plastic, satin metal and clear glass. A starter opens an unassigned draft, keeping existing finishes intact. Decals begins with the selected artwork and Wordmark, Label and Serial starters. Each adds an editable decal to the selected UV-enabled part through the existing artwork pipeline.

Stage uses small PNG covers of the actual sets. Large worlds reuse the loaded viewport for their first cover rather than downloading a second copy. Film uses compact motion diagrams above the controls and inside action buttons; hover or keyboard focus demonstrates the camera, object or light movement without changing the film.

Reason: the visual should explain what a control acts on before the person reads a list of settings. A material sample, part outline, stage image and movement diagram carry different information; they should not all be another live scene. The outline shares loaded geometry and the existing renderer, caches its small PNGs and updates on contact. World covers render on demand with bounded downloads and texture sizes. Film previews pause offscreen, when unfocused, and under reduced motion or data saving. Failed or stale captures must never label a different part as the hovered one.

Scope: `ModelOutlinePreview.tsx`, `modelOutline.ts`, `ProductPanel.tsx`, `MaterialLibrary.tsx`, `DecalEditor.tsx`, `WorldCovers.tsx`, `worldCover.ts`, `FilmMotionPreview.tsx`, `FilmWorkspace.tsx`, `NewFrameFlow.tsx`, `viewport.ts`, and their styles. Baselines are under `work/gesso/visual-assets-baseline` in the task workspace. Existing source assets, hierarchy, saved finishes and film motion remain the source of truth.

Verification: production build and 244 focused tests pass. Browser checks cover actual lamp geometry and part highlights, material draft/cancel, UV availability, adding a bottle decal and undoing it, stage PNG covers, and Film animation starting/stopping with keyboard focus. Testing the imported bottle exposed its off-center UV island: new decals now validate their suggested center against mapped triangles and reduce their initial footprint to fit sampled UV coverage. This is a useful starting placement, not a UV packing tool. Preview capture also preserves physical target dimensions at low/high renderer pixel ratios, rejects stale highlights, and retries temporary still-render conflicts. The dev server remains running.

### 2026-10-21 — D123 — Lift the editor ground slightly

**In code.** Lighten the shared editor/tab surface from #131313 to #181818 and the top bar from black to #080808. Raise the tab halo opacity from 18% to 24%, retaining its 24px blur and spread. This updates D118's ground values without changing the continuous tab join or motion. Material and prop preview backdrops read the editor ground, and the shared frame's startup fallback matches it.

Reason: give the editor a slight lift while retaining its dark setting and quieter field contrast. The rendered product, marketing-page colors, typography and layout stay intact. Scope: `interface-system.css`, `App.tsx`, `DynamicFrame.tsx`, `MaterialSwatches.tsx`, `WorldObjectPreviews.tsx`, and `world-object-previews.css`. Baseline: `work/gesso/lighter-editor-baseline` in the task workspace.

Verification: production build and whitespace checks pass. Browser inspection confirms #181818 for both the shared ground token and active tab, #080808 for the top bar, and 24% halo opacity.

### 2026-10-21 — D124 — Align Product with File

**In code.** Start Product’s text at File’s left edge. Both rows use the same 160px identity column and 16px gap; the tab surface begins 10px before its text. Stage and Film retain their existing column interval, with the moving tab and halo following the row. This updates D118’s independent second-column start: the application menu is now the alignment reference. Scope: `interface-system.css` and `style.css`. Baseline: `work/gesso/file-product-alignment-baseline`.

Verification: production build and whitespace checks pass. Browser measurements at wide and narrow desktop sizes place File and Product’s text at the same x coordinate (216px), while preserving tab spacing.

### 2026-10-21 — D125 — One lit edge for the tab and editor

**In code.** Extend the existing halo contour along the horizontal editor edge on both sides of the tab. Increase its blur and stroke from 24px to 32px at the same 24% opacity. The halo follows the shoulders as the tab moves, while the unchanged opaque fill and bottom clip preserve one #181818 editor surface. Keep application-menu text and popups above the glow.

Reason: a halo confined to the tab made it read as a separate object. One continuous contour connects it to the editor ledge without overlapping two glows at the join. Motion remains the existing interruptible transform, with no per-frame geometry work; reduced motion stays immediate. This updates D118/D123’s tab-only halo. Scope: `EditorNavigation.tsx` and `interface-system.css`. Baseline: `work/gesso/continuous-tab-halo-baseline`.

Verification: production build and whitespace checks pass. Browser checks confirm the continuous glow in Product and Film, retained menu stacking, and the unchanged opaque editor surface.


### 2026-10-21 — D126 — More room inside the main tabs

**In code.** Increase Product / Stage / Film from 36px to 44px high, with 8px top, 10px bottom and 16px side padding. Move the tab surface 6px left to keep Product’s text aligned with File; retain the existing column pitch, type size and continuous halo. The header grows by 8px, and the SVG shoulders retain their original curve sizes.

Reason: give each label more breathing room without enlarging the text or breaking the shared editor edge. This updates D124’s 10px text inset. Baseline: `work/gesso/larger-tabs-baseline`.

Verification: production build passes. Browser checks at wide and narrow desktop sizes confirm 44px tab height, Product/File text alignment at 216px, and matching tab/header bottom edges. Film’s format controls follow the new height. Dev server remains running.


### 2026-10-21 — D127 — Same studio, scaled product

**In code and local defaults.** Starter campaigns use a fixed studio reference and a 320 mm longest-side product envelope, matching Nessino’s existing display size. Store the fit in placement.scale; retain source dimensions, geometry, material assignments, artwork and part-local movement. The authored sweep, default lights, shadow coverage, new light/prop defaults and world-cover renderer all read the same environment.studioSizeM value. Imported room transforms remain unchanged. The implicit rig anchors to the plinth support, so repositioning or recentering a product does not move the studio lights.

Reason: legacy imports resized the support, camera and studio from raw file dimensions. The local unitless watch therefore received an 839 m camera; changing only its product scale could never repair the composition. Rescale starter cameras, whole-product movement, explicit rig/near-field coordinates and absolute scale keys together. The first normalization exposed a second issue: the older watch and bottle imports still contained studio planes, so their full source bounds were not product bounds. After inspecting those nodes, remove only the identified ground/light geometry through the existing recoverable removedPartIds state, recenter the retained object, and fit its bounds into the envelope. Original GLB bytes and source catalogs remain unchanged. Part and relative motion scale limits stay unchanged; whole-product scale accepts smaller factors so large source-unit imports remain editable. Both A/B worlds share the studio reference. This extends D110’s explicit composition fit to default setup; selecting a generated world still uses its projected fit.

Applied to MORA, Nessino, statue, esteban perfume bottle and watch as new revisions. The two legacy imports additionally retain a documented product-only repair manifest (excluded node names, placement scale, fitted dimensions and revision IDs). Prior revisions and source files remain recoverable; QA campaigns were left intact. New default and imported campaigns use the same rule. Opening or duplicating an existing campaign does not trigger a resize. Older scenes without studioSizeM retain their original rendering. Baseline and per-campaign before/after manifests are in the task workspace under work/gesso/campaign-scale-baseline and work/gesso/campaign-scale-migration.

Scope: film/campaign_defaults.py, product import and store defaults; canonical scale validation and controls; viewport and Cycles environment builders; light/prop defaults, covers and comparison state. Verification: focused sizing/import/API tests, frontend scale/renderer tests, production build, and a native Blender 4.3.2 check of fixed sweep geometry and lighting across differently sized sources. Final regression checks also confirm removed source subtrees stay out of subsequent world fitting, temporary eye-hidden parts still count, and undo restores their contribution. The rebuilt editor was checked with the saved campaign defaults; the dev server remains running.


### 2026-10-21 — D128 — Space below the material library heading

**In code.** Add 16px between the Library heading and its three starter swatches. The heading previously met the library with no gap. Scope: the Materials cabinet’s library wrapper in `material-library.css`; swatch sizes, internal spacing and preset controls remain unchanged. Baseline: `work/gesso/material-header-spacing-baseline` in the task workspace.

Verification: production build and whitespace checks pass. Browser measurements confirm a 16px gap below Library, with all three starter swatches visible.


### 2026-10-21 — D129 — Give feedback its own text color

**In code.** Use muted green (#a8d5b5) for saved/completed states and warm orange (#e8ad79) for notes, guidance and pending work. Keep control labels in the neutral interface palette and measurements/counts muted; failures keep the existing error color. Text still names the state, so color is not the only signal. This updates D11’s yellow pending state to orange.

Reason: messages such as “Saved with this campaign” looked like controls. Explicit feedback tones distinguish an action from its result, including success and failure messages that share one status area. Scope: material library/assignments; Product, Stage and Film notes; import notes; header/footer, loading and export feedback; shared interface tokens. Layout, copy, starter presets and interactions stay intact. Baselines: `work/gesso/message-colors-baseline` in the task workspace.

Verification: focused panel, material and export/still tests pass, as do the production build and whitespace check. Browser measurements confirm green saved/Live messages, orange material guidance, white Add new, and unchanged muted part counts. Toasts now carry explicit tones too, so confirmed saves/opening results cannot be confused with pending import guidance or a failure.


### 2026-10-21 — D130 — One gray surface for selection collections

**In code.** Give asset libraries and object-selection collections the Objects box treatment: the existing #242424 field surface, 8px corners and 8px inner padding. Keep headers and surrounding controls on the editor ground. The material library retains its 16px separation below its heading. Material/prop preview backdrops inherit the collection surface; actual world images retain their scene backgrounds.

Reason: the container should identify a set of things to choose from before the person reads every item. Apply the same surface to material and decal libraries, Stage collections and Film target lists; existing gray motion tiles stay intact. Status colors, button padding, selection behavior and assignment flow remain unchanged. Scope: shared `gesso-selection-surface`, collection roots and preview backdrops. Baseline: `work/gesso/selection-surfaces-baseline` in the task workspace.

Verification: production build and whitespace checks pass. Browser inspection confirms #242424, 8px padding/corners and matching inherited preview backgrounds in Materials; Materials and Decals have no horizontal overflow.


### 2026-10-21 — D131 — Export becomes an editor state

**In code; light Export surface superseded by [D145](#2026-10-21--d145--export-joins-the-dark-editor-dice-remains-separate).** Move Still / Video into pinned tabs at the top of Film’s right sidebar. Place one white Export button after Product / Stage / Film, with the same 44px height and upper contour, separated by the existing 20px gap. Selecting it opens the canonical Film / Output destination; its lower corners morph into joined tab shoulders and the editor surface becomes white with dark controls. The left rail and editing timeline leave the layout. Export settings occupy the only visible sidebar, on the right, with persistent render/download actions below its scrolling body.

Reason: the final image should remain the focal object while choosing its delivery format. Export no longer covers the editor with a modal. Keep the existing canvas instances and camera sampler; mask overscan with the renderer’s own film gate, disable inspection, show the whole product, and provide one preview scrubber. Paired exports display both worlds without changing Stage’s remembered comparison view. The live preview stays at its existing pixel budget; opening Export does not start a high-resolution render.

Preserve PNG/JPEG/WebP stills, MP4/ProRes/PNG-frame video formats, actual job progress/downloads/cancel/resume, missing-tool validation, and the existing composition/frame-rate/sound controls. Still / Video uses one URL mode, including keyboard navigation and browser history. Film remembers its last editing layer rather than returning to Export; close returns to the prior workspace. Format changes retain filename, scale and sample settings. The same Halyard styles, gray collection surfaces, dotted section rules and signal colors are inverted for contrast. Main navigation and the outer header retain their dark ground. Reduced motion removes contour transitions. This supersedes the separate export dialog and Film’s top-bar mode controls.

Scope: App, EditorNavigation, FilmModeTabs, ExportPanel, ExportPreview, FilmPanel’s shared output-only controls, navigation history and scoped export styles. Baseline: work/gesso/export-workspace-baseline in the task workspace. Verification: focused export, keyboard, navigation/history, camera-gate and Film tests pass; production build passes. Browser checks cover Product → Export, Still/Video switching and playback, return to Film, close/Back, retained sound controls, one visible sidebar, and no horizontal overflow at wide and narrow desktop sizes. The local server currently lacks FFmpeg 7.1.5, so encoded video formats correctly remain disabled; no final render was submitted for this UI pass. Dev server remains running.


### 2026-10-21 — D132 — Dropdowns share one text edge

**In code.** Align popup options with the closed select value; align File / Edit / View menu text with the active navbar label. Use black popup surfaces with square corners, no border, and a quiet white shadow. Hover brightens text without filling the row or trigger. Keyboard focus retains an underline; icon-only triggers get a small bottom rule. Disabled and destructive states remain distinct. History stays against the header’s right margin.

Reason: the previous menus mixed gray surfaces, filled hover states and unrelated left offsets. Keep the existing Halyard, field hierarchy, menu animation and scene state. Apply the treatment to application, material, part and scene menus and desktop select pickers. Export’s closed controls retain dark text on white; its open pickers use the same black surface. The real select element remains the source of value, keyboard operation and form behavior. Desktop browsers supporting `appearance: base-select` receive the styled picker; touch and unsupported browsers retain their native picker. This follows the [browser’s customizable select API](https://developer.chrome.com/blog/a-customizable-select).

Native picker Escape closes the picker before its enclosing menu or Export; picker keystrokes do not trigger viewport shortcuts. Scope: dropdown-system.css, EditorMenu positioning, App keyboard filtering, ExportPanel and FilmShotStrip Escape handling. Baseline: work/gesso/dropdown-system-baseline in the task workspace.

Verification: production build and focused Export/Film tests pass, including an Escape regression. Browser checks confirm aligned File/View/Campaign text, black borderless popups, part action colors, keyboard select/restore, nested Escape, and readable menus in the inverted Export workspace. Dev server remains running.


### 2026-10-21 — D133 — Lighter inactive workspace tabs

**In code.** Product / Stage / Film use Halyard Text Regular (400) when unselected and retain SemiBold (600) when selected. The weight now reinforces the active workspace without adding another visual marker. Keep the existing type size, fixed grid columns, padding, colors and Export action. The smaller layer and Still / Video controls already use Regular and remain unchanged.

Scope: interface-system.css. Baseline: work/gesso/tab-weight-baseline in the task workspace. Verification: production build passes; browser inspection confirms the active/inactive weights and unchanged tab dimensions.


### 2026-10-21 — D134 — Film controls show their action and position

**In code.** Replace the small Play/time text in the timeline's left corner with start, play/pause and end icons in 40px targets. Use the same controls in Export preview. Put a downward-pointing pentagon above the existing playhead line; a 24px grab area preserves the pointer's contact offset, while clicking elsewhere on the ruler seeks immediately. Selected scenes use a white background with dark text and controls. Playback position and the scene being edited remain separate states.

Reason: playback, scrubbing and scene selection need distinct visible forms. Keep one film clock and one native range for keyboard and pointer input. Reordering, trimming and scene menus retain their existing controls. The ruler grows by 8px and the dock by 20px to fit the handle and larger transport without adding scrolling. No extra animation or playback state.

Scope: FilmTransport, FilmTimeline, FilmShotStrip, ExportPreview and their styles. Baseline: work/gesso/film-transport-baseline in the task workspace. Verification: 44 focused transport, timeline, scrubbing and reorder tests pass; production build and whitespace checks pass. Browser checks cover play/pause, start/end, dragging across a cut, Home/End/Shift-arrow scrubbing, selected-scene contrast, the final-frame handle, and Export transport at narrower desktop width. Dev server remains running.


### 2026-10-21 — D135 — Choose the content after New scene

**In code.** Film has one creation button: New scene. Its right-sidebar chooser offers Product shot or Static image / text. Product shot continues through the existing Objects → Camera setup. The static branch accepts an image or a Halyard text card, shows a preview and duration, then inserts it after the selected scene. Name it from the file or first text line; rename it in the timeline. Keep the preview, heading and Back/Add actions mounted while the controls scroll when space is limited.

Reason: a scene is the thing being added; image versus product is a decision within that flow. Opening the chooser or drafting static content does not add a timeline item. Back, Cancel and import failure retain the existing film. Abort cancelled imports and reject a stale film version before committing. Product setup keeps its existing discard behavior. Text scenes can reopen with Edit text; image scenes offer Replace image.

Text remains editable metadata beside a canonical PNG. Measure and rasterize it in Halyard Regular after the font loads; preview and export consume that same stored image. This preserves the existing image renderer, film clock, asset verification and export path. No second text renderer or new shot kind. This replaces D77's separate Add image action.

Scope: NewSceneFlow, filmTextCard, staticScene, App, FilmTimeline, FilmClipDetails and content labels. Baseline: work/gesso/new-scene-baseline in the task workspace. Verification: 79 focused web tests and 14 image-pipeline Python tests pass, including metadata save/reload and exported pixel parity. Browser checks cover both branches, image and text insertion, reopening, cancellation, undo, and Product → Objects → Camera → Discard. Test scenes were undone. Dev server stays running.


### 2026-10-21 — D136 — Read the frame; edit the camera in one place

**In code.** Film shows four white corner marks, dotted center axes, a center crosshair and a small target/focus circle. Remove the frame label, floating numeric controls and repeated shot/time caption. Keep the measured frame when selecting objects, playing the film, inspecting the scene or showing a static image. Export uses its own per-pane crop marks. Return to shot appears only after inspecting; inspection still does not change the saved camera.

Reason: framing and camera settings were divided between a label, a floating strip and the right sidebar. The image now carries composition guides and target dragging. The sidebar owns aspect, lens, target and depth of field. Exact coordinates and path operations sit in closed disclosures; new motion choices open through Add motion. **[D144](#2026-10-21--d144--choose-camera-movement-before-framing) supersedes Add motion for the camera only.** Remove the redundant idle camera diagram. Keep the source camera, endpoint rules, motion ownership and canonical output dimensions. This supersedes D28’s viewport setting controls.

The focus circle has a fixed screen size; it is not a blur-radius control. With optical depth of field enabled it marks the actual projected focus point. Manual distance remains editable in the sidebar; follow-target focus retains pointer and keyboard aiming. Publish guides after their matching render, and publish only the frame for flat image/text content. Guides remain DOM overlays and cannot enter exported pixels.

Scope: FilmViewportControls, CameraPanel, FilmWorkspace, filmGuides, viewport presentation, App and ExportPreview. Baseline: work/gesso/film-guides-baseline in the task workspace. Verification: focused framing, optical projection, static-image, Film workflow and Export tests pass; production build passes. Browser verification covers persistent guides during object editing and playback, compact sidebar controls, and reversible camera edits. Dev server remains running.


### 2026-10-21 — D137 — Random setup is a separate export candidate

**In code.** Export gains a left rail with Current scene / Random setup tabs. A white dice button immediately before Export opens that rail without generating anything. Keep / Fill gaps / Randomize defines what each category may change; expandable pools define the allowed stages, lighting, views, camera movements and material types. Duration, shot count and screen ratio belong to framing. Generate creates one candidate; changing its settings requires generating again before export.

Reason: a finished result must be reachable from any workspace without giving up the product or decisions already made. Fill gaps is the default. An existing static camera, imported finish and implicit studio lighting count as decisions, not missing values. Material replacement requires selected objects. Geometry, dimensions, artwork and authored part movement stay intact; full-film duration changes use the existing retiming rules. Reject incompatible timing instead of silently dropping animation.

The candidate is bound to the exact original revision and project. It stays outside history and saving, uses the real camera sampler/viewport/exporter, and is invalidated when the original changes. Current scene restores the original; leaving Export restores its playhead even when the candidate is shorter. Disable original-history Undo/Redo while viewing Random setup. Ignore delayed edits or render responses from an older candidate. Report the actual generated changes and retain the candidate while switching tabs. Export format/resolution/sample controls remain on the right.

Scope: randomSetup, exportDraft, ExportSetupPanel, EditorNavigation, App and ExportPanel/Preview. This supersedes D131's single-sidebar Export layout. Baseline: work/gesso/random-export-baseline in the task workspace. Limits: local preset/library stages rather than remote world generation; material randomization targets complete product objects, not individual imported source faces; selecting a library world retains the existing support and placement rather than inferring a new floor.

Verification: engine tests validate generated bottle/glass scenes through the Python export validator; draft tests verify source isolation and stale revision rejection; UI tests cover tabs, defaults, explicit material targets and late export responses. Production build passes. Browser checks confirm dice → settings → generation, square three-shot/six-second variation, Current scene returning to the original 16:9/two-shot/ten-second film, and restoring the original frame 240 after scrubbing a shorter candidate. No final render was submitted. Dev server stays running.


### 2026-10-21 — D138 — One scene count; loop beside playback

**In code.** The timeline says “2 scenes” once above the shot row. Remove the separate Scenes label and duplicate count. Put a native Loop checkbox directly below the transport icons, using the existing ruler row so the bottom dock stays the same height.

Reason: the count identifies the collection; repeating its label adds no information. Loop belongs to preview playback. It wraps the shared frame/audio clock through the inclusive playback range and preserves the selected editing scene. Turning it off restores stopping at the final frame. The preference stays local to Film playback; it does not change the saved scene, movie duration or export.

Scope: FilmTimeline, FilmWorkspace props, App playback and filmPlayback. Baseline: work/gesso/film-loop-baseline in the task workspace. Verification: 42 playback, playhead, transport and timeline tests pass; production build passes. Browser checks: frame 239 wraps to frame 4 with Loop on and stops at 240 with Loop off; Space toggles the checkbox without starting playback. Dev server remains running.


### 2026-10-21 — D139 — Shorter Export and dice controls

**In code.** Export and the dice button are 36px high, down from 44px, and sit on the navigation's lower edge. Dice is 36px square. Retain the main tabs' 10px top corner geometry, Export's white fill and its joined selected state. Shorten the SVG itself so the corners do not flatten. This refines D131/D137's action sizing: the controls need not align at the top of the larger workspace tabs. Scope: EditorNavigation and export-navigation.css. Baseline: work/gesso/export-button-baseline in the task workspace.


### 2026-10-21 — D140 — Floating export pair and a natural narrow-screen lockup

**Joined pair superseded by [D145](#2026-10-21--d145--export-joins-the-dark-editor-dice-remains-separate); narrow-screen lockup retained.** Export and dice form a floating pair, 4px above the editor. Retain their 36px height and 10px corners; move the pair up so Export's text shares the workspace labels' baseline. Reduce the space between buttons from 20px to 8px and bridge it with a rounded, tapered neck. A single SVG surface supplies the join and a quiet warm/cool gradient that fades in over 180ms on hover or keyboard focus. The two native buttons retain separate actions; the join does not activate either. Reduced motion removes the fade. This supersedes D139's lower-edge alignment and D131's selected Export shoulder morph; both actions stay floating when Export is open.

The narrow-window notice now measures gesso + studio as one baseline-aligned lockup with an 8px gap. Its formerly absolute studio label overlapped the centered wordmark. Keep the desktop lockup unchanged. Scope: EditorNavigation, export-navigation.css, narrow-screen styles. Baseline: work/gesso/floating-actions-baseline in the task workspace. Verification: navigation interaction tests and production build pass; browser checks cover the floating geometry, hover fade and the narrow-screen notice.


### 2026-10-21 — D141 — Scroll inside the About window

**In code.** Keep the About frame stationary and scroll its content inside the shared contour. The old full-page scroll moved the clip host; JavaScript corrected its position a frame later, letting content briefly escape the border. A fixed-height frame and native inner scrollport remove that correction. Preserve the navbar, halo, copy, grid and shared route transitions.

This supersedes D114's full-page scroll hit area: the content scrolls when the pointer is inside the window, while the blue margin stays still. No wheel interception. Scope: AboutPage and about.css. Baseline: work/gesso/about-scroll-clip-baseline in the task workspace. Verification: production build passes; desktop and narrow-screen scrolling stay clipped, keyboard End reaches the footer, and the About anchor returns to the title with the frame still fixed.


### 2026-10-21 — D142 — Stage layers use the same fixed row as Product

**In code.** Environment / Objects / Lighting sit above the Stage preview, using the same Halyard row and Option/Alt 5–7 annotations as Model / Materials / Decals. Remove the repeated Stage heading and three stacked cabinet selectors. Show one control body at a time; its controls scroll beneath the pinned preview and tabs. Keep the existing cabinet entrance and reduced-motion behavior.

Reason: environment, props and lighting are separate editing tasks; displaying all their headings in the control rail made them compete with the active task. Preserve the scene, selected object, selected light, right-side object editor and existing Environment / Props / Lights URL keys. Keyboard layer changes move focus to the corresponding fixed button before its previous controls disappear. This extends D118's Product layer row to Stage and replaces its stacked selectors.

Scope: EditorNavigation, App, WorldPanel, interface-system.css and condensed-editor.css. Baseline: work/gesso/stage-layer-tabs-baseline in the task workspace. Verification: 64 navigation/history/panel tests and production build pass. Browser checks cover all three layers, Option/Alt switching and focus, retained object/light selection, the object inspector, fixed tabs/preview during scrolling, and the 900px desktop boundary. No scene values were changed.


### 2026-10-21 — D143 — Choose Current or Random, then what can change

**In code.** Replace Export's source tabs with one Setup dropdown: Current / Random. Random reveals a second dropdown, Randomize, defaulting to Everything. It can target Stage, Lighting, Colors, Framing + shots, Camera movement or Materials individually; Custom allows combinations. Keep duration, screen size and shot count visible when framing can change. Move the allowed pools and material targets into Refine choices. Source and scope remain fixed above the scrolling options, with Generate at the bottom.

Everything opts all six categories and eligible product objects into the separate preview. This supersedes D137's Fill gaps default and per-category policy dropdowns. Selecting Random or changing an option does not generate, save or replace the original. Current restores it; changed settings require generating again before export. The existing engine still supports explicit Fill behavior for callers.

Add four authored palette presets: Neutral, Clay, Coastal and Orchid, with visible swatches. Seeded generation chooses a palette, a background color and different swatches for newly randomized finishes. Store the real linear color values in the shared preview/export scene and report the palette and hex values. Colors alone keeps existing materials; it does not recolor imported room textures. Material replacement can replace source texture artwork, while separately placed artwork and decals remain. Keep the source recoverable.

Scope: ExportSetupPanel, export-setup.css, randomSetup and their tests. Baseline: work/gesso/random-dropdown-baseline in the task workspace. Verification: 44 focused UI, generator and export-isolation checks pass, including Python export validation, deterministic palette choices, source immutability and category isolation; production build passes. Browser checks cover Everything generation, palette choices, custom Stage + Colors with the original finish, and Current restoring the original lamp and room. No final render or campaign save was submitted.


### 2026-10-21 — D144 — Choose camera movement before framing

**In code.** Selecting Camera on the left exposes Still / Orbit / Push in at the pinned top of the right sidebar. Selected motion settings precede framing. Existing endpoint paths remain Custom until explicitly replaced; selecting the active preset preserves its parameters and keys. This supersedes [D136](#2026-10-21--d136--read-the-frame-edit-the-camera-in-one-place)'s closed camera Add motion library.

Still holds the evaluated image, including its lens, with a one-frame camera source. Retain disabled local curves and optics; mask inherited camera movement with a local zero-distance orbit understood by the existing sampler. Preset changes preserve the current view, reuse the local owner's timing and keys, and leave other scenes, shared motions and other targets intact. Bound Push in before the target/focus plane and validate the final state atomically.

Reason: camera movement is a primary composition choice, and Still must stop both endpoint and inherited motion. Scope: FilmWorkspace, cameraMotionPresets, CameraPanel, useFilmCamera, App and film-rails.css. Baseline: work/gesso/camera-motion-top-baseline. Verification: nine helper tests include Python validator/sampler parity for shared custom curves; browser checks cover camera switching and Undo restoring the source.


### 2026-10-21 — D145 — Export joins the dark editor; dice remains separate

**In code.** Export uses the editor's dark surface and control tokens. Its white inactive button becomes dark and joins the editor contour when selected. Keep dice as a separate transparent icon button; remove the connecting neck and gradient. Dice opens Setup: Random with Randomize: Everything, without generating or changing the source. Generate remains the explicit action.

Reason: output preparation belongs to the same editor, while dice and Export perform separate actions. This supersedes [D131](#2026-10-21--d131--export-becomes-an-editor-state)'s light surface and [D140](#2026-10-21--d140--floating-export-pair-and-a-natural-narrow-screen-lockup)'s joined floating pair. Preserve D143's candidate isolation, format controls, preview and export workflow. Scope: EditorNavigation, App, export-navigation.css, export-workspace.css, export.css and export-setup.css. Baseline: work/gesso/dark-export-baseline. Verification: browser checks confirm the dark workspace and dice opening Random / Everything without generation.


### 2026-10-21 — D146 — One studio entrance and one mobile navigation row

**In code.** The landing action is **“enter studio”** on white with orange text and arrow. Its helper reads exactly **“Set up your product once. Generate infinite worlds and content.”** Both the action and navigation resume the existing editor. This supersedes [D112](#2026-10-21--d112--explain-the-reusable-setup-on-the-cover)'s expanded copy and action; retain the footer line.

Mobile navigation distributes the visible links, including the home wordmark where present, across one row on Landing, About and Form + Light. Remove the second-baseline studio link. Keep desktop's seven-column grid, Halyard, the shared morph, loader and reel. The favicon is a perspective ellipse running from top left to bottom right, with light/dark contrast variants.

Reason: one action name identifies the same destination, and mobile links need equal spacing without a detached final action. Scope: LandingPage.tsx, landing.css, site-grid.css, web/index.html and web/public/favicon.svg. Baselines: work/gesso/cover-mobile-baseline and work/gesso/favicon-oval-baseline. Verification: desktop keyboard activation reveals the white/orange action and exact helper copy. At the browser's measured 355px mobile width, all links share one row with equal 24px gaps where the wordmark is present; Landing distributes its three links across the same margins. About and Form + Light have no horizontal overflow. The served HTML references the new SVG favicon. Scoped whitespace checks and the final production build pass.


### 2026-10-21 — D147 — Press the grid into the paper

**In code.** Replace the opening glassine treatment with a spherical grid pressed into the existing paper scan. Curved cells fill the aperture; grooves and compressed shoulders share one relief field. Paper fibers remain stationary. Small glints appear where that relief meets the moving light, with filtered highlights at smaller render sizes. Pointer movement changes illumination, not the sheet or grid.

Reason: the pattern should read as an impression in one material. This supersedes [D44](#d44--glassine-is-the-opening-material-study)'s broad iridescent treatment while retaining Estelle Kim's scan and adapted GlassineSurface renderer. Use the same renderer for the deterministic fallback capture. Preserve the shared aperture, pixel budget, offscreen pausing, reduced-motion policy and failure fallback. Scope: glassineRenderer.ts, GlassineStudy.tsx and glassine-still.jpg; baseline: work/gesso/glassine-grid-baseline.

Verification: browser checks confirm light response and clean WebGL logs. The 900 × 900 fallback was recaptured from the final renderer at light (0.68, 0.28), installed and documented in [asset provenance](../web/src/assets/gesso/ASSETS.md); temporary capture files were removed. Latest completed batch checks: 50 focused tests and the production build pass.


### 2026-10-21 — D148 — The mobile home mark is the perspective oval

**In code.** Use the diagonal oval from the favicon for the mobile home link on Landing, About and Form + Light. Reuse the SVG as a currentColor mask, so the page supplies white rather than the browser color scheme. Keep its native link, accessible name and focus ring. A 32px mark in a 32 × 40px link aligns with the single-row navigation; links keep equal gaps.

Reason: the smaller mark gives the mobile links more room and connects the browser tab to the page. Desktop keeps the wordmark; Landing keeps its central wordmark at every size. This extends D146's mobile header. Scope: site-grid.css and LandingPage.tsx. Baseline: work/gesso/mobile-oval-baseline in the task workspace. Verification: production build passes; mobile browser checks confirm the mark on all three pages, equal gaps without horizontal overflow and the home link returning to Landing.


### 2026-10-21 — D149 — Compare the X as an outline mark

**Exploration implemented; identity choice pending.** Add Logo study inside the curve editor at `/curves?study=logo`. Keep the production X contour and compare Fine / Balanced / Bold strokes at 1.5 / 2 / 2.5px when shown at 32px. Show matched large marks, real 16/24/32px samples, a wordmark pairing, browser-tab sample and reversed color. Balanced is the proposed starting point.

Reason: first establish whether the existing window can work as a mark. Holding shape and size fixed makes weight legible as the decision. Reuse `studio-cross`, its 64 cubic anchors and the shared path/transform functions; do not redraw the geometry. Ground and selection persist in the URL. Shortlist records a draft choice there, and Export SVG saves the selected editable outline. The live favicon, mobile oval and public pages remain unchanged while the choice is open.

Scope: LogoStudy.tsx, logo-study.css, main.tsx and the CurveDemo link. Baseline: work/gesso/logo-study-baseline in the task workspace. Verification: production build passes; browser checks cover selection, both grounds and URL shortlist state; the downloaded SVG contains 64 closed cubic segments, no fill and the selected stroke.


### 2026-10-21 — D150 — Compare a blob against the outlined X

**Exploration implemented; identity choice pending.** Add a Blob direction to Logo study alongside the existing X weights. Compare Soft X (four broad shoulders with shallow indentations) and Pebble (three broad curves), both outlined at 2px when shown at 32px. Keep the original X visible as a reference. Soft X is the proposed starting point because its contour retains a connection to the landing window.

Reason: test a less literal mark without changing stroke, scale or presentation at the same time. Both new contours use 64 cubic anchors, periodic curves with analytic tangents, and the shared frame bounds/path renderer. Keep selection, shortlist, grounds and SVG export in the existing study; no public identity change.

Scope: LogoStudy.tsx and logo-study.css. Baseline: work/gesso/blob-logo-baseline in the task workspace. Verification: production build passes; browser checks cover both contours, keyboard selection, reversed ground, URL state and a 400px layout without horizontal overflow. Exported Pebble SVG has 64 closed cubic segments and the selected stroke.


### 2026-10-21 — D151 — Return to the oval and its halo

Superseded by D152: the center is hollow, and the halo is circular.

**Exploration implemented; public identity unchanged.** Replace the two blob studies with one Halo oval direction. Reuse the favicon's 18:7.5 proportions and 45° diagonal through the shared circle/transform functions. Show a sharp filled oval over one broad blurred copy. Keep the solid silhouette at 16/24/32px. Existing X comparisons remain accessible. Old blob URLs resolve to the oval on Ink. This supersedes D150's blob proposal.

Reason: the circle seen in perspective already connects the favicon, mobile mark and studio loader. It can carry light without introducing another shape vocabulary. Use the shared contour-local halo bounds so the blur is not cut off; the exported SVG includes those full bounds. No animation loop or WebGL context is needed for this static study.

Scope: LogoStudy.tsx and logo-study.css. Baseline: work/gesso/halo-oval-logo-baseline in the task workspace. Verification: production build passes; browser verifies the old blob link resolves to Halo oval, responsive width has no overflow at 400px, and SVG export contains the 64-segment oval plus its measured halo region.


### 2026-10-21 — D152 — A hollow oval inside circular light

Superseded by D153: remove the separate outline and make the light opaque at the cutout.

**Exploration implemented; public identity unchanged.** Make the Halo oval contour 32% smaller, retain its 45° perspective, and leave the center transparent. The halo is circular and centered independently of the oval; mask its light out of the interior. Keep the ring open at 16/24/32px with a minimum one-pixel stroke. This supersedes D151's filled oval and contour-shaped glow.

Reason: the mark should read as an opening, while its surrounding light stays round. Reuse the 64-anchor geometry and shared halo bounds. The study and SVG export use the same ring, circle, blur and hollow-center mask. Scope: LogoStudy.tsx. Baseline: work/gesso/hollow-oval-baseline in the task workspace. Verification: production build passes; browser checks show the smaller open ring on Ink and Chalk, including small-size specimens. The exported SVG preserves the transparent center and complete circular filter bounds.


### 2026-10-21 — D153 — Cut the oval out of the halo

Superseded by D154: the halo follows the oval instead of a circle.

**Exploration implemented; public identity unchanged.** Remove the oval stroke. The smaller diagonal oval is a transparent hole in the light itself. Keep the inner edge fully opaque, then fade radially outward to a circular boundary. This supersedes D152's separate ring.

Reason: the edge belongs to the halo, not to an additional drawn outline. A masked SVG radial gradient supplies the opaque core and soft outside without a blur filter or render loop. Reuse the 64-anchor oval for the cutout and the same gradient in SVG export. Scope: LogoStudy.tsx. Baseline: work/gesso/halo-cutout-baseline in the task workspace. Verification: production build and browser visual check pass; the exported SVG has zero strokes, an opaque gradient core and the 64-segment transparent mask.


### 2026-10-21 — D154 — Keep the halo close to the oval

Applied to the website in D157.

**Exploration implemented; public identity unchanged.** Make the halo follow the oval, with 12% extra horizontal spread and a short outward fade. Retain the hollow center, opaque inner edge and absence of a separate stroke. This supersedes D153's large circular halo.

Reason: the light should describe the small oval rather than becoming a second dominant shape. Blur an expanded copy of the shared contour, strengthen its alpha at the inner edge, then cut out the original oval. Scope: LogoStudy.tsx; baseline: work/gesso/narrow-oval-halo-baseline. Verification: production build passes, browser proof shows the close halo, and SVG export has two 64-segment paths (mask and light), no strokes, and a 3-unit blur.


### 2026-10-21 — D155 — Compose editable interface crops for Form + light

Applied to the site in D158.

**In Figma; not applied to the site.** Create five separate window compositions from current editor controls: scene/camera/sequence, setup/export, parts/material, framing/timeline, and material/revision. Reuse the page's actual 64-anchor window masks. Rearrange related controls into distinct grids and crop peripheral content at the edges, while keeping each main decision readable.

Reason: the visuals should show the product's working controls in a composition suited to each window. Halyard text, fields, icons and control instances remain editable; only product and material renders are images. Original screens, copy and raw process are preserved. Target: section “09 / Form + light — interface compositions”, review frame 342:8486 in the gesso Figma file. Native source and repair scripts: work/gesso/form-light-visuals-plugin in the task workspace. Verification: five frames, 128 visible editable Halyard text nodes, 23 instances and 130 vectors; seven image layers contain product/material renders only. Final visual review checked masks, dropdown icons, title visibility and control spacing.


### 2026-10-21 — D156 — Give random reels a shot grammar

**In code.** Random framing starts with a full-product view and a close-up; two product shots is the minimum. Keep at least one full view and Close-up enabled, or explain the missing choice before generation. The remaining shots use the selected pool.

Reason: independent random choices could produce several similar views and no clear introduction to the object. Fit full views using the same 36mm vertical sensor as preview/export, with room for the camera move. Close-ups use a deliberate crop. Bounds include placement, static part edits and removed imported nodes.

Each generated camera shot has one movement owner. Hold the camera while an authored object, mechanism or light moves; remove the old camera endpoint path when generating a new move so an orbit cannot accidentally include a zoom. Use a 32° orbit or an 18% push, then sample the actual camera path. If the projected product edges travel less than 4% of an output dimension, or the camera crosses the near/focus plane, use a still shot rather than a tiny or clipped move.

Limits: Keep categories remain authored. Existing mixed product/light animation is retained and reported, not silently rewritten. Framing covers static product bounds and generated camera travel, not arbitrary authored object animation. The required close-up is geometric coverage, not automatic recognition of a useful product detail.

The candidate still shares one scene between preview and export; Current restores the original. Scope: randomSetup, randomSetupFraming, randomSetupMovement and ExportSetupPanel, with focused tests. Baseline: work/gesso/random-generation-rules-baseline in the task workspace. Verification: 64 tests and production build pass, including native exporter validation and Python part-transform parity. Browser checks cover generating the pair, missing-view recovery, both lamp views and restoration of Current. Final video rendering was not run; this machine reports Blender 5.1.1 while the exporter requires 4.3.2. The dev server remains on port 8787.


### 2026-10-21 — D157 — Apply the halo oval to the website

**In code.** Adopt D154’s hollow diagonal oval for the browser tab and mobile home link on Landing, About and Form + Light. Replace D146/D148’s filled oval. Keep the study’s 128 × 128 canvas, 3-unit blur, opaque inner edge and 12% sideways spread; the center stays transparent and there is no stroke. Desktop and centered landing wordmarks retain Halyard.

Reason: use the selected mark at its tested optical size. One SVG supplies adaptive light/dark browser color and a page-colored alpha mask for mobile navigation. Version the asset URL to replace cached icons. Logo study now identifies the oval as in use. Scope: favicon.svg, index.html, site-grid.css and LogoStudy.tsx. Baseline: work/gesso/website-halo-logo-baseline; exact vector export: work/gesso/export-website-logo.ts in the task workspace. Verification: production build passes; mobile browser review confirms the hollow mark, shared navigation and home-link return. The SVG retains two closed 64-anchor contours and no stroke. No animation loop is added.


### 2026-10-21 — D158 — Use the Figma compositions in Form + Light

**In code.** Replace the five editor screenshots with D155's editable Figma compositions: principles, result, product, interface and person. Export their rectangular content at 1.5×, center each image and let the existing website aperture crop it once. Keep the opening shader, page copy, shared frame renderer and motion.

Reason: the controls were composed for these windows in Figma; those edits should appear on the website. Static images retain that composition without adding renderers. Lossless WebP conversion preserves every exported pixel. Figma sources remain editable. Scope: philosophyScreenshots.ts, five editor-stills assets and asset provenance. Source content nodes: 342:8924, 342:9036, 342:9125, 342:9347 and 342:9459 in file yeSSVUrYYw45JLkN7mnv52. Baseline: work/gesso/figma-form-light-baseline in the task workspace.

Verification: all five images decode at their exported dimensions. Browser review covers every desktop composition and the mobile product view, with no horizontal overflow or console errors. The 1,406-test UI suite and production build pass.
