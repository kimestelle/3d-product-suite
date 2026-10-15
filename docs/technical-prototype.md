# Editable product films in generated worlds

Technical prototype and staged validation plan · 15 October 2026

## Visual target — watch campaign

*The referenced watch concept image was not supplied with the source document.*

A fictional skeleton watch in a stone architectural setting: a proposed visual target for product detail, contact, reflections, and spatial depth. This image was generated as concept art; it is not output from the proposed CAD/world-model pipeline and does not validate the mechanism. The bottle remains the simpler first test fixture; the watch is a later complexity benchmark.

## Decision to test

Can a brand designer turn supplied product assets into a short, editable product film, then revise it without returning to a CG specialist?

The proposed system combines an approved product, a generated environment, explicit movement controls, and repeatable rendering. World generation supplies the setting. CAD supplies product geometry. A scene model owns the relationship between them.

**Main rule: generate what is open to interpretation; preserve what has been approved.**

This is a proposed implementation, not a claim that the workflow already works. Pass criteria below are initial experiment targets, not measured results or industry benchmarks.

## First audience and specimen

Start with a brand designer at a small beauty or personal-care company. A packaging designer, supplier, or CG specialist supplies and initially prepares the product. The brand designer owns recurring campaign revisions. Interview both roles: accessibility for one person must not hide excessive preparation by another.

Use one fictional, rights-cleared rigid bottle with separate body, cap, and label artwork. Begin with opaque packaging; add a transparent glass version as a required second specimen before claiming suitability for fragrance campaigns. Glass is an integration stress test, not a detail to postpone indefinitely.

First deliverable: a 15-second, three-shot reel at 1080 × 1920, 24 fps, plus three stills and a reopenable scene. The three shots are reveal, cap opening, and final product frame.

Initial scope:

- One bottle on one explicit ledge or plinth.
- One confirmed cap movement; initially lift-off, then a screw-cap fixture with known thread travel.
- One generated room, one bounded camera path, and one supporting prop.
- Replaceable label and approved color variants.
- Desktop browser controls, with keyboard equivalents and numeric fields.

Defer squeezing, dispensing liquids, cloth, hands, arbitrary mechanisms, full CAD format coverage, and unrestricted relighting of generated worlds. Those are separate experiments.

## Architecture

```text
CAD / artwork / photos / specifications
                 │
      preparation + explicit approval
                 │
       immutable product revision ──────────────┐
                                              │
environment references → world generation     │
                              │               │
                    scale + geometry review   │
                              │               │
                              └── scene document
                                  product instances
                                  surfaces + props
                                  approved actions
                                  lights + cameras
                                  shots + timing
                                         │
                              evaluated scene at time t
                                  ┌──────┴──────┐
                              draft preview   final render
                                                   │
                                          frames → reel / stills
```

### Proposed stack

| Responsibility | First implementation | Why |
|---|---|---|
| Product preparation | Existing CAD exporter plus Blender; accept a prepared GLB initially | Avoid building a CAD importer before proving the workflow |
| Final rendering | Pinned Blender version with Cycles, controlled through Python | Explicit geometry, materials, camera, and frame output |
| Browser editor | TypeScript, React, Three.js | Direct object selection, handles, and draft playback |
| Splat experiment | Spark in the Three.js scene | Test navigable generated surroundings; not an assumed Cycles integration |
| World generation | Marble, initially through manual generation/export | Test output quality before automating an API workflow |
| Motion proposals | Geometric fitting and rules first; optional multimodal model second | Measure improvement against a simple, inspectable baseline |
| Storage | Versioned JSON manifests and local asset files | Sufficient for a single-user prototype |
| Render jobs | One local worker and durable job manifest | Resume failed work without deploying a queue service |
| Video assembly | FFmpeg from completed frame sequences | Exact duration, frame order, and channel dimensions |

Select and pin compatible tool versions when implementation starts. Do not automatically track latest releases.

### Two rendering paths to compare

**A — Mesh-based final scene, preferred if quality passes.** Import the generated visual mesh into Blender. Use clean, explicit geometry for contact surfaces and moving props. Treat generated appearance as potentially containing baked lighting; do not assume physically separated materials and illumination. Validate product reflections, shadows, and transmission.

**B — Generated surroundings as a rendered plate.** Render the world along a fixed camera path; render the exact product and near-field set separately with the same camera. Composite using appropriate masks and depth where available. Distant surroundings can supply an approximate environment map for reflections, but this does not reproduce close-range light transport. Transparent glass, occlusion, and moving reflections are gates for this path.

