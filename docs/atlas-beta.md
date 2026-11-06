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
