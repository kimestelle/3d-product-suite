# 3d-product-suite

A local editor and repeatable render pipeline for editable product films. Import prepared product GLBs with their original geometry and materials, or explore the fictional **MORA** bottle fixture with its confirmed cap movement and label/color controls. Shared Python scene evaluation drives both browser playback and Blender/Cycles.

The fixture produces a 15-second, 24 fps sequence: **360 frames**, with native final settings of **1080 × 1920**. A successful render exports an MP4, three stills, a contact sheet covering the sequence, and a reopenable `.blend` scene. Generated outputs are local and are not committed.

World comparisons support an official World Labs visual mesh and a mesh reconstructed from that same world's Gaussian splats. Optional reference images guide generation; original Gallery, Botanical room and neutral Studio defaults work offline without images or API keys. Native Gaussian preview/plate rendering remains available as a diagnostic. Product GLB import is available; direct CAD import, automatic mechanism inference and human usability/quality gates remain open. See the [real product workflow and verified trial status](docs/real-product-trials.md) and [validation plan](docs/validation-plan.md).

## Run locally

Use **Python 3.12** (CI: 3.12.14) and **Node.js 24.19.0** with npm. The core editor and Python server need no third-party Python packages, API keys, Blender, or FFmpeg. The server uses POSIX file locking; use macOS or Linux. Native Windows is not supported.

Run from the repository root:

```bash
git clone --branch gesso-editor https://github.com/kimestelle/3d-product-suite.git
cd 3d-product-suite
python3.12 -m venv .venv
npm ci --prefix web
npm run build --prefix web
.venv/bin/python -m film serve --data-dir workspace-data
```

