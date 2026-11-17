# Paver Blocks production backup Worker

This is a separate Cloudflare Worker containing a scheduled Cloudflare Workflow. It is not the public API or Admin Worker, and it exposes no backup or restore HTTP endpoint.

## What it does

- Runs daily at 21:00 UTC (02:00 Pakistan Standard Time).
- Archives existing project-image objects from the live private R2 bucket into the private backup bucket under the `images/` prefix.
- Requests a D1 SQL export in Cloudflare's import-compatible `d1` format.
- Polls the D1 export endpoint until it completes (maximum 40 polls, 10 seconds apart).
- Downloads the signed SQL export directly into the private backup bucket under `d1/YYYY-MM-DD/`. The temporary signed URL is kept inside one Workflow step and is not returned as Workflow state.
- Writes a JSON manifest under `manifests/YYYY-MM-DD/` only after the SQL object is stored successfully.
- Fails the Workflow if the export or storage operation fails. A started Workflow is not treated as a successful backup.

The SQL export can temporarily make D1 unavailable for queries while it is running. The 02:00 Pakistan schedule is intended to reduce impact, but it does not eliminate that Cloudflare platform behavior.

## Required Cloudflare resources

1. The private R2 bucket `paver-blocks-backups-production` has been created by the owner. Keep Public Access **Disabled**. Do not add a public custom domain or public download route.
2. Bind the bucket as `BACKUPS` in this Worker and as `PROJECT_IMAGE_ARCHIVE` in the production API Worker.
3. Bind the live `paver-blocks-project-images-production` bucket as `PROJECT_IMAGES` in this Worker.

The SQL backups and archived images share one private bucket but use separate prefixes. The archive code checks for an existing object before copying, but R2 does not provide a separate immutable-retention policy here; protect the bucket with access controls and do not configure lifecycle deletion without owner approval.

## Required Worker secrets

Configure these as encrypted secrets on the `paver-blocks-production-backup` Worker:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.
- `D1_REST_API_TOKEN`: a dedicated API token with the minimum D1 Edit permission required to export the intended database.

Never put either value in Git, ordinary variables, a public issue, or chat. The D1 database name and ID are non-secret configuration values in `wrangler.toml`; verify them against the production D1 dashboard before deployment.

## Deployment order — owner review required

1. Confirm the private backup bucket remains private.
2. Review this code and its GitHub Actions tests.
3. Configure the production API Worker's `PROJECT_IMAGE_ARCHIVE` binding to that bucket. Its production config sets `REQUIRE_IMAGE_ARCHIVE = "true"`; image uploads will fail closed if the required archive binding is missing or archive writes fail.
4. Deploy the production API Worker only after the bucket binding is confirmed.
5. Create the separate backup Worker from this directory (`backup-worker`) and configure both encrypted secrets.
6. Deploy the backup Worker and confirm the Workflow schedule is registered.
7. Verify the first completed Workflow run, SQL object, and manifest in the private bucket.
8. Rehearse SQL restore only against a disposable development database and isolated image bucket.

No production restore endpoint or automatic restore is included. Never restore production without a separate incident review, a fresh pre-restore backup, and the owner's explicit approval.

## Free-tier and cost notes

Cloudflare lists Workflows as available on Workers Free. Published free quotas include limits for Workflow steps and state storage; Workflows also share Workers request and CPU quotas. R2 and Workers usage beyond applicable free allowances may be billable. Monitor account usage; do not upgrade the plan or enable paid services without owner approval.

## Current state

The private backup bucket has been created and confirmed with Public Access disabled. The code and tests are prepared in GitHub PR #43. This Worker and the updated production API Worker have **not** been deployed; no SQL export, image copy, or restore has been run. The API token and Worker secrets have not been created.
