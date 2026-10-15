# Engineering verification — 15 October 2026

This record describes the synthetic authored-set build. It does not pass the visual, real-asset, world-generation, or user-study gates in the proposal.

Environment: Python 3.12.14, Blender 4.3.2 / Cycles CPU, FFmpeg 7.1.5. The adapter uses Blender's builtin Bfont, AgX, a 36 mm vertical camera gate, fixed studio lights, a fixed random seed, and no optional denoiser.

## Automated checks

`RUN_BLENDER_TESTS=1 python3 -m unittest discover -s tests -v` passed all **54 tests**, including the real Blender integration test. That test builds and reopens the full scene, then independently checks all 360 component poses, camera positions/directions/lenses, constant interpolation, primitive dimensions in meters, builtin typography, and initial plinth contact.

The unit checks cover absolute-time scrubbing, component-local axes/pivots, screw lead/rotation coupling, approval and evidence rejection, stale component IDs, camera-path validity, scene and renderer immutability, cancellation, partial failures, corrupt PNGs, single-worker locking, and stale exports. A real subprocess test kills a worker and verifies its child retains the job lock. Edited Blender files and changed valid PNGs trigger reconstruction; frame changes during encoding prevent success. Python compilation and fixture validation also passed.

## Render checks

The full review job uses 270 × 480, 8 samples per pixel, 24 fps, and all 360 frames. This is a noisy engineering draft; it is not the final 1080 × 1920 reel or an appearance approval.

The job succeeded with all 360 verified frame hashes, an MP4, a reopenable Blender scene, three draft stills, and a full-sequence contact sheet. FFprobe independently confirmed 270 × 480, 24/1 fps, 360 decoded frames, and exactly 15.000000 seconds. Reopening the successful job left it unchanged after rechecking its source snapshots and artifact hashes.

An actual cancellation stopped this job after 72 complete frames. Resume retained those frames. A further restart exercised the final recovery implementation; the manifest records two cancelled attempts and one successful attempt. A separately rerendered frame 1 had identical decoded RGB pixels on this same machine (raw-pixel MD5 `306e84e8241ff78c827504df37af8d0c`). The PNG file hashes differ because the encoder includes metadata; no cross-hardware bit-identity claim is made.

Three separate portrait review stills use 1080 × 1920 and 128 samples per pixel. They use the same scene and camera samples at frames 60, 180, and 300.

The generated files remain outside Git. The source checkout preserves the scene manifest, renderer, worker, tests, and exact commands needed to reproduce them. Run the draft command in README to produce your own local artifacts.

## Open validation

No CG reviewer or brand designer has approved these renders. The native-resolution full reel, approved real product inputs, glass specimen, generated environment comparison, laptop playback performance, preparation economics, and user pilot remain unmeasured. There are no provider integrations, world exports, trained models, or browser editor in this milestone.