Choose one path after Phase 2. A splat visible in a browser is not evidence that it renders correctly in Cycles. Do not assume a plug-in preserves depth, transparency, reflections, or color management.

### Scene contract

Use immutable source assets and a small versioned scene document. Neither a prompt nor a generated video is the source of truth.

- Canonical units: meters; canonical coordinates: right-handed, Y-up. Record every import transform and explicitly convert to Blender's Z-up convention.
- Assign stable component IDs. Preserve the original assembly transform separately from the animated pose.
- Store axis and pivot in a declared component-local coordinate frame.
- Distinguish proposed actions from approved actions. Preserve evidence and manual corrections.
- Store exact world asset revisions, product revisions, camera settings, lights, shot timing, renderer version, and random seeds.
- Keep a minimal provenance record: asset source, reuse basis, owner, and allowed external-processing destinations. Permission to reuse is not automatically permission to upload confidential CAD to a vendor.

Illustrative action record—not a finalized schema:

```json
{
  "actionId": "cap-open-v1",
  "componentId": "cap",
  "relativeTo": "bottle-body",
  "type": "screw",
  "axisSpace": "component-local",
  "axis": [0, 1, 0],
  "pivotM": [0, 0, 0],
  "turns": 2,
  "axialTravelPerRevolutionM": 0.002,
  "directionSign": 1,
  "approval": "confirmed",
  "evidenceIds": ["fixture-spec-v1"]
}
```

Those numeric values belong to a synthetic test fixture, not an inferred real bottle. Screw lead means axial travel per revolution; it is not necessarily thread pitch for a multi-start thread. For normalized progress `u`, couple rotation and axial translation through the same `u`. Model the later lift-off as a separate segment after disengagement.

Evaluate motion from absolute time, not accumulated frame deltas. Scrubbing backward must produce the same pose as scrubbing forward. Browser and Blender adapters consume the same sampled transforms and camera data. They will not have identical shading: label the browser view as a draft and use Cycles stills for final appearance approval.

## Phase 0 — Establish the asset and human baseline

**Question:** Do target users actually have usable inputs, and where does preparation fall?

Collect the bottle assembly, dimension reference, label artwork, material photos, and a short video of the real mechanism. Record missing data. If no commercial asset is available, construct a fictional fixture and separately investigate access to real supplier assets.

Have a CG practitioner produce a reference still and short cap animation in their existing workflow. Use KeyShot if available; otherwise name the actual tool and avoid claiming a KeyShot comparison. Record hands-on time separately from waiting and rendering.

Track preparation, material assignment, rigging, scene construction, rendering, and revisions independently. Observe three brand designers and at least one asset preparer as an exploratory sample, not a market estimate.

**Gate:** an asset with documented reuse basis, independently selectable components, known dimensions, and an approved reference exists. Input acquisition and cleanup time are recorded.

**If it fails:** narrow the entry point to prepared 3D assets. Do not promise arbitrary CAD upload.

## Phase 1 — Render and animate the exact product

**Question:** Can a small deterministic scene preserve the product and produce an acceptable film?

Build a Blender scene with a neutral background, explicit plinth, fixed lighting, camera, and manually defined cap action. Create three shots and render a low-resolution reel before the final-resolution version. Use a single scene-generation script and manifest.

Validate import scale against the supplied dimensions. Check component transforms, seams, normals, label placement, material assignment, camera clipping, and cap/body intersections. Generate contact sheets of the complete sequence rather than judging one attractive frame.

**Deliverable:** approved product revision, manual action, reference renders, scene manifest, and a replayable 15-second reel.

**Gate:** no missing parts, label substitutions, or unintended component motion; cap follows the supplied mechanism. Reopening the scene reproduces transforms at sampled timestamps. Repeat renders on the same pinned environment remain visually equivalent within an agreed image tolerance; cross-hardware bit identity is not required.

**If it fails:** fix import or scene evaluation before introducing world generation or inference.

## Phase 2 — Put the product into a generated world

**Question:** Does world generation remove set-building work while retaining a convincing product?

Generate one environment from a reference image and a coarse layout. Treat unseen areas as generated interpretation, not a faithful reconstruction. Keep the exact product out of the world restyling process; use an empty placement region or proxy volume.

Compare three controlled conditions using the same product and shot:

1. A simple authored CG set: quality and effort baseline.
2. A generated visual mesh plus an explicit near-field ledge.
3. A splat/world plate plus the same explicit near-field ledge.

Apply provider scale metadata where supplied, then calibrate against a known reference dimension. Check axis conventions, floor alignment, camera intrinsics, clipping ranges, and occlusion. Do not use a coarse collider mesh as the visible luxury set.

