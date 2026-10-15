# 3d-product-suite

A local, deterministic starting point for editable product films. This repository implements the first **Phase 1 engineering milestone** of the [technical prototype](docs/technical-prototype.md): a fictional opaque **MORA** bottle, a manually specified cap lift, three authored camera shots, and a resumable Blender/Cycles render worker.

The fixture produces a 15-second, 24 fps sequence: **360 frames**, with native final settings of **1080 × 1920**. A successful render exports an MP4, three stills, a contact sheet covering the sequence, and a reopenable `.blend` scene. Generated outputs are local and are not committed.

This is an experimental command-line prototype. It does not yet import CAD/GLB, generate worlds, offer a browser editor, infer mechanisms, or call a provider API. The sample is original synthetic geometry, not a prepared commercial asset or evidence of product fidelity. Human review and the later phase gates remain open; see the [validation plan](docs/validation-plan.md).

## Run from a source checkout

Use **Python 3.12.14**, **Blender 4.3.2**, and **FFmpeg 7.1.5** on Linux. The Python code uses only the standard library; there are no pip dependencies. Blender must support Cycles CPU rendering, and FFmpeg must include the `libx264` encoder and PNG support. Install these tools separately; the worker rejects different Blender or FFmpeg versions.

```bash
git clone https://github.com/kimestelle/3d-product-suite.git
cd 3d-product-suite
python3.12 --version
blender --version
ffmpeg -version

python3.12 -m film init work/mora.scene.json
python3.12 -m film validate work/mora.scene.json
python3.12 -m film sample work/mora.scene.json --output work/mora.samples.json
```

Run the commands from the repository root. `init` and `sample` refuse to overwrite their destination files. `validate` checks the supported scene contract and prints the canonical JSON SHA256; it does not inspect visual quality or establish asset permissions.

Render the complete reel at draft resolution first:

```bash
python3.12 -m film render work/mora.scene.json --output output/mora-draft \
  --width 270 --height 480 --samples 8
```

For a smaller smoke run, use `--width 144 --height 256 --samples 1`. Both profiles still render all 360 frames. Final rendering uses the source manifest's 1080 × 1920, 32-sample profile:

```bash
python3.12 -m film render work/mora.scene.json --output output/mora-final
```

CPU rendering may take substantial time. Resolution and sample overrides apply to the job profile without modifying the source scene. Use a separate output directory for each scene revision or render profile. Executables outside `PATH` can be supplied with `--blender /absolute/path/to/blender` and `--ffmpeg /absolute/path/to/ffmpeg` on `render` or `resume`.

## Inspect, cancel, and recover

The render command runs in the foreground. Use another terminal for status or cancellation:

```bash
python3.12 -m film status output/mora-draft
python3.12 -m film cancel output/mora-draft
python3.12 -m film resume output/mora-draft
```

Each job records `queued`, `running`, `failed`, `cancelled`, or `succeeded` state, completed frame ranges, attempts, errors, tool versions, and artifact hashes in `job.json`. The worker snapshots the validated source as `scene.json`, its deterministic evaluated poses as `samples.json`, and the renderer as `renderer.py`. Treat those snapshots as immutable: change your source manifest and create a new job for a revision. Resume also rejects a changed renderer implementation; use the original checkout or create a new job after a renderer update.

Cancellation requests stop the worker's current subprocess and preserve valid frames. `Ctrl+C` also stops the foreground worker; an abruptly killed process can leave a `running` record until resume reconciles it. Explicit `resume` starts a new attempt, clears the cancellation request, validates snapshots and existing PNG contents, and rerenders missing or corrupt frames. Only one worker can run a job at a time. This worker uses Linux file locking; other operating systems are not supported in this milestone.

Encoding begins only after the complete frame sequence passes structural PNG checks at the requested resolution. A complete job contains:

| Artifact | Purpose |
| --- | --- |
| `film.mp4` | H.264, 24 fps for the fixture, all 360 frames |
| `scene.blend` | Sampled transforms and camera, keyed at every integer frame |
| `still-01.png` … `still-03.png` | One midpoint still per fixture shot |
| `contact-sheet.png` | Thumbnails of the full sequence for review |
| `frames/000001.png` … | Verified render sequence retained for recovery |
| `scene.json`, `samples.json`, `job.json` | Source snapshot, sampled poses, durable job history |
| `renderer.py` | Hashed snapshot of the scene-generation adapter |
| `render-config.json` | Renderer settings and actual authored lighting |
| `blender.log`, `ffmpeg.log` | Subprocess output for diagnosis |

Read the logs after a failed attempt, fix the local tool/environment issue, then resume the same output directory. A succeeded job is returned unchanged only when the frame sequence and recorded deliverables still match their hashes. `status` prints the recorded manifest; resume performs reconciliation.

## Scene and motion contract

The scene document is the source of truth. It uses schema version 1, meters, right-handed **Y-up** coordinates, stable component IDs, and normalized **XYZW** quaternions. Original assembly transforms remain separate from evaluated poses. The Blender adapter maps positions `(x, y, z)` to `(x, -z, y)` and conjugates rotations by +90° about X; cylinder length is along canonical Y.

Motion is evaluated from absolute frame time, `t = (frame - 1) / fps`, with smoothstep progress. At 24 fps the final frame is sampled at 359/24 seconds; encoding 360 frames yields 15 seconds. Scrubbing order does not affect poses. The sampled transforms are world transforms, and the `.blend` uses constant interpolation between integer-frame samples.

Actions declare a normalized axis and pivot in the moving component's **original local frame**, an existing stationary `relativeTo` component, explicit timing, `approval: "confirmed"`, and evidence IDs present in the document. The fixture's 55 mm lift is manually authored and its evidence describes a synthetic mechanism. Screw actions couple axial travel per revolution with rotation; `directionSign` controls rotation direction. One action per component and stationary references are supported. Sequential disengagement/lift segments and moving parent hierarchies are not implemented.

`restsOn` validates the named plinth relationship; placement remains explicit numeric data rather than a contact or physics solver. Box/cylinder primitives and the authored environment are the supported geometry path. Labels are declared text using Blender 4.3.2's bundled Bfont on a separate synthetic label component, not imported artwork. The adapter uses a 36 mm vertical camera gate, fixed authored studio lighting, AgX, and Cycles CPU with a fixed seed and denoising disabled.

Product and environment revisions require provenance fields for source, reuse basis, owner, and allowed external-processing destinations. The fixture declares an empty destination list. This implementation makes no uploads, provider requests, or paid generations; provenance metadata is a record, not a legal-permission verifier. Confirm rights and destinations before adding real assets or external processing.

## Development and next decisions

```bash
python3.12 -m unittest discover -s tests -v
python3.12 -m compileall -q film scripts
```

CI runs standard-library tests on Python 3.12.14 without installing Blender or FFmpeg. Mocked worker tests exercise orchestration and recovery; they do not establish rendered visual quality. The optional real-Blender test builds and reopens the scene, comparing all 360 sampled poses without rendering images:

```bash
RUN_BLENDER_TESTS=1 python3.12 -m unittest discover -s tests -p test_blender_roundtrip.py -v
```

Set `BLENDER=/absolute/path/to/blender` if needed. Render integration and human approval are separate checks described in the [validation plan](docs/validation-plan.md).

The [original technical proposal](docs/technical-prototype.md) contains the staged experiments and their unmeasured targets. The next decision is whether the deterministic authored-set sequence passes visual and replay review. Real-asset preparation, opaque/glass world comparisons, the browser editor, assistance, and user pilots follow their respective gates.
