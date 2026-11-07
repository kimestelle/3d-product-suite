# Gesso performance and backend audit

Audited November 7, 2026. Scope includes the actual browser renderer, asset
verification, scene preparation, HTTP boundary, imports, queue recovery, provider
receipts, container runtime and AWS deployment templates. Existing product and
world bytes, Film shots and Cycles quality settings are preserved.

The prepared deployment is a private, shared-workspace AWS beta. It is not a
public multi-tenant backend. Target-host acceptance and account-specific
provisioning remain separate from the changes verified here.

## Measured performance

The Chrome comparison uses the same authored Auden scene, 1440 × 900 viewport,
1100 × 776 rendered image and a 30-step native pointer orbit. The harness is
`web/tests/preview-performance.mjs`.

| Measurement | Before | After |
| --- | ---: | ---: |
| Orbit GPU draw calls | 9,486 | 3,813 |
| Orbit main-thread task time | 317.7 ms | 163.1 ms |
| WebGL contexts in Lighting | 2 | 1 |
| Settled and hidden main-viewport draw calls | 0 | 0 |
| Repeated asset verification, median of five calls | 476.6 ms | 99.0 ms |

Camera inspection now reuses shadow maps. Source geometry, lights, materials,
visibility, sampled motion and capture passes still invalidate them. Lighting
does not mount or capture a world thumbnail that it never displays. Initial and
orbit images each differed at 3 of 853,600 pixels, with negligible channel delta;
this is visually preserved output, not byte parity.

The single cold-load trial improved from 16.1 to 12.9 seconds; it is insufficient
for a general loading-time claim. Transfer remained approximately 42.3 MB. This
pass does not establish a Gaussian FPS improvement or a GPU export speedup.

The asset measurement uses 35,735,458 actual referenced bytes and the same saved
Auden revision. Product geometry inspection and source-node bounds were being
recomputed on every verification. Byte-derived facts now use a SHA-keyed LRU
with a 2 MiB serialized budget, 64 entries and 256 KiB maximum records. No source
buffers or scene documents are retained. Every file is still read and hashed;
scene dimensions, hierarchy, material targets and artwork are still checked.
Mutated files and modified scene metadata fail even with warm facts.

Reproduce warm verification with:

```sh
python scripts/audit_asset_verification.py --data-dir workspace-data \
  --project YOUR_EXISTING_PROJECT_ID --iterations 5
```

## Backend findings and fixes

| Finding | Implemented result |
| --- | --- |
| Unbounded connection threads and stalled uploads | 32-handler default; socket timeout and absolute body deadline |
| Expensive synchronous requests could monopolize the host | Two concurrent heavy requests; capacity rejection before work |
| Unlimited queued snapshots | Eight active/prepared jobs; paired admission checked before resume state changes |
| Small requests could allocate enormous timelines | 3,600-frame and 500,000 part-frame defaults before eager sampling |
| Corrupt queue metadata could stop the sole worker | Preserve the bad record and process later jobs |
| Hosted exceptions leaked runtime details | Generic hosted 500 response; server-side diagnostics |
| Two API processes could write one workspace | Exclusive OS lease before starting services |
| Import success raced temporary cleanup | Respond after cleanup completes |
| Clean AWS host lacked Atlas/fal credentials | Optional exact Secrets Manager ARNs, scoped IAM and private file mounts |
| A container could exhaust host recovery resources | 75% RAM, no swap, one CPU reserved, no-new-privileges |

Existing exact-origin checks, mutation headers, signed sessions, pinned public
HTTPS provider downloads, immutable hashes, GPU ownership and paid-request
receipts remain in place. Service limits reject excess work and never silently
reduce geometry, output resolution or sample counts. See the exact settings in
[AWS deployment](../aws-deployment.md).

## Dependency audit

The upload path reaches Pillow image decoding and EXIF handling. The previous
`Pillow>=11,<13` upper bound excluded current fixes. Pillow is pinned to 13.0.0,
and a malformed EXIF regression verifies rejection before asset storage.
Playwright is a pinned production dependency because native capture uses it.
Build and test tools are pruned before the runtime image is assembled. Browser
installation refuses an on-demand replacement package.