Run five visual probes: stationary contact, slow lateral camera move, foreground occlusion, glossy reflection, and transparent glass. First match the existing world illumination. Test light-direction changes separately; baked highlights must not be presented as fully relightable materials.

Record generation attempts, credit cost, waiting time, cleanup time, and failed exports. Keep the first acceptable result as an immutable world revision.

**Gate:** at final resolution, the three-shot sequence has no obvious sliding contact, camera-dependent holes, disappearing props, or inconsistent product edges. A CG reviewer and a brand designer approve the opaque fixture; the glass probe determines whether fragrance is in scope. Initial efficiency target: at least 50% less hands-on environment preparation than the authored-set baseline, including cleanup.

**If it fails:** restrict camera travel, use generated surroundings only in the distance, or keep authored sets. If world cleanup consistently costs more than set construction, remove world generation from the first product.

## Phase 3 — Make the scene editable by a brand designer

**Question:** Can someone revise the working scene without knowing transforms or render settings?

Build a single browser view with the specimen dominant and a compact control rail. Provide product selection, approved label/color variants, environment selection, camera framing, and an open/closed action control. Add a simple shot strip and timing handles only after direct controls work.

The browser loads the exact asset revisions used by the render worker. It displays draft playback immediately and requests a final-render still for appearance checks. Integrate only the world representation that passed Phase 2; clearly identify any simplified preview.

Connect the scene through explicit relationships: `restsOn`, `relativeTo`, and camera `looksAt`. Initially these are deterministic placement/animation rules, not a general physics solver. A movable contact surface should carry the supported product predictably.

Every operation is an undoable document change. Show exactly what changes when a label or environment is replaced. Save the last approved revision independently from experiments.

**Gate:** three test users can change artwork, adjust cap timing, reframe a shot, undo a change, save, reopen, and request an export. Initial target: two of three complete the revision task in 10 minutes without coaching after a short introduction. Record every intervention rather than silently fixing their scenes.

Verify keyboard control, focus restoration, clear selection, numeric alternatives to drag handles, resize behavior, and non-autoplay/reduced-motion behavior. Demand-render when idle, pause offscreen, and test on a declared target laptop. Initial playback target: 30 fps at the selected draft resolution on that machine.

**If it fails:** simplify the supported actions and improve object-specific controls. Do not add a chat interface to hide unresolved scene behavior.

## Phase 4 — Propose movements from evidence

**Question:** Can assistance reduce setup time without silently inventing product mechanics?

Keep the manually approved rig as ground truth. Start with geometry: fit planes and cylinders, identify candidate coaxial components, and use assembly names as weak hints. Optional multimodal reasoning can interpret the supplied numbered diagram and selected video frames, returning a constrained proposal with cited evidence.

Use a currently available vision-capable model with structured output; select it through this experiment rather than assuming one provider wins. Compare geometry-only proposals with geometry-plus-visual-evidence proposals. No model training is necessary for this phase.

The proposal contains component IDs, action type, candidate axis/pivot, missing parameters, and evidence. Unknown lead, direction, or motion limits trigger a specific question. A model's self-reported confidence is not a calibrated probability. Require confirmation before using a proposed action in an approved shot.

Create ten held-out simple assemblies covering lift-off caps, screw caps, hinges, and sliders. Include an ambiguous coaxial pair and a deformable bottle where the correct response is to request evidence or decline the supported action. Avoid giving the inference system the ground-truth rig.

Measure action classification, axis angular error, pivot distance error, travel error, confirmation/correction time, and inappropriate confident proposals. For synthetic rigid fixtures, start with targets of ≤3° axis error and ≤1 mm pivot error; real tolerances must reflect each product's scale and clearance.

**Gate:** at least eight of ten proposals are usable after confirmation or a small correction, ambiguous cases request missing evidence, and median setup time falls by at least 50% relative to manual setup. Report raw case outcomes; ten cases do not establish general accuracy.

**If it fails:** ship explicit movement presets and assisted pivot picking. Do not make automatic mechanism understanding a dependency of the editor.

## Phase 5 — Turn a brief into editable shots and variants

**Question:** Can the system translate creative intent into useful scene changes while preserving approved product state?

Begin with three authored shot recipes. Each contains camera framing, light settings compatible with the chosen world, action timing, and an editable final frame. An optional language model selects and parameterizes recipes through a strict schema. It cannot emit arbitrary code or change protected assets.

