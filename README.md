# 3d-product-suite

A local editor and repeatable render pipeline for editable product films. Import prepared product GLBs or OBJ/STL/PLY meshes, or explore the fictional **MORA** bottle fixture with its confirmed cap movement and label/color controls. Shared Python scene evaluation drives both browser playback and Blender/Cycles.

The fixture produces a 15-second, 24 fps sequence: **360 frames**, with native final settings of **1080 × 1920**. A successful render exports an MP4, three stills, a contact sheet covering the sequence, and a reopenable `.blend` scene. Generated outputs are local and are not committed.

World comparisons support an official World Labs visual mesh and a mesh reconstructed from that same world's Gaussian splats. Optional reference images guide generation; original Gallery, Botanical room and neutral Studio defaults work offline without images or API keys. Native Gaussian preview/plate rendering remains available as a diagnostic. Product GLB and OBJ/STL/PLY mesh imports are available; native CAD import, automatic mechanism inference and human usability/quality gates remain open. See the [real product workflow and verified trial status](docs/real-product-trials.md) and [validation plan](docs/validation-plan.md).

## Open the browser editor

Use Node 24.19.0 and the pinned local render tools below. The numerical dependencies are required for Gaussian-to-mesh reconstruction.

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-worlds.txt
npm ci --prefix web
npm run build --prefix web
.venv/bin/python -m film serve --data-dir workspace-data
```

Open `http://127.0.0.1:8787`. The editor starts paused. Select products, edit labels/colors, adjust cap timing, reframe the three shots, scrub/play, undo/redo, save/reopen, preserve an approved revision, and request a Cycles still or reel. Imported and reconstructed environments remain unreviewed until inspected. Browser shading is a draft; render a Cycles still for appearance decisions.

The **Scene** tab shows the object tree and editable relationships. New projects and product imports start without a rectangular plinth. Place the product on the floor, an explicit object or a picked mesh surface; add objects with **On top of**, **Beside**, **In front of** and **Behind** links. Related objects follow their target, and **Frame product and objects** fits the cameras around the arrangement. See [scene objects and interactions](docs/scene-objects.md).

In **World → Enable A/B comparison**, choose two meshes and switch between A, B and Split. Both views share one product, camera, timeline, lighting and contact geometry. Floor picks, known-distance scale and yaw adjustments save with the project; placement review becomes draft after relevant edits. **Render matching stills** and **Export matching reels** queue both conditions and provide a ZIP with matching outputs and an integrity manifest. Offline Gallery/Botanical defaults work immediately. See the [comparison workflow](docs/comparison-workflow.md).

In the Product panel, **Import a product mesh** creates a separate campaign with fitted camera shots. Prepared GLBs retain their original bytes, geometry and embedded materials; they must already use Y-up meters and be centered at their bounding-box origin. OBJ, STL and polygon PLY files are converted locally with Blender 4.3.2: choose the source units and up axis, then the importer converts to meters and centers the model. Record the owner, source and usage permission. STL and plain OBJ contain geometry only; use a self-contained GLB for textures/materials, since external OBJ dependencies are rejected. Native STEP/IGES CAD still needs export to one of these mesh formats. Imported products do not inherit the fixture's fictional labels or cap action. See [mesh import details](docs/real-product-trials.md#mesh-inputs).

The World panel offers offline defaults and optional public HTTPS image-reference generation through GitHub Actions. Keep `WORLDLABS_API_KEY` encrypted in the repository's **Myenv** GitHub Environment. The workflow generates one world and exports its official textured GLB plus Gaussian SPZ, reconstructs the SPZ into a second GLB, and uploads both final meshes with 15 controlled probe scenes. Standard documented cost is 5,080 API credits (about $4.06); the default preflight cap is 6,000. API credits are separate from Marble website credits. See [World Labs setup and recovery](docs/worldlabs-api.md).

Matching World Labs requests reuse saved results by default across editor restarts and GitHub runs. A verified local cache hit makes no provider requests; product, camera and scene edits reuse the same world. **Generate a new variation** explicitly requests another paid result. Preserve `workspace-data/` and the local `.worldlabs-cache/` (or your chosen `--cache-dir`); GitHub caches may expire or be evicted.

**Product → Labels & materials** supports PNG/JPEG label artwork, face/cylinder/existing-UV mapping, draggable placement, downloadable UV guides and independent label/product finishes. Saved revisions and Blender renders preserve textures and material settings. See the [label and material workflow](docs/labels-and-materials.md).

The local GitHub generation controls use an authenticated `gh` CLI; they never retrieve the World Labs secret. Alternatively run the **World Labs same-world comparison** workflow directly in GitHub. Public image URLs are workflow inputs. Private image files use `scripts/worldlabs_experiment.py --image-path ...` with a locally configured server-side key; they are not committed or put in public workflow inputs.

The workflow prepares the assets and fifteen unreviewed scenes: contact, lateral camera movement, foreground occlusion, glossy material, and glass probes across the authored set and both mesh conditions. It does not render or approve the results. Both alternatives share one generated world ID; their scale and ground alignment still require review before a calibrated comparison.

Gaussian-to-mesh uses a bounded covariance-aware density isosurface with rough vertex colors. It loses view-dependent appearance and may lose thin geometry or produce holes. Both final alternatives render as meshes; fidelity is an experiment result, not an assumed property. The original SPZ and reconstruction report remain recoverable. Reconstruction records its source hash, voxel size, threshold, Gaussian filtering, color approximation and dependency versions.

