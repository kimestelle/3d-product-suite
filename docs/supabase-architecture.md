# Supabase and AWS for Gesso

Recommendation, November 7, 2026: use hosted Supabase for account and workspace
records, while AWS runs native conversion and rendering. This is an architecture
decision for the next product stage. No Supabase project, database migration or
user authentication has been connected by this audit.

| Responsibility | Recommended owner | Current implementation |
| --- | --- | --- |
| Editor | Vercel | Public static demo and connected editor build |
| Accounts, workspace membership | Supabase Auth + Postgres | One shared workspace access key |
| Projects, immutable revision references, presets | Supabase Postgres | Versioned local JSON and asset hashes |
| Membership, credit ledger, marketplace review | Supabase Postgres, server-only transitions | Local review queue; billing deferred |
| Large GLBs, SPZs, textures, export files | Private S3 with signed access | Content-addressed workspace files |
| Conversion, Cycles, Gaussian capture | AWS containers with NVIDIA GPU workers | One serial workspace queue |

Supabase combines Postgres, Auth and access policies. It can live in a specific
AWS region near the GPU workers. The region should be chosen deliberately; a
general region grouping does not guarantee the same exact worker region.
[Architecture](https://supabase.com/docs/guides/getting-started/architecture) ·
[Regions](https://supabase.com/docs/guides/platform/regions)

The existing Blender and Chromium workload does not fit hosted Edge Functions:
they currently allow 256 MB memory and 2 seconds of CPU per request. Keep them for
short authorization or webhook work if needed. Supabase does not replace the
render worker. [Function limits](https://supabase.com/docs/guides/functions/limits)

## One owner for each record

Make a workspace the ownership unit. Projects, revisions, presets, private world
builds, jobs and asset references belong to it. Users gain access through a
workspace membership table. Put row-level policies on every exposed table and
test that two unrelated users cannot read or mutate each other's records.
Marketplace browsing exposes only approved listing projections. Download access
also checks active entitlement and publication state on the server.

The browser receives a publishable key and a verified user session. Secret and
service-role keys stay on trusted servers; they bypass row policies, so a worker
using them must still authorize the job and workspace explicitly. Adding Auth to
the current single-workspace API would leave its unrestricted file routes and
shared membership record intact. Tenant routing and authorization must precede
a public multi-user launch. [Supabase security](https://supabase.com/docs/guides/database/secure-data)

## Keep assets out of database rows

Store immutable scene documents and file references in Postgres. Keep the large
binary assets in one private object store. S3 is the recommended store for this
GPU workflow, with local worker caches keyed by content hash. Supabase Storage
is a valid simpler alternative; choose one source of truth rather than mirroring
every original between both services. Both have transfer costs to account for.
[Supabase egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress)

Upload to a fresh private staging key using a short-lived upload grant. A worker
validates size, format and checksum, then publishes a content-addressed immutable
asset. Never give a client a write grant over an existing canonical hash key:
presigned S3 uploads can overwrite the named object. Issue download grants only
after authorization. [S3 signed access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)

## Evolve the queue after ownership

The first AWS deployment keeps one process and one persistent workspace. Moving
to a fleet requires transactional job claims, leases, cancellation, per-workspace
admission and isolated per-job scratch directories. An immutable job packet
continues to pin the scene, assets, renderer, samples and execution policy.
Finished frames remain resumable; shared mutable project files must not become
a fleet-wide queue. AWS Batch supports GPU jobs if a fleet becomes necessary.
[GPU jobs](https://docs.aws.amazon.com/batch/latest/userguide/gpu-jobs.html)

Credits should use an append-only ledger and atomic reservations. Bind each
provider submission and reward to a unique event so retries cannot charge or
reward twice. Ambiguous provider results remain reserved until reconciled.
Clients cannot directly edit balances, review approval or membership. These
controls remain pending along with billing; the current service capacity limits
do not implement them.