Translate adjectives into a proposed change list: “slower opening” modifies duration; “closer” changes camera framing. “Dramatic” should expose its proposed lighting/framing changes before application. Unsupported requests leave the scene intact and explain the specific missing capability.

Produce 9:16 and 1:1 versions plus stills from the same product and action revisions. Recompose cameras for each aspect ratio instead of blindly cropping. Keep the source render and any later generative enhancement separate; enhancement that changes labels or geometry cannot replace the approved product render.

**Gate:** repeat the same brief from the same saved state and obtain the same validated scene operations. Users can inspect, edit, undo, and replay them. Artwork replacement updates all selected shots while approved geometry and movement remain unchanged.

**If it fails:** retain visible shot recipes and direct controls. Natural-language direction is an optional convenience.

## Phase 6 — Test the complete handoff and repeated use

**Question:** Does the workflow remove enough specialist work to earn repeat use?

Run a small pilot with three to five brand designers and at least two asset preparers. Each completes an initial film and then revisions on a later session: new artwork, another environment, altered movement timing, and a different aspect ratio. Use the same brief in their current workflow where practical, counterbalancing task order to reduce learning effects.

Include initial setup in the economics. A prepared scene that took two days to build should not be reported as a five-minute first film. Report initial creation and subsequent revision costs separately.

Exercise actual failure paths: missing texture, unsupported model, malformed action proposal, lost provider connection, failed generation, cancelled render, interrupted export, stale preview, and a replacement model whose component IDs changed. Never silently transfer an old rig to unmatched geometry.

Render jobs must record `queued`, `running`, `failed`, `cancelled`, and `succeeded` states, with completed frame ranges and retry history. Poll and reconcile uncertain provider operations before resubmitting; avoid duplicate paid generations. Validate all 360 frames for a 15-second, 24 fps export before encoding.

**Gate:** at least four of five users, or all three in a three-person pilot, complete routine revisions without specialist intervention; median active revision time is at least 50% below the observed baseline; reviewers accept product fidelity. This is directional pilot evidence, not statistical validation.

**Decision:** continue if repeated revisions are both independent and accurate. If only trained CG users succeed, target a studio productivity tool. If the scene handoff succeeds but world generation adds little, ship the handoff first.

## Experiment record and build discipline

For each run, retain:

```text
experiment ID / hypothesis / asset revisions / tool versions
input completeness / source permissions / preparation owner
hands-on minutes by stage / generation and render wait
generation attempts / provider cost / render cost
manual interventions / failed cases / rejected outputs
visual review / task completion / decision and next change
```

Implement only what the next gate requires. Phase 0 needs assets and observation; Phases 1–2 need scenes and scripts; Phase 3 earns the browser UI. API integration, automatic inference, and prompt-based direction follow evidence of value.

Do not build a general asset-management system, multi-provider orchestration platform, full timeline editor, or arbitrary physical simulator during this prototype. Retain source files and open exports so successful work remains recoverable if a provider or integration changes.

## Verified references and limits

Sources checked 15 October 2026. Vendor documentation establishes available interfaces; it does not validate our quality or usability targets.

- [Marble world generation and Chisel](https://www.worldlabs.ai/blog/marble-world-model): reference/layout-driven world generation and export. Imported objects can be restyled, which motivates keeping the approved product separate.
- [Marble mesh export](https://docs.worldlabs.ai/marble/export/mesh): collider and visual meshes have different purposes; reconstruction artifacts are expected in difficult regions.
- [World Labs documentation index](https://docs.worldlabs.ai/llms.txt): entry point for current API generation, operations, exports, pricing, and third-party scale metadata. Verify model names and export availability in the actual account before integration; this plan assumes no particular API-only export capability.
- [Spark documentation](https://sparkjs.dev/docs/): browser splat rendering with Three.js. Evaluate mixed mesh/splat behavior in the actual pinned version.
- [NVIDIA: integrating Marble worlds into simulation](https://developer.nvidia.com/blog/simulate-robotic-environments-faster-with-nvidia-isaac-sim-and-world-labs-marble/): demonstrates separate visual and collision representations plus explicit scene alignment. It does not establish luxury-rendering fidelity.
- [KeyShot part animation](https://manuals.keyshot.com/kss2026/en-us/manual/part-animations.html): baseline for manually authored movement and pivot controls.
- [KeyShot deformation support](https://manuals.keyshot.com/kss2026/en-us/manual/animation-types.html): distinguishes imported deformation animation from authoring it.

**First concrete build:** one manually rigged bottle and one repeatable camera move, rendered first on a neutral set and then in a generated room. Keep the exact product and camera fixed while changing only the environment method.
