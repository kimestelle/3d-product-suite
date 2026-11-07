# Community environments

The separate `/marketplace` page browses approved environments with search, tags, representation filters, image previews and technical facts. Subscription members can download worlds at no additional per-asset charge once entitlement verification is configured. Billing is deferred and downloads are currently gated.

New generation starts with community sharing selected. A finished world enters the backend's private audit queue. The review target is 2–3 business days. Opting out excludes it from the queue. Generations predating this preference are not submitted automatically.

The audit verifies asset bytes and formats, attribution fields, Gaussian point counts and coordinate bounds, and the preview image. It retains cleanup assessments. These checks do not establish straight architecture, coherent lighting or legal ownership. A reviewer inspects the actual model before approval. Missing previews require changes.

The browsing and review structure draws on Fab's asset filters, listing details and explicit approval workflow. Gesso uses its own interface and asset previews. [Fab browsing](https://dev.epicgames.com/documentation/fab/purchasing-and-downloading-assets-in-fab) · [Fab review workflow](https://dev.epicgames.com/documentation/fab/publishing-assets-for-sale-or-free-download-in-fab)

## Operate the review queue

```sh
python -m film.marketplace --root workspace-data list
python -m film.marketplace --root workspace-data review LISTING_ID \
  --state approved --reviewer 'Reviewer name' --notes 'Actual review findings'
```

Other review outcomes are `changes_needed` and `withdrawn`. Approval rechecks the pinned asset and preview. The local seed command accepts an explicitly named, previously reviewed public world and its publication URL.

The connected download route requires workspace access and a backend-owned, unexpired subscription record at `workspace-data/marketplace/membership.json`. This boundary serves the existing shared-workspace server. Multi-user member identities and a billing provider remain to be integrated. Client flags cannot establish entitlement.

The Vercel catalog includes two previously released Gesso studies and small image covers. Their earlier public SPZ release remains available separately. Purchased credits and contributor rewards remain a proposed billing direction. No payment or credit issuance is active.
