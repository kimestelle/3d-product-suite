# Engineering verification

This record distinguishes engineering checks from visual approval, real-asset validation and observed user-study outcomes. Local fixture success does not pass those proposal gates.

## 16 October 2026 — current A/B engineering record

The API and browser now support saved world calibration, locked A/B comparison and paired render exports. Both sides share the exact product, actions, sampled cameras, render settings, explicit plinth/props and ambient colour. Calibration records raw-GLB floor/measurement picks, metric scale and yaw adjustments. Saved placement review becomes draft when world alignment, contact geometry, product geometry/assembly, actions or time sampling change; camera framing and ambient edits are tracked separately by the shared scene digest.

The official HQ visual mesh has now been downloaded through [recovery run 38864636256](https://github.com/kimestelle/3d-product-suite/actions/runs/38864636256) and is available alongside the mesh reconstructed from the same world's Gaussian SPZ. The earlier unavailability and recovery-in-progress statements below describe historical checkpoints.

The actual Nessino A/B scene uses these two representations of world `f5a9a297-e44e-4c16-9f2b-0e069e444dd8`. It remains **draft and unreviewed**. Its initial placement fits a selected floor surface near the product origin to the shared plinth underside and retains a provider-scale hypothesis. No independent room dimension has established metric agreement between representations, and this world was generated without a reference image. These initial settings do not establish photographic fidelity, correct room scale or appearance approval.

Current checks passed:

- **220 Python tests**, including **six real-Blender integrations**; **43 Vitest tests**; **seven direct Node tests**; production browser build.
- Real paired still `60218636e88f419ba4dc8ac7199e8595`: both sides succeeded at **frame 241, 360 × 640, 16 samples per pixel**.
- The Playwright comparison smoke check passed **nine real-browser flows**, including paired export through the UI. Both children of pair `c3fea0ab797e447499a0a48ea1374823` succeeded at **180 × 320, four samples per pixel**.
- Real paired reel `34082398783f4d68b030c4a0eaf856b7` succeeded for a deliberately shortened **six-frame** timeline spanning all three cameras, at **180 × 320, four samples per pixel**. FFprobe confirmed six frames at 24 fps in both MP4s. Both still/reel ZIPs passed member hashes, matching frame/profile/renderer checks and archive validation.

These checks establish engineering behavior and available outputs. The six-frame reel is an encoder/integration smoke check; a full 360-frame generated-world pair was not rendered in this check. CG/brand approval, independent world calibration, reference-image comparison, final-resolution sequences and observed designer usability remain open.

## 16 October 2026 — earlier milestones 2–3 checkpoint (historical)

This dated checkpoint is preserved as recorded. Its provider-availability status, test counts and pending-recovery statements are superseded by the current record above.

The local browser editor, immutable world library, explicit near-field props, mesh import, Gaussian diagnostics and experimental Gaussian-to-mesh workflow are implemented. The requested final generated-world comparison uses the official visual GLB and a mesh reconstructed from the same world's Gaussian SPZ, alongside the authored baseline. No paid World Labs generation or mesh export was invoked for the local checks below. The first protected GitHub experiment is tracked at [run 38862464590](https://github.com/kimestelle/3d-product-suite/actions/runs/38862464590). It generated world `f5a9a297-e44e-4c16-9f2b-0e069e444dd8` for 1,580 settled credits and accepted one HQ mesh export. The first export status read returned HTTP 404; durable IDs and receipts were preserved. The recovery implementation now reads the same world’s requested visual mesh when an export operation is unavailable, with no POST retry and unknown export settlement until confirmed.

The environment uses Python 3.12.14, Blender 4.3.2 / Cycles CPU, FFmpeg 7.1.5, Node 24.19.0 and Spark 2.3.1. The optional reconstruction stack exercised locally is NumPy 2.3.5, SciPy 1.17.0 and scikit-image 0.25.2, installed in `.venv` and pinned in `requirements-worlds.txt`.

### Automated checks

```bash
RUN_BLENDER_TESTS=1 .venv/bin/python -m unittest discover -s tests -q
npm test --prefix web
node scripts/capture_splats.test.mjs
```

The Python command passed **167 tests in 13.083 seconds**, including **three real-Blender integrations** and **six numerical reconstruction tests**. The browser history suite passed **six Vitest tests**. The direct Node capture command passed **seven tests**.

The real-Blender checks build and reopen all 360 sampled poses, verify primitive metre dimensions, builtin typography and initial plinth contact, and preserve exact product/camera transforms. A visual GLB with nonidentity scale, rotation and translation retains the expected world bounds while leaving the exact product, plinth and explicit foreground prop unchanged. The glass probe retains its declared transmission and IOR. Plate checks reject missing manifests and wrong resolution, verify frame membership/hashes and reproduce the correct distant frame after native-scene reopening.

The numerical checks compare an anisotropic Gaussian isosurface with its analytic dimensions and outward normals, exercise quaternion covariance and Z-up conversion, verify spatial colour transfer and threshold-dependent surfaces, enforce bounded room-fixture grids, and decode a real Spark-written SPZ before producing repeatable mesh hashes. Provider/orchestration tests use fake transports and consume no API credits. Added regressions cover terminal POST receipts, saved terminal recovery, a bounded generation-404 visibility window, and read-only mesh-404 recovery without a duplicate paid POST.

### Local world and render checks

Original synthetic room geometry produced matching-source GLB and Gaussian PLY fixtures. Spark wrote and decoded actual SPZ files from that fixture; the SPZ v3 source then passed the local density-isosurface conversion, immutable visual-world import and pinned Blender rendering path. The resulting mesh is self-contained and vertex-coloured, and its saved Blender scene rendered a small portrait still with the exact bottle/plinth intact. This checks the full **synthetic SPZ → reconstructed GLB → Blender** path, rather than substituting a collider or triangulating Gaussian centres.

A separate actual Spark Gaussian capture at **frame 180, 270 × 480** passed through the camera-matched plate manifest boundary and succeeded as a Blender still. This is a diagnostic native-Gaussian path; it is separate from the final mesh comparison and does not establish native Cycles splat depth, reflections, refraction or glass transport.

Studio, Gallery and Botanical room provide offline authored defaults. Their original assets, hashes and provenance are available without provider keys. Import/render checks on these fixtures do not measure generated-world or reference-image fidelity.

The real Botanical world’s 500k SPZ also completed **SPZ → GLB → Blender** locally: 482,613 opacity-eligible splats, 100,000 selected for reconstruction, a 95 × 93 × 96 density grid, 69,097 vertices and 138,274 triangles. Conversion took 5.587 seconds and produced a 4,149,244-byte GLB (SHA256 `4313016cbf530e0182ace6858e2a69b15c00bfa015659207d1e3f480f9adc8c9`). Both provider-alignment and adjusted-preview frame-1 stills completed at 270 × 480 / 8 samples.

This real fixture exposes an important quality limit: at the product origin, the coarse density surface makes the floor approximately 0.327 m thick and initially intersects the bottle. A separate preview revision translates only the reconstructed environment down 0.2318435282 m, placing its measured upper floor surface at the explicit plinth bottom (−0.07 m). Original source alignment, product, shots, actions and placement remain unchanged. This is a preview placement correction, not a geometry repair, official-mesh calibration, or appearance approval.

[Recovery run 38864636256](https://github.com/kimestelle/3d-product-suite/actions/runs/38864636256) continues using the existing world and accepted mesh operation, with zero new paid operations planned. At this record update the official HQ mesh is still unavailable; the documented provider export allowance is up to one hour. A fidelity winner has not been measured.

### Browser and smoke-render checks

Browser checks confirmed paused startup, undo/redo, saves, the separate approved-revision pointer, restoring saved/approved state and timeline scrubbing. These checks exercise document/revision behavior; clicking the approval control is not a CG or brand appearance approval.

The real Playwright smoke check passed paused startup, undo/redo, save/approval/restore, scrubbing, offline Gallery/Botanical choices, image-reference controls, native Gaussian preview and mobile overflow checks. It requested a Gallery Cycles still through the editor and verified a successful job with downloadable `still.png` and `scene.blend` artifacts (job `15a9382960dc4f63911c8e9337ed4415`, 540 × 960, 32 samples). Packaged Open Sans fonts load before canvas artwork measurement; no third-party font service is required.

Run `PLAYWRIGHT_BROWSERS_PATH=/path/to/playwright-browsers node web/tests/editor-smoke.mjs` with a server on port 8789, or set `PRODUCT_SUITE_URL` to its loopback origin. A focused browser check also simulated an unavailable GitHub service and verified that the error remains visible while both local render controls stay enabled.

This check creates a local verification campaign and performs one local Blender still render; it never clicks paid generation.

### Open quality and human gates

No image-guided world has yet been compared in this verification. The first real generated world uses the Botanical preset without a reference image; its paired export is undergoing recovery. The official HQ mesh and reconstructed Gaussian mesh require independent axis, scale and ground review before a calibrated same-world comparison. Reconstruction remains a threshold-dependent approximation: finite voxels can lose thin structures, broaden surfaces or create holes, and rough SH0 vertex colours do not preserve trained view-dependent appearance or physical materials.

CG/brand approval, real product preparation and rights validation, hollow glass/contents fidelity, final-resolution generated-world sequences, preparation-time economics, declared-laptop performance, comprehensive accessibility review and the three-user uncoached editing target remain open. No trained assistance model or user pilot is claimed.

## 15 October 2026 — foundation record

The following evidence describes the earlier synthetic authored-set build. Subsequent editor/world integration evidence appears above; the original render results remain historical and are not replaced by later code changes.

Environment: Python 3.12.14, Blender 4.3.2 / Cycles CPU, FFmpeg 7.1.5. The adapter uses Blender's builtin Bfont, AgX, a 36 mm vertical camera gate, fixed studio lights, a fixed random seed, and no optional denoiser.

### Automated checks

`RUN_BLENDER_TESTS=1 python3 -m unittest discover -s tests -v` passed all **54 tests**, including the real Blender integration test. That test builds and reopens the full scene, then independently checks all 360 component poses, camera positions/directions/lenses, constant interpolation, primitive dimensions in meters, builtin typography, and initial plinth contact.

The unit checks cover absolute-time scrubbing, component-local axes/pivots, screw lead/rotation coupling, approval and evidence rejection, stale component IDs, camera-path validity, scene and renderer immutability, cancellation, partial failures, corrupt PNGs, single-worker locking, and stale exports. A real subprocess test kills a worker and verifies its child retains the job lock. Edited Blender files and changed valid PNGs trigger reconstruction; frame changes during encoding prevent success. Python compilation and fixture validation also passed.

### Render checks

The full review job uses 270 × 480, 8 samples per pixel, 24 fps, and all 360 frames. This is a noisy engineering draft; it is not the final 1080 × 1920 reel or an appearance approval.

The job succeeded with all 360 verified frame hashes, an MP4, a reopenable Blender scene, three draft stills, and a full-sequence contact sheet. FFprobe independently confirmed 270 × 480, 24/1 fps, 360 decoded frames, and exactly 15.000000 seconds. Reopening the successful job left it unchanged after rechecking its source snapshots and artifact hashes.

An actual cancellation stopped this job after 72 complete frames. Resume retained those frames. A further restart exercised the final recovery implementation; the manifest records two cancelled attempts and one successful attempt. A separately rerendered frame 1 had identical decoded RGB pixels on this same machine (raw-pixel MD5 `306e84e8241ff78c827504df37af8d0c`). The PNG file hashes differ because the encoder includes metadata; no cross-hardware bit-identity claim is made.

Three separate portrait review stills use 1080 × 1920 and 128 samples per pixel. They use the same scene and camera samples at frames 60, 180, and 300.

The generated files remain outside Git. The source checkout preserves the scene manifest, renderer, worker, tests, and exact commands needed to reproduce them. Run the draft command in README to produce your own local artifacts.

### Open validation at the foundation checkpoint

No CG reviewer or brand designer had approved these foundation renders. The native-resolution full reel, approved real product inputs, glass specimen, generated environment comparison, laptop playback performance, preparation economics and user pilot were unmeasured. Provider integrations and the browser editor were outside this October 15 checkpoint; their later engineering checks are recorded in the October 16 section, without asserting quality or user-study approval.
