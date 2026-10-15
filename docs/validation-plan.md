# Validation plan

This repository implements the first Phase 1 engineering milestone using the fictional opaque MORA fixture and an authored studio. Passing unit tests or rendering an MP4 does not pass the human, real-asset, world-generation, or usability gates in the [technical proposal](technical-prototype.md). Record actual evidence and reviewer decisions before claiming a gate passed.

## Checks for the current implementation

1. Run `python3.12 -m unittest discover -s tests -v` and `python3.12 -m compileall -q film scripts` on Python 3.12.14. Unit tests cover the scene contract, deterministic motion, and job behavior with local mocks where provided; they are not Cycles image comparisons.
2. Record OS/CPU, Python 3.12.14, Blender 4.3.2, FFmpeg 7.1.5, source digest, and render profile. Keep seed, camera, and light settings fixed. Verify `libx264`/PNG support. CI does not install or test these render tools.
3. Initialize and validate a fresh fixture, sample all frames, then render all 360 frames at 270 × 480 with 8 samples. A 144 × 256, 1-sample run is suitable for a small integration smoke check. Confirm 15-second duration, 24 fps, exact frame order, the three shots, all three stills, and the complete contact sheet.
4. Inspect the label, body, neck, cap, plinth contact, camera framing, and opening sequence. At minimum review frames 1, 120, 121, 130, 166, 203, 240, 241, and 360, plus the full reel and contact sheet. Check for missing parts, unintended motion, clipping, contact sliding, cap/body intersections after lift, and label legibility. Synthetic overlapping assembly surfaces are authored fixture geometry; resolve unacceptable artifacts rather than inferring mechanical correctness from them.
5. Reopen `scene.blend` in Blender 4.3.2. Compare object and camera transforms against `samples.json` at shot boundaries and before/during/after the lift. Convert canonical coordinates to Blender `(x, -z, y)` and quaternion basis before comparison. The optional `RUN_BLENDER_TESTS=1 python3.12 -m unittest discover -s tests -p test_blender_roundtrip.py -v` test builds/reopens the fixture and checks every integer frame: matrix/position/direction error below `1e-6`, focal-length error below `1e-4` mm. It does not render images. Record tolerances for any additional manual comparison; floating-point equality across adapters is not required.
6. Exercise cancellation, interruption, and recovery in a disposable draft job. Request cancellation from a second terminal, resume, and confirm earlier valid frames are retained. Interrupt a worker, resume, and inspect attempt reconciliation. Corrupt or remove one frame and resume; it must be rerendered. Try another scene/profile in the same output directory and confirm rejection. Retain job history and logs. Do not modify the immutable source snapshots of a job you intend to resume.
7. Render the native 1080 × 1920 profile after draft review. Verify all 360 PNGs, three stills, the contact sheet, and the encoded video. Check resolution, duration, and frame count using an independent media inspector. Reviewers must inspect the native output; draft acceptance does not establish final appearance.
8. Repeat representative stills on the same pinned environment and compare within a tolerance agreed before comparison. Record the metric, threshold, hardware, and result. Cross-hardware bit identity is not promised. Obtain separate CG and brand-design review; a technically complete export is not automatic visual approval.

The worker structurally validates PNGs and hashes final artifacts for recovery. These checks do not establish that each image contains the intended product, that the MP4 decodes correctly in a target player, or that rendering is visually equivalent; the integration and review steps above supply that evidence.

## Phase gates and current evidence

| Phase | Evidence needed before proceeding | Current scope |
| --- | --- | --- |
| 0: asset and human baseline | Rights-cleared real asset, separate components, known dimensions, approved reference; preparation and baseline time observed with three brand designers and at least one asset preparer | Synthetic provenance and dimensions only; no observed human baseline |
| 1: exact-product film | Approved real product and manual action; all-frame fidelity review; reopened transforms reproduce samples; repeat renders meet agreed image tolerance | Deterministic synthetic scene, local renderer and job recovery implemented; visual and real-product approval remain separate |
| 2: generated world | Compare authored set, generated visual mesh, and world plate with the same product/camera; contact, parallax, occlusion, gloss, and glass probes; CG and brand approval; initial target ≥50% less active environment preparation | No world API, mesh/splat import, or provider upload implemented |
| 3: designer editing | Three users perform label/timing/framing/undo/save/reopen/export tasks; initial target two of three finish in 10 minutes without coaching; keyboard/accessibility and declared-laptop playback checks | No browser editor implemented |
| 4: motion proposals | Ten held-out assemblies including ambiguous/unsupported cases; raw outcomes, corrections and setup time; initial target eight usable after confirmation/small correction, median setup time ≥50% lower | Manual confirmed actions only; no inference |
| 5: editable creative direction | Repeatable validated operations from saved state; inspect/edit/undo/replay; 9:16 and recomposed 1:1 exports preserve approved product/artwork | Three authored 9:16 shots only |
| 6: repeated handoff | Three-to-five designer pilot and at least two preparers, initial and later-session revisions, failure drills, raw fidelity and timing results; all three or four of five complete routine revisions independently | No pilot evidence collected |

The original targets are exploratory decision criteria, not measured outcomes or general accuracy claims. Transparent glass is required before claiming fragrance suitability. The authored opaque fixture cannot establish either generated-world integration or real CAD fidelity.

## Experiment record

Keep one record per run alongside immutable source revisions, manifests, logs, exports, reviewer notes, and rejected outputs. Separate hands-on preparation/revision time from generation/render waiting. Record failed attempts and interventions rather than reporting only the accepted result. Do not commit confidential source assets or provider credentials.

Suggested CSV header:

```csv
experiment_id,phase,hypothesis,product_revision,environment_revision,scene_sha256,python_version,blender_version,ffmpeg_version,hardware,render_profile,input_completeness,rights_basis,preparation_owner,preparation_active_min,revision_active_min,generation_wait_min,render_wait_min,generation_attempts,provider_cost,render_cost,manual_interventions,failed_cases,visual_review,task_completion,decision,next_change
```

Use empty values for unmeasured quantities and `not_applicable` for absent providers; do not substitute invented zeros. Link each review to its exact source digest, profile, and output directory. Keep the authored baseline when generated-world experiments begin so quality and effort comparisons remain controlled.
