# Edit, proof, export

The browser preview keeps ordinary edits responsive; a native proof answers how the current view renders with Cycles. Both use the same canonical scene and sampled transforms. A proof is temporary output, not a saved campaign or a camera edit.

## In the editor

- Change surface values, lights, placement or camera settings without decoding unchanged product/world assets again. Geometry, texture sources, material bindings and unsupported new fields trigger a full resource rebuild. Authoritative scene validation still owns export readiness.
- In a paused Stage, Film or Export view, choose **Render proof**. The request binds the current scene digest, frame, last drawn camera, depth of field and view aspect. The native image replaces the preview only after it decodes at the requested dimensions.
- **Auto proof** is opt-in. Settled edits coalesce for 650 ms; camera gestures must finish first. New work supersedes earlier requests. Hidden tabs stop requesting. Changing campaign clears the retained image.
- **Back to preview** resumes the live renderer. After an edit, **Earlier proof** can show the previous good image with its earlier label. A failed replacement retains that image; it cannot become a current proof.
- Apply or discard material, transform and cleanup drafts before requesting a proof. Show hidden product parts first. Paired comparisons use Export. A static frontend without a connected backend disables native proof controls.

Proofs use a maximum 960 px edge and 32 samples in the UI. The caption records frame, dimensions and samples. They are actual native renders at that budget, not final-resolution certification. Export keeps its own resolution, sample count and saved scene. Browser preview snapshots remain explicitly browser-shaded output.

## Native work

A pinned Blender process can retain a verified scene between camera, lighting and grading revisions. Material, geometry and unknown dependency changes rebuild the native scene. Proof construction and rendering use `scripts/blender_scene.py`, the export adapter. The previous scene is released before an export takes the workspace GPU.

Proofs have priority at completed-frame checkpoints. An export finishes its current frame, publishes and verifies its raw-frame receipt, releases the GPU, then resumes its remaining frames. Three consecutive proof leases give a waiting export its turn. Cancellation, process failure and changed source files cannot publish an earlier request as current output.

Gaussian proofs capture the canonical source from the requested camera before native compositing. This retains the existing Gaussian plate model: it does not make splats into relightable geometry or supply missing reflected surfaces. Original world assets and saved campaign revisions remain unchanged.

## Reuse without a render-quality change

The optional `verified-raw-master-v1` cache holds ungraded PNG masters for sibling jobs. A new job first builds its own native scene and establishes the actual execution receipt. Reuse requires matching physical source/asset hashes, evaluated frame poses and optics, frame index, resolution, seed, samples, Blender executable SHA, adapter/helper hashes, device/runtime and denoiser settings.

Grading, encoding and unchanged editorial frames can reuse a matching raw master. Renumbered frames, changed physical inputs or a different backend render again. Gaussian master reuse is disabled. There is no per-object pixel reuse. Finishing and final artifact ownership stay with the new job.

The cache defaults to 256 MiB. Full, corrupt, changed or unsafe entries fall back to native rendering. It does not evict original assets, saved scenes or earlier exports. Temporary proof storage is separately bounded; copied assets count toward that budget.

## Checked locally, 2026-11-04

- A pinned Blender 4.3.2 CPU proof at 108 × 192 and 8 samples took 1.67 s cold and 0.325 s warm in one local fixture run. Warm and fresh rebuilt RGB pixels matched exactly. This small case does not predict a full-resolution film or cloud GPU latency.
- Three Auden frames at 96 × 160 and 16 samples reused all raw masters after a grade change. Every finished PNG hash matched a fresh uncached grade render. That small run took 5.60 s with reuse versus 6.59 s without; rebuilding/packing the native scene still dominated.
- A real three-frame native export yielded after its first completed frame, resumed frames two and three, rendered each once and matched uninterrupted output hashes.

Implementation: `web/src/viewport.ts`, `viewportUpdate.ts`, `NativeProofOverlay.tsx`, `nativeProof.ts`, `film/proofs.py`, `proof_inputs.py`, `render_arbitration.py`, `render_reuse.py`, `jobs.py` and `scripts/blender_proof_worker.py`. Local performance receipts live under ignored `workspace-data/performance/2026-11-04-loop/`; they are not bundled with the public frontend.
