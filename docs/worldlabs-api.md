# World Labs integration

The experiment uses **one World Labs world** to create two final mesh conditions:

1. World Labs' official HQ textured visual GLB export.
2. A local experimental mesh reconstructed from that same world's Gaussian SPZ.

The original 500k SPZ is preserved as an auxiliary source with its hash. Both final
meshes preserve the provider world ID and explicit provenance. A collider GLB
cannot substitute for the official visual mesh. Reconstruction, metric alignment,
ground contact, glass and rendering quality remain **unreviewed** until assessed.
The workflow prepares fifteen probe scenes; it does not produce or approve final
renders.

## GitHub setup

The repository's **Myenv** GitHub environment must contain the environment secret
`WORLDLABS_API_KEY`. The manually dispatched **World Labs same-world comparison**
workflow binds that environment and passes the secret only to the server-side
Python process. The key is not available to this local workspace simply because
it exists in GitHub.

World Labs **API credits** are purchased at
[platform.worldlabs.ai/billing](https://platform.worldlabs.ai/billing). Marble web
app credits are separate and cannot fund API calls. No other provider key is
needed for this experiment. Local editing, synthetic worlds, local reconstruction
and Blender rendering do not require a provider key.

The workflow accepts an environment preset, optional text prompt, optional public
HTTPS reference image, an explicit model and a credit cap. Empty prompts use the
selected preset. Reference images use image-to-world with `is_pano: false`; the
same documented text/non-pano image generation maximum applies. Private local
images should use `--image-path` below rather than a GitHub workflow input.

Official API documentation checked **2026-10-16**:

| Model | Text/image generation maximum | HQ export | Combined maximum | USD at 1,250 credits/$1 |
| - | -: | -: | -: | -: |
| `marble-1.0-draft` | 230 | 3,500 | 3,730 | $2.984 |
| `marble-1.0` / `marble-1.1` | 1,580 | 3,500 | 5,080 | $4.064 |
| `marble-1.1-plus` | 3,080 | 3,500 | 6,580 | $5.264 |

The default `marble-1.1` experiment uses a 6,000-credit cap. Matching requests now
reuse saved worlds by default; these prices apply when new provider work is needed.
World Labs documents
up to one hour for HQ mesh export, independently of generation time. Plus is rejected at
that cap before any request. HQ export caching can reduce the actual charge: one
new export run produces both textured and vertex-colored variants, and an
existing or running export is reused by the provider. Downloading the existing
SPZ and reconstructing locally does not create another world or HQ export.

These are documented prices checked on the date above, not a provider-enforced
spending limit. The client preflights the full planned cost against both the cap
and API balance, records settled costs, and stops further paid work if generation
settles above its expected maximum. Provider pricing can change. The API permits
overages, so its own low-balance threshold is not a substitute for this preflight.

## Recovery and artifacts

### Reuse before generation

The editor remembers matching requests across restarts, rather than just
deduplicating clicks for a minute. Once a successful comparison is imported,
matching requests return the verified local meshes and Gaussian source without
contacting GitHub or World Labs. A request still running or awaiting import links
to its existing workflow instead of submitting another one.

The command-line runner shares a persistent cache across output directories.
Its identity includes the effective prompt, model, seed and reference image
(file contents for local images; the exact URL for hosted images). Use stable,
immutable image URLs. Spending caps, experiment names, products, camera paths and
scene edits do not create a different world request. Scene edits rebuild only the
local comparison probes. Asset hashes and paired world lineage are checked before
reuse; missing or corrupt cached assets stop the run rather than authorize a
replacement generation. A complete hit needs no API key and makes zero provider
requests, including balance checks.

GitHub Actions restores the matching cache before generation and saves accepted
operation journals even after failures. Local runs default to
`<output-parent>/.worldlabs-cache/`; pass `--cache-dir /persistent/path` to share
across other output parents. Keep this private cache and `workspace-data/` when
moving or backing up the editor. Both contain generated assets and recovery data
and belong outside Git.

For an intentional new paid result, select **Generate a new variation** in the
editor or set `force_new` in the workflow. Locally, use `--force-new` with a new
`--experiment-id` and output directory. The same explicit variation remains
resumable: its namespace is the GitHub run ID, or the local experiment ID.

GitHub caches can expire or be evicted. The editor's local assets remain reusable
while preserved; keep artifacts and operation IDs for recovery when remote cache
storage is unavailable.

To backfill a successful result made before caching, supply its GitHub run ID in
the workflow's `existing_artifact_run_id` field with the same prompt, preset,
image and model. The workflow verifies the artifact and seeds the cache; that
run receives no World Labs API key and cannot submit paid work. Missing artifacts
or mismatched inputs stop the run. Local backfill from GitHub is also available:

```bash
python scripts/seed_worldlabs_cache.py --run-id YOUR_SUCCESSFUL_RUN_ID \
  --cache-dir /persistent/worldlabs-cache
```

Set the same `WORLDLABS_PROMPT`, `WORLDLABS_DEFAULT_ENVIRONMENT`,
`WORLDLABS_REFERENCE_IMAGE_URL` and `WORLDLABS_MODEL` environment variables as
the original request when using this helper. An existing completed CLI output
also seeds the shared cache automatically when run with its original settings.

Before every paid POST the client durably saves its intent. It never automatically
retries a POST with an uncertain outcome. Accepted operation IDs are saved and
printed immediately, and appear in the GitHub run summary. Polling retries only
read-only transient failures. Accepted generation IDs tolerate up to 120 seconds of
404 visibility lag. If an HQ export operation returns 404, the client reads the
saved world’s requested HQ visual-mesh field until it appears; this never submits
another export. Metadata completion records the export’s settled cost as unknown.
Terminal POST responses and saved terminal receipts are consumed without an
unnecessary status request.

The workflow uploads `worldlabs-experiment/` even after failure, including provider
state, immutable world assets, reconstruction metadata and the comparison
manifest. Keep this directory out of Git. The artifact expires after 30 days.

For recovery, dispatch with the saved **world ID**, or the saved **generation
operation ID**. A saved **mesh operation ID** additionally identifies an export
already accepted. A GitHub job rerun without recovery inputs cannot generate a
fresh paid world. If a submission timed out before returning an operation ID,
inspect the World Labs platform before submitting anything else.

## Local execution

Set `WORLDLABS_API_KEY` in the server process environment without committing it.
Install the pinned reconstruction dependencies in `requirements-worlds.txt` and
run `npm ci --prefix web` for the SPZ decoder. Then:

```bash
python scripts/worldlabs_experiment.py --output outputs/worldlabs-experiment \
  --default-environment botanical-studio --model marble-1.1 --budget-credits 6000

python scripts/worldlabs_experiment.py --output outputs/worldlabs-image \
  --image-path /absolute/path/reference.png --budget-credits 6000

# Same inputs, another output: reuses the cached world without provider calls.
python scripts/worldlabs_experiment.py --output outputs/another-comparison \
  --default-environment botanical-studio --model marble-1.1 --budget-credits 6000
```

Local PNG, JPEG and WebP references up to 6 MiB use the API's inline base64 image
reference. The private image is sent to World Labs, but its base64 contents are
omitted from durable request and response records; hashes remain for lineage.
Keys never enter browser inputs, `VITE_*` variables, Git or CDN download headers.

## Provider contract and alignment

The API root is `https://api.worldlabs.ai/marble/v1`, authenticated with
`WLT-Api-Key`. Generation uses `/worlds:generate`; existing operations are polled
at `/operations/{operation_id}`. HQ mesh export uses
`POST /worlds/{world_id}:export` with
`{"asset_type":"mesh","format":"glb","mesh_variant":"textured"}`.
World metadata supplies `assets.mesh.hq_mesh_url` and
`assets.splats.spz_urls["500k"]`; collider URLs are ignored.

SPZ alignment uses the world's own `semantics_metadata`: multiply centers and
Gaussian sizes by `metric_scale_factor`, subtract `ground_plane_offset` from Y,
then rotate 180 degrees around X from Marble's raw OpenCV convention. In the
scene's scale-rotate-translate contract this becomes scale `s`, rotation
`[1,0,0,0]`, translation `[0,+ground_offset,0]`. The reconstructed GLB retains this
transform after the converter bakes its source basis into Y-up coordinates.

The export specifications also document the axis flip for meshes. They do not
establish that HQ GLB units share SPZ's metric scale. HQ GLB defaults therefore
remain scale 1, ground offset 0 and **unreviewed**; the SPZ metric factor is not
blindly copied onto that mesh. Review and explicitly adjust mesh scale/ground
before treating the camera comparison as calibrated. A SPZ metric factor of 1
can mean metric scale was not inferred.

References:

- [Models](https://docs.worldlabs.ai/api/models)
- [Generation contract](https://docs.worldlabs.ai/api/reference/worlds/generate)
- [World assets](https://docs.worldlabs.ai/api/reference/worlds/get)
- [Visual mesh exports](https://docs.worldlabs.ai/api/reference/worlds/export)
- [Operations](https://docs.worldlabs.ai/api/reference/operations/get)
- [API pricing](https://docs.worldlabs.ai/api/pricing)
- [SPZ metric scale and axes](https://docs.worldlabs.ai/api/rendering-spz)
- [Export specifications](https://docs.worldlabs.ai/marble/export/specs)

Provider and orchestration tests use fake HTTP transports and consume no credits.
