# Hosted browser demo

The public demo runs entirely in the browser. It packages the original fictional
MORA product, sample label artwork and original Gallery/Botanical environments.
Manufacturer files, generated World Labs results, private projects and credentials
are not included.

Try label placement, UV guide downloads, material finishes, playback, camera
framing and cap timing. Undo/redo works during the session. Edits reset when the
page reloads; the demo does not save projects or upload files.

Imports, persistent saves, approvals, scene placement/calibration, A/B comparison,
World Labs generation and final Blender rendering are disabled with a backend
explanation. Unsupported API actions fail explicitly rather than appearing to
succeed. Rendering previews does not spend World Labs credits.

## GitHub Pages

The **Deploy static editor demo** workflow builds and publishes the demo on pushes
to `main` or manual dispatch. Repository Settings → Pages must use **GitHub
Actions** as its build source. The workflow derives the repository subpath from
Pages configuration and uploads only `web/dist`.

After Pages is enabled and the deployment succeeds, the demo URL will be
<https://kimestelle.github.io/3d-product-suite/>.

To build the same subpath locally:

```bash
npm ci --prefix web --ignore-scripts
VITE_BASE_PATH=/3d-product-suite/ npm run build:demo --prefix web
```

Serve the generated files under `/3d-product-suite/` when testing that build.
For a root-domain deployment, omit `VITE_BASE_PATH`.

## Vercel

Import this GitHub repository into Vercel with **Root Directory** set to the
repository root. The checked-in `vercel.json` sets installation, demo build and
output directory automatically. The build uses Node and Python 3 for the
standard-library sample-data generator. No API keys or server functions are
required for this static demo.

The Vercel configuration is ready; importing the repository still requires a
connected Vercel account. The GitHub connection used for this implementation could
push code but returned HTTP 403 when enabling Pages. A repository administrator
must select **Settings → Pages → Source → GitHub Actions**, then run **Deploy
static editor demo**. Until that setting is enabled, the workflow builds a tested
artifact and explains why deployment is skipped.

## Full application later

The normal local build remains `npm run build --prefix web`. It uses the Python
API and preserves the full editor workflow.

A hosted full application needs a persistent authenticated Python backend,
durable asset/project storage and a Blender/FFmpeg render worker. Vercel can host
the frontend once that backend is connected. The static demo includes no live
backend or paid generation endpoint.
