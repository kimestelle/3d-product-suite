# Connect the Vercel editor to a persistent backend

The current demo is <https://gesso-studio-gold.vercel.app/>. Keep Vercel for the
editor and run the existing Python service on Render. The checked-in
`render.yaml` creates one Docker web service with a persistent disk. It includes
Blender, FFmpeg, CAD import and the browser used for Gaussian export. This is a
single shared workspace, protected by an access key; it is not a multi-user SaaS
deployment.

## 1. Create the backend

[Deploy the Render blueprint](https://render.com/deploy?repo=https://github.com/kimestelle/3d-product-suite).
Sign in to Render and connect this repository. Review the service plan and disk
price before creating it: persistent disks and the memory needed by Blender use
a paid service. No cloud resources are created by cloning or building this repo.

The blueprint sets:

| Setting | Value |
| --- | --- |
| `GESSO_PUBLIC_URL` | `https://gesso-studio-gold.vercel.app` |
| `GESSO_ACCESS_KEY` | Render generates a random workspace access key |
| Persistent disk | `/data` |
| Project and asset storage | `/data/workspace` |
| Health check | `/api/health` |

Keep one service instance. Project locks and the serial render queue share the
same filesystem; this deployment is not designed for multiple replicas. The
backend also serves the normal editor build at its own Render URL, which is
useful for checking uploads and imports independently of Vercel.

After the deploy reports healthy, open `https://YOUR-SERVICE.onrender.com/api/health`.
It should return `{"status":"ok"}`. Open the backend editor and use the generated
`GESSO_ACCESS_KEY` from Render's environment settings at the **Studio access**
screen. Keep the key in your password manager; do not put it in Git, a `VITE_`
variable, a URL or a chat message.

## 2. Connect Vercel

Once the backend is healthy, run this from the repository root with its actual
URL:

```bash
python scripts/connect_vercel_backend.py https://YOUR-SERVICE.onrender.com
git add vercel.json
git commit -m "Connect the Vercel editor to the hosted backend"
git push origin main
```

This changes Vercel to the normal editor build and adds an external rewrite for
`/api/*`. It does not deploy a Vercel proxy Function. Keep Vercel's Root Directory
at the repository root and use the checked-in build configuration. Remove a
previous `VITE_STATIC_DEMO=1` environment override if you added one manually.
The editor, assets and downloads use the same Vercel origin, so no CORS or public
browser API key is needed.

If this Vercel project was deployed from your computer rather than connected to
GitHub, redeploy with `npx vercel --prod` from the repository root after updating
the configuration, or connect the project to this repository in Vercel first.

Open the Vercel editor, sign in, import a GLB, save a change and reload it.
Sessions expire after 12 hours; rotating the access key signs out existing
sessions. API responses and private assets disable CDN caching. The direct
backend URL requires the same access key. Vercel preview URLs are not allowed
automatically; use the configured production URL to edit this workspace.

To restore the static demo, run `python scripts/connect_vercel_backend.py --demo`,
commit the resulting `vercel.json` and redeploy Vercel. This does not delete the
backend's stored projects.

## Optional provider keys

No provider key is needed for uploads, saved projects, offline environments,
editing or rendering. Only configure the services you want to use:

- The editor's World Labs controls use the GitHub workflow and its existing
  **Myenv → WORLDLABS_API_KEY** secret. You do not need to copy that key to
  Render for this path. `WORLDLABS_API_KEY` is needed separately only if you run
  the direct generation CLI on the backend; the UI does not call that CLI.
- `FAL_KEY` enables the existing fal material generation path.
- `GH_TOKEN` enables the existing GitHub World Labs workflow controls. Use a
  token restricted to this repository with the workflow Actions access those
  controls need (Actions read/write and repository contents read). It lets the
  server dispatch the workflow and import its artifacts; it does not retrieve
  the encrypted World Labs key from GitHub.

World Labs caching stays in the persistent workspace. Back up the entire disk,
not just scene JSON, because revisions reference content-addressed assets.
Existing projects on your computer are not uploaded by a source-code deploy.

## Limits to check on the live deployment

Vercel external rewrites have a **120-second origin response timeout**. Render
submissions return promptly and the existing worker renders in the background.
Some CAD/Blender imports and external asset downloads are synchronous and may
exceed this timeout. For a slow import, open the backend editor directly and
check whether the project was created before retrying it.

The app accepts model uploads up to 128 MiB. The Vercel Function 4.5 MB body limit
does not describe this external rewrite, but large uploads through the actual
Vercel deployment still need checking. CPU rendering on a small hosted instance
can be slow; start with a short, low-resolution export. Native Gaussian capture
uses headless Chromium with software WebGL and also needs a live check on the
chosen host. Building the image alone does not establish render quality or
performance.

References: [Vercel external rewrites](https://vercel.com/docs/routing/rewrites),
[proxy timeout](https://vercel.com/docs/limits#proxied-request-timeout),
[Function limits](https://vercel.com/docs/functions/limitations),
[Render disks](https://render.com/docs/disks).
