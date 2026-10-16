# Engineering verification

This record distinguishes engineering checks from visual approval, real-asset validation and observed user-study outcomes. Local fixture success does not pass those proposal gates.

## 16 October 2026 — milestones 2–3

The local browser editor, immutable world library, explicit near-field props, mesh import, Gaussian diagnostics and experimental Gaussian-to-mesh workflow are implemented. The requested final generated-world comparison uses the official visual GLB and a mesh reconstructed from the same world's Gaussian SPZ, alongside the authored baseline. No paid World Labs generation or mesh export was invoked for the local checks below. The first protected GitHub experiment is tracked separately at [run 38862464590](https://github.com/kimestelle/3d-product-suite/actions/runs/38862464590); at this record update it is in progress.

The environment uses Python 3.12.14, Blender 4.3.2 / Cycles CPU, FFmpeg 7.1.5, Node 24.19.0 and Spark 2.3.1. The optional reconstruction stack exercised locally is NumPy 2.3.5, SciPy 1.17.0 and scikit-image 0.25.2, installed in `.venv` and pinned in `requirements-worlds.txt`.

### Automated checks

```bash
RUN_BLENDER_TESTS=1 .venv/bin/python -m unittest discover -s tests -q
npm test --prefix web
node scripts/capture_splats.test.mjs
```

The Python command passed **159 tests in 14.640 seconds**, including **three real-Blender integrations** and **six numerical reconstruction tests**. The browser history suite passed **six Vitest tests**. The direct Node capture command passed **seven tests**.

The real-Blender checks build and reopen all 360 sampled poses, verify primitive metre dimensions, builtin typography and initial plinth contact, and preserve exact product/camera transforms. A visual GLB with nonidentity scale, rotation and translation retains the expected world bounds while leaving the exact product, plinth and explicit foreground prop unchanged. The glass probe retains its declared transmission and IOR. Plate checks reject missing manifests and wrong resolution, verify frame membership/hashes and reproduce the correct distant frame after native-scene reopening.

The numerical checks compare an anisotropic Gaussian isosurface with its analytic dimensions and outward normals, exercise quaternion covariance and Z-up conversion, verify spatial colour transfer and threshold-dependent surfaces, enforce bounded room-fixture grids, and decode a real Spark-written SPZ before producing repeatable mesh hashes. Provider/orchestration tests use fake transports and consume no API credits.

### Local world and render checks

Original synthetic room geometry produced matching-source GLB and Gaussian PLY fixtures. Spark wrote and decoded actual SPZ files from that fixture; the SPZ v3 source then passed the local density-isosurface conversion, immutable visual-world import and pinned Blender rendering path. The resulting mesh is self-contained and vertex-coloured, and its saved Blender scene rendered a small portrait still with the exact bottle/plinth intact. This checks the full **synthetic SPZ → reconstructed GLB → Blender** path, rather than substituting a collider or triangulating Gaussian centres.

A separate actual Spark Gaussian capture at **frame 180, 270 × 480** passed through the camera-matched plate manifest boundary and succeeded as a Blender still. This is a diagnostic native-Gaussian path; it is separate from the final mesh comparison and does not establish native Cycles splat depth, reflections, refraction or glass transport.

Studio, Gallery and Botanical room provide offline authored defaults. Their original assets, hashes and provenance are available without provider keys. Import/render checks on these fixtures do not measure generated-world or reference-image fidelity.

### Browser and smoke-render checks

Browser checks confirmed paused startup, undo/redo, saves, the separate approved-revision pointer, restoring saved/approved state and timeline scrubbing. These checks exercise document/revision behavior; clicking the approval control is not a CG or brand appearance approval.

The real Playwright smoke check passed paused startup, undo/redo, save/approval/restore, scrubbing, offline Gallery/Botanical choices, image-reference controls, native Gaussian preview and mobile overflow checks. It requested a Gallery Cycles still through the editor and verified a successful job with downloadable `still.png` and `scene.blend` artifacts (job `15a9382960dc4f63911c8e9337ed4415`, 540 × 960, 32 samples). Packaged Open Sans fonts load before canvas artwork measurement; no third-party font service is required.

Run `PLAYWRIGHT_BROWSERS_PATH=/path/to/playwright-browsers node web/tests/editor-smoke.mjs` with a server on port 8789, or set `PRODUCT_SUITE_URL` to its loopback origin. This check creates a local verification campaign and performs one local Blender still render; it never clicks paid generation.

### Open quality and human gates

No real World Labs image-guided world has yet been generated or compared in this verification. The official HQ mesh and reconstructed Gaussian mesh require independent axis, scale and ground review before a calibrated same-world comparison. Reconstruction remains a threshold-dependent approximation: finite voxels can lose thin structures, broaden surfaces or create holes, and rough SH0 vertex colours do not preserve trained view-dependent appearance or physical materials.

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
