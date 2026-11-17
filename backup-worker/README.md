# Paver Blocks production backup Worker

This is a separate Cloudflare Worker containing a scheduled Cloudflare Workflow. It is not the public API or Admin Worker, and it exposes no backup or restore HTTP endpoint.

## What it does

- Runs daily at 21:00 UTC (02:00 Pakistan Standard Time).
- Archives existing project-image objects from the live private R2 bucket into the private backup bucket, using the immutable `images/` prefix.
- Requests a D1 SQL export in Cloudflare's import-compatible `d1` format.
- Polls the D1 export endpoint until it completes (maximum 40 polls, 10 seconds apart).
- Streams the signed SQL export into the private backup bucket under `d1/YYYY-MM-DD/`.
- Writes a JSON manifest under `manifests/YYYY-MM-DD/` only after the SQL object is stored successfully.
- Fails the Workflow if the export or storage operation fails. A started Workflow is not treated as a successful backup.

The SQL export can temporarily make D1 unavailable for queries while it is running. The 02:00 Pakistan schedule is intended to reduce impact, but it does not eliminate that Cloudflare platform behavior.

## Required Cloudflare resources

1. Create a new R2 bucket named `paver-blocks-backups-production`.
2. Keep Public Access **Disabled**. Do not add a public custom domain or public download route.
3. Bind the same bucket as `BACKUPS` in this Worker and as `PROJECT_IMAGE_ARCHIVE` in the production API Worker.
4. Bind the live `paver-blocks-project-images-production` bucket as `PROJECT_IMAGES` in this Worker.

The SQL backups and archived images share one private bucket but use separate prefixes. Do not use the live project-image bucket as the backup destination.

## Required Worker secrets

Configure these as encrypted secrets on the `paver-blocks-production-backup` Worker:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- `D1_REST_API_TOKEN`: a dedicated API token with the minimum D1 Edit permission required to export the intended database.

Never put either value in Git, ordinary variables, a public issue, or chat. The D1 database name and ID are non-secret configuration values in `wrangler.toml`; verify them against the production D1 dashboard before deployment.

## Deployment order — owner review required

1. Create the private backup R2 bucket.
2. Review this code and its GitHub Actions tests.
3. Configure the production API Worker's `PROJECT_IMAGE_ARCHIVE` binding to that bucket. Its production config sets `REQUIRE_IMAGE_ARCHIVE = "true"`; image uploads will fail closed if the archive binding is absent or unavailable.
4. Deploy the production API Worker only after the bucket exists and the binding is confirmed.
5. Create the separate backup Worker from this directory (`backup-worker`) and configure both encrypted secrets.
6. Deploy the backup Worker and confirm the Workflow schedule is registered.
7. Verify the first completed Workflow run, SQL object, and manifest in the private bucket.
8. Rehearse SQL restore only against a disposable development database and isolated image bucket.

No production restore endpoint or automatic restore is included. Never restore production without a separate incident review, a fresh pre-restore backup, and the owner's explicit approval.

## Free-tier and cost notes

Cloudflare lists Workflows as available on Workers Free. The published Free limits include 3,000 Workflow steps per day and 1 GB-month of Workflow state storage; Workflows share Workers request and CPU quotas. R2 and Workers usage beyond the applicable free allowances may be billable. Monitor account usage; do not upgrade the plan or enable paid services without owner approval.

## Current state

The code and tests are prepared in GitHub PR #43. This Worker has **not** been deployed, no backup bucket or API token has been created, and no export or restore has been run.
