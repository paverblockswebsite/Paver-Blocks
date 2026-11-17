# Paver Blocks — Production Backup, Restore and Retention Plan

**Status:** Production audit completed; implementation and deployment are not yet complete. This document is a plan, not an active backup service. No production data, Cloudflare resources, or settings are changed by this document.

## 1. Verified production state (17 November 2026)

- Production D1 database: `paver-blocks-production`.
- Production D1 database has 8 tables and is connected to the production API Worker.
- Cloudflare dashboard shows D1 Time Travel available for the previous 7 days. The displayed restore window during the owner check was 10–17 November 2026.
- A current Time Travel bookmark was retrieved by the owner. The bookmark is operational recovery information and must be stored privately, not committed to this public repository.
- Production API Worker configuration binds D1 as `DB` and the private R2 bucket `paver-blocks-project-images-production` as `PROJECT_IMAGES`.
- The production R2 bucket showed Standard storage, Public Access disabled, and 0 B stored at the time of the owner check.
- Project-image uploads write an object to R2 and metadata to D1. The current delete path removes the original R2 object and then its D1 metadata. There is no independent image archive in the current implementation.
- No scheduled D1 export Workflow, backup bucket binding, or automated restore process is currently configured.
- The existing production API Worker and admin dashboard are deployed. This replaces earlier project notes that incorrectly described the Worker as undeployed or the production database as unconnected.

## 2. Recovery layers

### Layer A — D1 Time Travel

Time Travel is the short-window recovery layer. The Cloudflare dashboard currently reports a 7-day restore window for this database.

A Time Travel restore overwrites the current database. It is not an independent backup and does not restore R2 image objects. Never run a production restore as a routine test.

The owner-retrieved current bookmark is not reproduced in this public repository. Keep it in a private password manager or other private operational record.

### Layer B — Independent D1 SQL exports

Recommended implementation: a separate Cloudflare Workflow, scheduled once daily during a low-traffic period, exports the production D1 database through the Cloudflare D1 Export API and saves the SQL dump plus a small manifest to a new private R2 backup bucket.

Suggested bucket name: `paver-blocks-backups-production`.

The backup bucket must be separate from the live project-image bucket, private (no public access), and used only for backups. SQL dumps contain private customer inquiry information and must never be placed in GitHub, a public bucket, or a public download route.

The D1 export API uses a polling process. Cloudflare documents that an in-progress export can make the database unavailable to serve queries until the export completes; the Workflow must poll until completion and the schedule should be placed in a quiet period. A failed or abandoned polling job must not be treated as a successful backup.

Each successful backup should record:
- database name and ID;
- export bookmark and completion timestamp;
- SQL object key and reported file name;
- backup format and success status;
- image-archive scan result.

A backup is not successful merely because a Workflow started. The SQL object and manifest must both be written successfully.

### Layer C — R2 project-image archive

The current upload path stores project images in the live R2 bucket and stores object keys in D1. The current delete path permanently deletes the live object. A D1 SQL export alone therefore cannot restore deleted image files.

Recommended implementation:
1. Add a second, private R2 binding for the backup bucket to the production API Worker.
2. When a project image is uploaded, write the image to both the live bucket and an immutable archive prefix in the backup bucket before committing its D1 metadata. If the required archive write fails, fail the upload safely and remove the incomplete live object.
3. Never delete an archived copy when an administrator deletes the live project image.
4. Include a scheduled backfill in the backup Workflow. It lists existing live project-image objects and archives any object not already present. This supports recovery for files that existed before the archive binding was enabled.
5. Keep image archive keys and SQL dump keys in separate prefixes, and never expose either through public routes.

The live production image bucket currently reports 0 B, so no existing R2 objects were visible during this audit. Static website graphics committed to GitHub are separate from this R2 bucket.

## 3. Retention and cost controls

No automatic backup deletion or lifecycle expiry is enabled by this plan. The business owner must approve a retention period before a lifecycle rule is configured.

Suggested policy for owner review:
- daily D1 exports: 30 days;
- weekly recovery points: 12 weeks;
- monthly recovery points: 12 months;
- image archive: retain at least as long as any D1 backup that may reference the image.

This is a proposal, not an approved policy. Do not implement expiry until approved. Backups may contain inquiries that have since been deleted from the live database; the privacy notice must not promise immediate removal from all backups unless the backup-expiry process guarantees it.

Cloudflare Workflows is available on the Workers Free plan, with published free quotas for requests, CPU time, steps, and workflow-state storage. R2 Standard currently includes a monthly free allowance for storage and operations. Usage beyond the applicable free allowances may be billable. Monitor usage and do not upgrade the account or enable paid services without owner approval.

## 4. Secrets and access

The backup Workflow needs a Cloudflare API token stored only as the Worker secret `D1_REST_API_TOKEN`, with the minimum D1 permission needed to export the intended database. Never send the token in chat, commit it to GitHub, or store it in ordinary Worker variables.

The Workflow should have access only to the required production D1 export API and the private backup R2 bucket. The production API Worker should have write access to the archive prefix only through its R2 binding. No public route should expose backup objects.

The backup bucket is in the same Cloudflare account. This protects against accidental deletion of live objects but not against loss or compromise of the entire Cloudflare account. An additional encrypted copy outside the account is a later resilience improvement and may introduce separate storage costs.

## 5. Restore runbook — manual and approval-gated

1. Confirm the incident, affected service, correct production database identity, and recovery point.
2. Pause or restrict application writes where practical.
3. If the database is accessible, create a fresh pre-restore export before changing production.
4. Rehearse the SQL import and image recovery on a disposable development database and isolated bucket first.
5. Obtain explicit owner approval before any production restore.
6. Restore D1 and the matching archived images. Do not assume a D1 restore also restores R2.
7. Verify table counts, indexes, foreign keys, expected inquiry records, image object availability, and Worker compatibility.
8. Reconcile valid inquiries created after the recovery point.
9. Resume writes only after verification, and record the incident and recovery outcome.

There must be no public one-click production restore endpoint and no automatic restore on backup failure.

## 6. Implementation checklist

- [ ] Create the separate private R2 backup bucket.
- [ ] Add a scheduled D1 export Workflow with polling, retries, a manifest, and clear failure reporting.
- [ ] Add immutable R2 image archiving to the production upload path.
- [ ] Add a scheduled image-archive backfill for existing objects.
- [ ] Configure the D1 export API token as a Worker secret.
- [ ] Validate Wrangler configuration and automated tests without deploying.
- [ ] Deploy only after the owner reviews the PR, creates the bucket, and configures the secret.
- [ ] Run the first backup and verify both SQL dump and image archive.
- [ ] Rehearse restore on development resources.
- [ ] Obtain owner approval for retention before enabling lifecycle expiry.
- [ ] Add a private backup-status view to the admin panel only after the backup process is proven reliable.

## 7. Explicit non-actions

- No D1 restore has been run.
- No SQL export has been created or downloaded.
- No scheduled backup has been deployed or activated.
- No R2 object has been copied, deleted, or modified.
- No production Worker, D1 database, R2 bucket, or Cloudflare setting has been changed.
- No retention or lifecycle deletion rule has been configured.
- No production backup token or secret has been created.