Offline **Studio** is the authored neutral set. **Gallery** and **Botanical room** are original visual-mesh defaults seeded into the local library; they exclude the product and its exact plinth. Their source assets and provenance are in [examples/worlds/defaults.json](examples/worlds/defaults.json), and `python scripts/create_default_environments.py` regenerates them without network access. The separate neutral-room GLB/PLY pair is a synthetic engineering fixture, not generated-world quality evidence.

Native splat plate diagnostics additionally need Chromium: `cd web && npx playwright install chromium`. These plates approximate distant surroundings and do not reproduce native near-field occlusion, reflections, or glass transport. The mesh comparisons avoid that plate rendering path.

## Run from a source checkout

Use **Python 3.12.14**, **Blender 4.3.2**, and **FFmpeg 7.1.5** on Linux. The scene, local server, and render worker use the standard library; optional Gaussian reconstruction uses `requirements-worlds.txt`. Blender must support Cycles CPU rendering, and FFmpeg must include the `libx264` encoder and PNG support. Install these tools separately; the worker rejects different Blender or FFmpeg versions.

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

CPU rendering may take substantial time. Resolution and sample overrides apply to the job profile without modifying the source scene. The source's 32-sample profile can show noise because optional denoising is disabled; increase `--samples` when reviewing appearance. Use a separate output directory for each scene revision or render profile. Executables outside `PATH` can be supplied with `--blender /absolute/path/to/blender` and `--ffmpeg /absolute/path/to/ffmpeg` on `render` or `resume`.

For a single appearance check, render one sampled frame:

```bash
python3.12 -m film still work/mora.scene.json --output output/mora-still \
  --frame 180 --width 540 --height 960 --samples 128
```

## Inspect, cancel, and recover

The render command runs in the foreground. Use another terminal for status or cancellation:

```bash
python3.12 -m film status output/mora-draft
python3.12 -m film cancel output/mora-draft
python3.12 -m film resume output/mora-draft
```

Each job records `queued`, `running`, `failed`, `cancelled`, or `succeeded` state, completed frame ranges, attempts, errors, tool versions, and artifact hashes in `job.json`. The worker snapshots the validated source as `scene.json`, its deterministic evaluated poses as `samples.json`, and the renderer as `renderer.py`. Treat those snapshots as immutable: change your source manifest and create a new job for a revision. Resume also rejects a changed renderer implementation; use the original checkout or create a new job after a renderer update.

Cancellation requests stop the worker's current subprocess and preserve valid frames. `Ctrl+C` also stops the foreground worker; an abruptly killed process can leave a `running` record until resume reconciles it. Explicit `resume` starts a new attempt, clears the cancellation request, validates snapshots and existing PNG contents, and rerenders missing or corrupt frames. Only one worker can run a job at a time. This worker uses Linux file locking; other operating systems are not supported in this milestone.

A render or encoder process retains the worker lock if its parent is hard-killed. Wait for that process to finish before resuming. Previously recorded frames with changed hashes are rendered again, and an edited saved Blender scene is rebuilt from the source before export can succeed.

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

`restsOn` places the product on the floor, a picked mesh contact, an explicit prop or an optional plinth. Object relationships resolve deterministic poses; this is not a physics solver. Products use imported static meshes or the synthetic box/cylinder fixture. Worlds accept immutable, self-contained visual GLB or Gaussian SPZ/PLY files with declared units/axes/alignment, hashes and provenance. Labels are declared text using Blender 4.3.2's bundled Bfont on a separate label component. The adapter uses a 36 mm vertical camera gate, fixed authored studio lighting, AgX, and Cycles CPU with a fixed seed and denoising disabled.

Product and environment revisions require provenance fields for source, reuse basis, owner, and allowed external-processing destinations. The fixture declares an empty destination list. Local edits/renders do not upload product geometry. Explicit World Labs generation sends the supplied environment prompt/reference to World Labs; provenance metadata records lineage and reuse basis.

## Development and next decisions

```bash
python3.12 -m unittest discover -s tests -v
python3.12 -m compileall -q film scripts
```

CI runs standard-library tests on Python 3.12.14 without installing Blender or FFmpeg, plus the editor's Node tests and production build. Mocked worker tests exercise orchestration and recovery; they do not establish rendered visual quality. The optional real-Blender tests compare all 360 reopened poses, verify imported mesh alignment and glass settings, and render small diagnostic stills to check plate validation and frame matching:

```bash
RUN_BLENDER_TESTS=1 python3.12 -m unittest discover -s tests -p test_blender_roundtrip.py -v
```

Set `BLENDER=/absolute/path/to/blender` if needed. Render integration and human approval are separate checks described in the [validation plan](docs/validation-plan.md).

Run numerical reconstruction tests with the optional dependencies installed; the real SPZ codec check also uses the pinned web dependencies:

```bash
.venv/bin/python -m unittest discover -s tests -p test_splat_mesh.py -v
```

These tests check analytic Gaussian surfaces, covariance/axis conversion, vertex colors, bounded grids and reproducible SPZ-to-mesh output. They do not establish fidelity to a generated world or its reference image.

The [engineering verification record](docs/verification.md) describes the local tests and render checks performed for this milestone.

The [original technical proposal](docs/technical-prototype.md) contains the staged experiments and their unmeasured targets. Current review should assess the authored sequence and the same-world official/reconstructed mesh conditions, including alignment, contact, parallax, occlusion, gloss and glass. Real product preparation, assistance and user pilots retain their separate gates; the implemented editor and local render checks do not establish those outcomes.