Updated pins are Playwright 1.55.1, Vite 7.3.7 and Vitest 4.1.12. Full and
production npm advisory checks report zero findings at this audit. React, Three,
Spark and their runtime dependency versions are unchanged. Advisory checks are
time-bound and do not certify the native parser supply chain.

Pillow's reachable parsing issue is documented by its [maintainer advisory](https://github.com/python-pillow/Pillow/security/advisories/GHSA-g4qv-2jxx-769h).
The development server findings have upstream [Vite](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)
and [Vitest](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)
advisories. Playwright's [upstream fix](https://github.com/microsoft/playwright/pull/37532)
concerns macOS browser reinstall scripts; the configured Linux Chromium install
was not the demonstrated vector.

Residual: `cadquery-ocp==7.8.1.1` requires `vtk==9.3.1`, which has three GLTF-loader
advisories, fixed in VTK 9.5.1. Gesso does not invoke those loaders: GLB goes
through its own validation and Blender, while STEP/IGES uses OCP. These remain
packaged vulnerabilities; no incompatible native dependency override was made.
[CVE-2025-57106](https://gitlab.kitware.com/vtk/vtk/-/issues/19733) ·
[CVE-2025-57107](https://gitlab.kitware.com/vtk/vtk/-/issues/19732) ·
[CVE-2025-57108](https://gitlab.kitware.com/vtk/vtk/-/issues/19736)

## Validation

The complete Python suite ran 901 tests: 835 passed and 66 opt-in or
environment-dependent tests skipped. One initial artwork HTTP check timed out
during concurrent frontend load; its isolated recheck and the full serial
backend rerun passed. The complete patched frontend suite passed 1819 tests,
with one skipped. Both CloudFormation templates pass cfn-lint 1.60.0 with no
warnings or errors; shell syntax and diff checks pass. Native execution remains
subject to the runtime gates below.

## Required launch evidence

CloudFormation lint, configuration tests and application tests can establish
configuration behavior. They cannot prove an AWS GPU rendered correctly.
Before routing the editor to a new backend:

1. Resolve the real account, region, image digest, GPU quota, DNS and TLS using
   the deployment preflight and reviewed change set.
2. Run the container HTTP/auth smoke test and `check_render_runtime.py
   --require-gpu` on the actual NVIDIA host.
3. Export a short representative product film with a Gaussian, inspect its
   image, and retain the actual device and timing receipts.
4. Restore a complete workspace backup, verify referenced hashes, reopen a
   saved revision and explicitly resume an interrupted export.

No AWS instance, Supabase project or paid generation was created by this audit.
Local Docker execution is unavailable. The [verification-only Linux container
run](https://github.com/kimestelle/3d-product-suite/actions/runs/42345261350)
was dispatched for commit `2e491721`, with publication disabled. GitHub rejected
it before any step started: the account is locked for a billing issue. This
does not establish whether the new Linux image builds or executes. Retry that
verification after the account is unlocked, before publishing a new image.

The local runtime probe rendered a real Blender 4.3.2 Cycles frame on Metal and
initialized WebGL2 using the patched pinned Chromium 140.0.7339.186 software
renderer. Installing its new headless runtime resolved the initial missing
browser failure. This establishes local runtime behavior, not an NVIDIA result
or a full Gaussian export. The Vercel demo remains separate from the connected
backend until the AWS host passes acceptance.

## Remaining product boundaries

Public tenants still need workspace ownership, per-user entitlement and credit
transactions, isolated native import/render workers, and storage authorization.
Native converters currently run as the same application user. Imports remain
synchronous and can exceed Vercel's 120-second external rewrite timeout; a public
upload workflow needs staging uploads and asynchronous conversion. Retention
and tested backup restoration are still operational requirements. A retained
EBS volume is not a backup, and one host is not high availability.

The recommended split is [Supabase Auth/Postgres with AWS rendering and object
storage](../supabase-architecture.md). Supabase integration is proposed here;
the current shared-workspace API has not been migrated.
