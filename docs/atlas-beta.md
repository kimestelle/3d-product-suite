# Marble 2 beta in World Comparison

Open [Marble 2 quickstart in World Comparison](http://127.0.0.1:8787/world-comparison.html#marble-2) in the running local editor. The sample is Daniel Erlandson’s torii photograph from the World Labs quickstart. The form also accepts a publicly shareable HTTPS image URL. Atlas fetches that URL when you submit. [World Labs quickstart](https://docs.atlas-beta.worldlabs.ai/quickstart) · [Source photograph](https://www.pexels.com/photo/scenic-view-of-red-torii-gate-at-lake-ashi-31252468/)

Create a project API key with `tasks.create`, `operations.read`, `assets.create` and `assets.read`. Set `WLT_API_KEY` in the server environment or place the key on its own line in `workspace-data/secrets/atlas-api-key` with owner-only permissions. The server reads this file when needed, so adding it to a running workspace only requires refreshing the page. For a different data directory, use its `secrets/atlas-api-key` path or set `WLT_API_KEY_FILE` to a private file. The server uses the official Atlas beta v2 API. [Atlas Developers](https://atlas-beta.worldlabs.ai/developers) · [Beta billing and project limits](https://docs.atlas-beta.worldlabs.ai/billing)

From the repository root, this command prompts privately and creates the default key file. It requires an interactive terminal and stops if the file already exists.

```sh
.venv/bin/python - <<'PY'
from getpass import getpass
import os
from pathlib import Path

path = Path("workspace-data/secrets/atlas-api-key")
path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
key = getpass("Atlas project API key: ").strip()
if not key:
    raise SystemExit("No key entered")
with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
    file.write(key + "\n")
PY
```

Choose **Run Marble 2** to submit `images2PosedRGBD` at 1280 × 720. It spends project credits according to the beta rate card. **Check operation** reads the same operation. Completed runs expose the returned image, estimated camera, linear depth EXR and optional confidence PNG. The camera intrinsics describe the depth grid. The quickstart produces a posed image. A splat reconstruction uses a separate task and at least two posed RGBD views. [Task schema](https://docs.atlas-beta.worldlabs.ai/api-reference/images2-posed-rgbd) · [Splat reconstruction](https://docs.atlas-beta.worldlabs.ai/posed-images-to-splats)

Gesso saves the request and idempotency key before submission and keeps the operation ID under `workspace-data/atlas/`. Reopening the same input finds its run. If the submission response is lost, consult Atlas Operations before starting new work. Downloads obtain fresh read grants on the server and cache the validated files locally. Workspace and saved operation records are protected by the editor’s existing access controls. [Operation lifecycle](https://docs.atlas-beta.worldlabs.ai/operations) · [Asset reads](https://docs.atlas-beta.worldlabs.ai/assets)

## Reference editor

Stage → Environment → Design environment opens a modal. The user's brief produces three image directions. Choosing one expands it into four reference angles. Plain-language edits retain earlier revisions. Build 3D separately estimates the approved images' cameras and depth with Atlas before reconstructing a draft.

The image stage uses Nano Banana Pro at 2K, with its Edit endpoint for revisions and additional angles. The provider price checked November 6, 2026 is $0.15 per image, approximately $0.45 for three concepts or $0.60 for four angles before Atlas work. These are provider costs. Images carry visual direction, without calibrated camera poses. [fal model and pricing](https://fal.ai/models/fal-ai/nano-banana-pro/edit)

Set `FAL_KEY` or `FAL_KEY_FILE` on the backend, or save the key on its own line in `workspace-data/secrets/fal-api-key` with owner-only permissions. Keys remain server-side. Queue receipts survive reloads. An ambiguous submission requires checking the provider before resubmission.

The selected reference set has its own saved community-sharing preference. Updating it makes no image or 3D requests. Opting out withdraws its submitted worlds; opting back in sends withdrawn work through review again.

The default model was selected for multiple image references and natural-language edits. Nano Banana 2.1 offers lower image prices, and FLUX.2 Pro supports exact image sizes. The choice reflects documented controls and the integration test, without a comparative image-quality benchmark. [Nano Banana 2.1](https://fal.ai/nano-banana-2.1) · [FLUX.2 Pro](https://fal.ai/models/fal-ai/flux-2-pro/edit)