Open [the editor](http://127.0.0.1:8787/). Keep the terminal running; `Ctrl+C` stops the server. It binds to `127.0.0.1`, for local use only. `--port 8787` is the default. The server serves **`web/dist`**, so rebuild with `npm run build --prefix web` after frontend changes, then reload the browser. Restart the Python server after backend changes.

On first use, an empty data directory creates the fictional MORA campaign and seeds the bundled environment fixtures. **`workspace-data/` is local and ignored by Git**: it holds projects, saved revisions, imported assets, material jobs, and render jobs. Keep using the same directory to reopen your work; back it up as a whole. The lamp campaigns and generated worlds in the author's workspace are not installed by cloning this repository. The bundled landing reel is a visual reference, not an editable lamp project.

The editor opens paused. Use a window at least **900 px wide** for its viewport and sidebars. Browser shading is a draft; use a Cycles still for appearance decisions.

| Page | Local URL |
| --- | --- |
| Landing | [127.0.0.1:8787/landing](http://127.0.0.1:8787/landing) |
| About | [127.0.0.1:8787/about](http://127.0.0.1:8787/about) |
| Form + light | [127.0.0.1:8787/aperture](http://127.0.0.1:8787/aperture) |
| Curve catalog | [127.0.0.1:8787/curves](http://127.0.0.1:8787/curves) |
| Product | [Product / Model](http://127.0.0.1:8787/?step=product&layer=model) |
| Material | [Material / Materials](http://127.0.0.1:8787/?step=material&layer=materials) |
| World | [World / Props](http://127.0.0.1:8787/?step=world&layer=props) |
| Film | [Film / Framing](http://127.0.0.1:8787/?step=film&layer=framing) |

The visible name is **Form + light**; `/aperture` remains the route so existing links keep working. Editor links use `step` and `layer`; add `mode=still` for still-image controls.

### Fonts and assets

The interface uses **Halyard Text and Halyard Display**, resolved from licensed fonts installed on the machine. No Halyard font binaries are redistributed. Activate those families locally or configure a licensed webfont source to match the design. Without them, the UI stays usable with its bundled fallback; the console reports that Halyard is unavailable. Product artwork uses the packaged Studio Sans fonts separately.

Asset sources and reuse limits are recorded in [the interface asset manifest](web/src/assets/gesso/ASSETS.md). The repository's original fixtures, imported product geometry, landing imagery, and generated worlds do not all share a license. Do not infer a public reuse license from their presence in a preview.

### Frontend development

Keep the Python API running on port 8787 in one terminal. In another terminal, from the repository root:

```bash
npm run dev --prefix web -- --port 5173 --strictPort
```

Open [the Vite development server](http://127.0.0.1:5173/). Vite hot-reloads frontend changes and proxies `/api` to the Python server. Keep port 5173: it is explicitly allowed by the API's origin checks. `--strictPort` avoids silently moving to an unapproved port. `npm run preview` alone does not start the Python API or provide this development proxy.

### Optional rendering and online resources

- **Local export:** install Blender **4.3.2** and FFmpeg **7.1.5** separately. The worker checks those versions. Blender is required for PNG stills and PNG sequences; JPEG, WebP, H.264 MP4, and ProRes MOV also need FFmpeg with the relevant encoders. Missing tools disable the affected export choices, not editing.
- **Poly Haven:** browsing/importing textures, props, and HDRIs needs network access, with no API key. Only selected assets are imported into the local data directory; existing local assets remain available offline.
- **Patina materials:** set `FAL_KEY` in the Python server's environment before starting it. Generation is an explicit user action and uses the fal account's credits.
- **World Labs:** set `WORLDLABS_API_KEY` in the Python server's environment for direct generation, or use the authenticated `gh` workflow described below. Offline environments need neither.
- **Gaussian-to-mesh reconstruction:** install the optional numerical stack with `.venv/bin/python -m pip install -r requirements-worlds.txt`.

`.env.example` lists the optional credential names; the Python server does **not** automatically load `.env` files. Supply credentials through your shell environment or secret manager, then restart the server. Never put them in `VITE_*` variables or committed files.

If render executables are not on `PATH`, pass their absolute paths:

```bash
.venv/bin/python -m film serve --data-dir workspace-data \
  --blender /absolute/path/to/blender \
  --ffmpeg /absolute/path/to/ffmpeg
```

On macOS, a standard Blender app executable is `/Applications/Blender.app/Contents/MacOS/Blender`; it must still be version 4.3.2. Tool availability is checked once per server process, so restart after installing or changing executables.

### If it does not open

| Symptom | Check |
| --- | --- |
| `Build the editor first` / HTTP 503 | Run `npm ci --prefix web` and `npm run build --prefix web`. |
| Changes do not appear on port 8787 | Rebuild `web/dist` and reload, or use Vite on port 5173. |
| Connection refused | Keep `python -m film serve` running and use its printed URL. |
| Address already in use | Reuse the existing server or stop it before starting another. `--port` changes the backend port; the Vite proxy remains configured for 8787. |
| Missing lamp campaign or imported world | Reopen the correct `--data-dir`; these private workspace assets are not cloned with the source. |
| Different typography | Activate licensed Halyard Text / Display locally; see the browser console for fallback status. |
| Export unavailable | Check the exact Blender/FFmpeg versions and restart the server after changing them. |

## Editor and world workflow

In **World → Enable A/B comparison**, choose two meshes and switch between A, B and Split. Both views share one product, camera, timeline, lighting and contact geometry. Floor picks, known-distance scale and yaw adjustments save with the project; placement review becomes draft after relevant edits. **Render matching stills** and **Export matching reels** queue both conditions and provide a ZIP with matching outputs and an integrity manifest. Offline Gallery/Botanical defaults work immediately. See the [comparison workflow](docs/comparison-workflow.md).

In the Product panel, **Import a product GLB** creates a separate campaign with its source geometry, original materials and fitted camera shots. Supply a static self-contained GLB in Y-up meters, centered at its bounding-box origin, and record the owner, source and usage permission. CAD conversion happens before this handoff. Imported products do not inherit the fixture's fictional labels or cap action.

The World panel offers offline defaults and optional public HTTPS image-reference generation through GitHub Actions. Keep `WORLDLABS_API_KEY` encrypted in the repository's **Myenv** GitHub Environment. The workflow generates one world and exports its official textured GLB plus Gaussian SPZ, reconstructs the SPZ into a second GLB, and uploads both final meshes with 15 controlled probe scenes. Standard documented cost is 5,080 API credits (about $4.06); the default preflight cap is 6,000. API credits are separate from Marble website credits. See [World Labs setup and recovery](docs/worldlabs-api.md).

The local GitHub generation controls use an authenticated `gh` CLI; they never retrieve the World Labs secret. Alternatively run the **World Labs same-world comparison** workflow directly in GitHub. Public image URLs are workflow inputs. Private image files use `scripts/worldlabs_experiment.py --image-path ...` with a locally configured server-side key; they are not committed or put in public workflow inputs.

The workflow prepares the assets and fifteen unreviewed scenes: contact, lateral camera movement, foreground occlusion, glossy material, and glass probes across the authored set and both mesh conditions. It does not render or approve the results. Both alternatives share one generated world ID; their scale and ground alignment still require review before a calibrated comparison.

Gaussian-to-mesh uses a bounded covariance-aware density isosurface with rough vertex colors. It loses view-dependent appearance and may lose thin geometry or produce holes. Both final alternatives render as meshes; fidelity is an experiment result, not an assumed property. The original SPZ and reconstruction report remain recoverable. Reconstruction records its source hash, voxel size, threshold, Gaussian filtering, color approximation and dependency versions.

Offline **Studio** is the authored neutral set. **Gallery** and **Botanical room** are original visual-mesh defaults seeded into the local library; they exclude the product and its exact plinth. Their source assets and provenance are in [examples/worlds/defaults.json](examples/worlds/defaults.json), and `python scripts/create_default_environments.py` regenerates them without network access. The separate neutral-room GLB/PLY pair is a synthetic engineering fixture, not generated-world quality evidence.

Native splat plate diagnostics additionally need Chromium: `cd web && npx playwright install chromium`. These plates approximate distant surroundings and do not reproduce native near-field occlusion, reflections, or glass transport. The mesh comparisons avoid that plate rendering path.

## Render from the command line

The reference render setup uses **Python 3.12.14**, **Blender 4.3.2**, and **FFmpeg 7.1.5**. Blender must support Cycles CPU rendering, and FFmpeg must include the `libx264` encoder and PNG support. Install the tools separately; the worker rejects different Blender or FFmpeg versions.

```bash
.venv/bin/python --version
blender --version
ffmpeg -version

.venv/bin/python -m film init work/mora.scene.json
.venv/bin/python -m film validate work/mora.scene.json
.venv/bin/python -m film sample work/mora.scene.json --output work/mora.samples.json
```

Run the commands from the repository root. `init` and `sample` refuse to overwrite their destination files. `validate` checks the supported scene contract and prints the canonical JSON SHA256; it does not inspect visual quality or establish asset permissions.

Render the complete reel at draft resolution first:

```bash
.venv/bin/python -m film render work/mora.scene.json --output output/mora-draft \
  --width 270 --height 480 --samples 8
```

For a smaller smoke run, use `--width 144 --height 256 --samples 1`. Both profiles still render all 360 frames. Final rendering uses the source manifest's 1080 × 1920, 32-sample profile:

```bash
.venv/bin/python -m film render work/mora.scene.json --output output/mora-final
```

CPU rendering may take substantial time. Resolution and sample overrides apply to the job profile without modifying the source scene. The source's 32-sample profile can show noise because optional denoising is disabled; increase `--samples` when reviewing appearance. Use a separate output directory for each scene revision or render profile. Executables outside `PATH` can be supplied with `--blender /absolute/path/to/blender` and `--ffmpeg /absolute/path/to/ffmpeg` on `render` or `resume`.

For a single appearance check, render one sampled frame:

```bash
.venv/bin/python -m film still work/mora.scene.json --output output/mora-still \
  --frame 180 --width 540 --height 960 --samples 128
```

## Inspect, cancel, and recover

The render command runs in the foreground. Use another terminal for status or cancellation:

```bash
.venv/bin/python -m film status output/mora-draft
.venv/bin/python -m film cancel output/mora-draft
.venv/bin/python -m film resume output/mora-draft
```

Each job records `queued`, `running`, `failed`, `cancelled`, or `succeeded` state, completed frame ranges, attempts, errors, tool versions, and artifact hashes in `job.json`. The worker snapshots the validated source as `scene.json`, its deterministic evaluated poses as `samples.json`, and the renderer as `renderer.py`. Treat those snapshots as immutable: change your source manifest and create a new job for a revision. Resume also rejects a changed renderer implementation; use the original checkout or create a new job after a renderer update.

Cancellation requests stop the worker's current subprocess and preserve valid frames. `Ctrl+C` also stops the foreground worker; an abruptly killed process can leave a `running` record until resume reconciles it. Explicit `resume` starts a new attempt, clears the cancellation request, validates snapshots and existing PNG contents, and rerenders missing or corrupt frames. Only one worker can run a job at a time. This worker uses POSIX file locking (`fcntl`); native Windows is not supported.

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

Motion is evaluated from absolute frame time, `t = (frame - 1) / fps`; the fixture’s base actions use smoothstep progress. At 24 fps the final frame is sampled at 359/24 seconds; encoding 360 frames yields 15 seconds. Scrubbing order does not affect poses. The sampled transforms are world transforms, and the `.blend` uses constant interpolation between integer-frame samples.

Legacy mechanism actions declare a normalized axis and pivot in the moving component's **original local frame**, an existing stationary `relativeTo` component, explicit timing, `approval: "confirmed"`, and evidence IDs present in the document. The fixture's 55 mm lift is manually authored and its evidence describes a synthetic mechanism. Screw actions couple axial travel per revolution with rotation; `directionSign` controls rotation direction. That mechanism contract supports one base action per component and stationary references; it is not a joint or physics solver.

The Film workspace also stores object and camera motions in the scene document. Shot-local motions use a shot clock; across-cuts motions use the film clock. A local motion replaces an across-cuts motion on the same target/channel, and competing owners within one scope are rejected. Preset timing and custom progress keys feed the same evaluator. The shot row and playhead are views of this scene timeline, not a second animation source.

`restsOn` carries the product with its explicit plinth; placement is deterministic rather than a physics solver. The MORA fixture uses synthetic box/cylinder geometry; imported products retain their GLB geometry. Worlds accept immutable, self-contained visual GLB or Gaussian SPZ/PLY files with declared units/axes/alignment, hashes and provenance. Labels are declared text using Blender 4.3.2's bundled Bfont on a separate label component. The adapter uses a 36 mm vertical camera gate, fixed authored studio lighting, AgX, and Cycles CPU with a fixed seed and denoising disabled.

Product and environment revisions require provenance fields for source, reuse basis, owner, and allowed external-processing destinations. The fixture declares an empty destination list. Local edits/renders do not upload product geometry. Explicit World Labs generation sends the supplied environment prompt/reference to World Labs; provenance metadata records lineage and reuse basis.

## Tests and development records

Run from the repository root after the local setup:

```bash
npm test --prefix web
npm run build --prefix web
node scripts/capture_splats.test.mjs
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m compileall -q film scripts
```

CI runs standard-library tests on Python 3.12.14 without installing Blender or FFmpeg, plus the editor's Node tests and production build. Mocked worker tests exercise orchestration and recovery; they do not establish rendered visual quality. The optional real-Blender tests compare all 360 reopened poses, verify imported mesh alignment and glass settings, and render small diagnostic stills to check plate validation and frame matching:

```bash
RUN_BLENDER_TESTS=1 .venv/bin/python -m unittest discover -s tests -p test_blender_roundtrip.py -v
```

Set `BLENDER=/absolute/path/to/blender` if needed. Render integration and human approval are separate checks described in the [validation plan](docs/validation-plan.md).

Run numerical reconstruction tests with the optional dependencies installed; the real SPZ codec check also uses the pinned web dependencies:

```bash
.venv/bin/python -m unittest discover -s tests -p test_splat_mesh.py -v
```

These tests check analytic Gaussian surfaces, covariance/axis conversion, vertex colors, bounded grids and reproducible SPZ-to-mesh output. They do not establish fidelity to a generated world or its reference image.

The [design decision log](docs/design-decisions.md) records the product, interface, motion, and visual decisions behind the current implementation. Update it in the same change as a new or revised design decision, including the reason and any superseded choice.

The [engineering verification record](docs/verification.md) describes the local tests and render checks performed for this milestone.

The [original technical proposal](docs/technical-prototype.md) contains the staged experiments and their unmeasured targets. Current review should assess the authored sequence and the same-world official/reconstructed mesh conditions, including alignment, contact, parallax, occlusion, gloss and glass. Real product preparation, assistance and user pilots retain their separate gates; the implemented editor and local render checks do not establish those outcomes.
