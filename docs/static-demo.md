# Hosted browser demo

The public demo runs entirely in the browser. The default `build:demo` command
packages the original fictional MORA product, sample label artwork and original
Gallery/Botanical environments. It includes no manufacturer files, generated
World Labs results, private projects or credentials. An explicitly selected
campaign can instead be published with [the campaign builder](campaign-demo.md);
that bundle includes only its verified assets and chosen room replacements.

Try label placement, UV guide downloads, material finishes, playback, camera
framing and cap timing. Undo/redo works during the session. Edits reset when the
page reloads; the demo does not save projects or upload files.

Imports, persistent saves, approvals, scene placement/calibration, A/B comparison,
World Labs generation and final Blender rendering are disabled with a backend
explanation. Unsupported API actions fail explicitly rather than appearing to
succeed. Rendering previews does not spend World Labs credits.

**Status after merging into the gesso editor (D160).** The demo bundle, build
scripts and deployment configuration are unchanged and `npm run build:demo`
passes. The gesso editor routes its API calls through the same demo adapter, and
the browser evaluator now returns the sample fields the gesso viewport reads
(component scale, optical focus, single-frame requests). The demo banner and the
per-panel "needs a backend" states were part of the earlier editor and have not
been rebuilt in the gesso layout; panels that call other routes (Poly Haven,
material generation, film images, sound) show the adapter's explicit error. The
demo has not been checked in a browser against the latest editor; check the built
page before publishing it.

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

The [backend deployment guide](backend-deployment.md) now provides a Render
blueprint and a script to connect its URL to Vercel. Until that connection is
configured, the checked-in Vercel build remains the static demo.
