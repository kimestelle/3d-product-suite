# Publishing one saved campaign

`scripts/build_campaign_demo.py` packages an explicitly selected scene for the
browser demo. It accepts a scene JSON or a saved revision containing `scene`.

```sh
python3 scripts/build_campaign_demo.py \
  --scene /path/to/selected-revision.json \
  --library /path/to/its/asset-library \
  --output /path/to/empty/public/demo
```

The builder verifies asset hashes and formats, copies only referenced assets,
adds the original offline worlds (or explicitly selected replacements), and samples the saved film with the Python
evaluator. Its `sampled` playback mode preserves those frames in the browser.
The original scene and library are unchanged. Local filesystem paths become
filenames; product and world ownership and reuse statements remain visible in
the scene. Audio is omitted unless `--include-audio` is explicitly passed.

Use `VITE_STATIC_DEMO=1` for the Vite build after generating this bundle. Do not
run `build:demo` afterward: that command intentionally builds the original MORA
fixture. The campaign bundle has a manifest listing every published asset and
its SHA-256. Reuse an output directory only for the identical bundle, or choose
a new empty directory.

This is a view-only browser preview. Scene edits, uploads, generation,
persistent project saves and final Blender rendering require the backend.
Rejected edits leave the saved scene and playback unchanged.

To replace the geometric Botanical choice with a saved mesh world, add:

```sh
--replace-world botanical-room=/path/to/botanical-world.json
```

The JSON is a saved world record (`id`, `name`, `environment`). Its referenced
assets must be in the supplied library. The builder checks hashes, keeps its
alignment and provenance, and excludes the replaced fixture asset. This changes
the room library, not the opening campaign or its camera/product motion.
The bundle retains these world definitions and their covers. The hosted editor
requires a backend before replacing the scene’s world, including a packaged
world; the open campaign and its sampled film stay unchanged.

A world record may include a `previewAsset` PNG or JPEG (at most 1024px per
side and 1 MiB), verified and copied by the same builder. The room library loads
this small image first. Mesh and splat covers never fetch their full world asset;
the full asset loads only when a world is applied by a connected editor or is
the bundle’s opening scene. A captured preview of the
selected scene can replace its thumbnail. Missing thumbnails say “Open to preview.”
