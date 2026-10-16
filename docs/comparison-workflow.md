# Compare two environments

The editor's A/B comparison keeps a single product, timeline, camera path, render profile, explicit studio lights, ambient world color, contact plinth and foreground props. Only the imported environment changes between A and B. The separate engineering `compare` command still prepares the five-probe test scenes; the interactive workflow works within one saved project.

## Set up and align

Open the World controls and enable comparison. Select a mesh environment for each side. A known World Labs pair must refer to the same provider world; manually imported and offline environments can be compared without claiming shared provider lineage.

Use the A, B and Split views with the common timeline. Camera and product edits affect both conditions. Alignment is saved in the project and participates in undo, redo and revision history.

For each side, a floor pick identifies a surface in the imported environment. Applying it adjusts the environment's vertical placement to the bottom of the shared contact plinth. A known-distance measurement between two picked points can set meters per source unit. A yaw adjustment rotates the environment around the common vertical axis. These operations leave the product and cameras unchanged.

Measurements need an independently known real distance. Generated geometry and inferred provider units alone do not establish physical accuracy. Uneven reconstructed floors can retain local intersections after an origin placement adjustment.

Review the scale and floor placement, then mark the placement reviewed. Changing an environment transform, shared contact geometry, product geometry or pose, or sampled product motion makes that review stale. Camera framing and ambient colour remain shared but do not invalidate spatial placement review. Inspect camera clearance and final appearance separately.

## Render matching views

The paired still export uses the same absolute frame, dimensions, samples and random seed for both sides. The reel export uses the same complete sampled timeline. Both child jobs are prepared before either is queued, and their source revisions are immutable.

The paired job shows progress and errors for both conditions. Cancelling stops both unfinished jobs. Resuming keeps successful output and resumes the unsuccessful condition from its pinned source. A completed pair offers the two outputs, a comparison manifest and a ZIP containing the matching renders and manifest. Draft alignment can be exported, and its status is recorded.

All comparison work is local. It does not submit a new World Labs generation or export, and it does not require another API key or reference image. Provider generation remains a separate action in the World controls.

## Real Nessino trial

The private trial uses the recovered Botanical world in two forms: the official textured GLB and the GLB reconstructed from its Gaussian SPZ. Both trace to world `f5a9a297-e44e-4c16-9f2b-0e069e444dd8`. The public repository contains the implementation and offline defaults; private product/provider assets are delivered separately.

The HQ preview borrows a provisional scale from the same world's Gaussian metadata and uses a floor placement fitted to a ray intersection. The Gaussian mesh has a coarser floor surface. These starting transforms remain drafts until reviewed; no independently verified room dimension has been provided. The lamp retains its measured CAD geometry and approximate orange material.

To run the browser integration check against a built server, use `PLAYWRIGHT_BROWSERS_PATH=/path/to/playwright-browsers node web/tests/comparison-smoke.mjs`. `PRODUCT_SUITE_URL` selects the loopback origin and optional `PRODUCT_SUITE_PROJECT` selects an existing project to duplicate. The check creates a separate verification campaign, exercises picking and revision controls, and requests two bounded 180 × 320 / 4-sample local stills. It never invokes provider generation.
