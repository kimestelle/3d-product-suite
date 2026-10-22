# Hosted browser demo

The public demo runs entirely in the browser. The default `build:demo` command
packages the original fictional MORA product, sample label artwork and original
Gallery/Botanical environments. It includes no manufacturer files, generated
World Labs results, private projects or credentials. An explicitly selected
campaign can instead be published with [the campaign builder](campaign-demo.md);
that bundle includes only its verified assets and chosen room replacements.

The hosted editor is a view-only demo. Explore the parts and material library,
hover to inspect surfaces, orbit the preview, play or scrub the saved film,
and capture a local preview still. Navigation and column guides remain usable.

Scene edits require a connected backend. An attempted edit shows “Editing needs
a connected backend. The scene is unchanged.” before changing the scene,
its undo history, or a live material/transform preview. This includes packaged
world swaps, shot timing, camera settings, random setups and new scenes. The
saved film remains playable after a refused edit. Opening the bundled campaign
does not automatically compact its shot timing.

Uploads, persistent saves, approvals, generation and final Blender rendering
also require the backend. The static adapter makes no server mutations, and
preview rendering does not spend World Labs credits. The local build retains
the full editing workflow.

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


## Check the view-only editor

Build a small fixture in a separate directory, serve a static frontend build (or
start Vite with `VITE_STATIC_DEMO=1`), then run:

```sh
python scripts/build_static_demo.py --output /tmp/gesso-readonly-fixture
PRODUCT_SUITE_URL=http://127.0.0.1:5182 \
GESSO_DEMO_FIXTURE_DIR=/tmp/gesso-readonly-fixture \
node web/tests/readonly-demo-smoke.mjs
```

The Chrome test routes demo files to that isolated fixture only in its own
browser. It checks rejected edits, unchanged history/values, inspection and
advancing playback without rewriting the published campaign.
