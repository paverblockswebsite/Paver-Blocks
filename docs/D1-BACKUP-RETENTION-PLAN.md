# Paver Blocks — D1 Backup, Restore, Retention and Audit Plan

**Status:** Review/design only. This document does not create a backup, schedule a job, change D1, delete data, or deploy a Worker.

## Current verified project state

- The development D1 database is `paver-blocks-dev`; it contains the application schema but no real customer inquiries.
- The migration defines separate `inquiries` and `admin_audit_log` tables.
- Inquiry updates and content-management mutations are submitted together with an audit-log insert using D1 batch operations.
- Audit entries currently store administrator email, action, entity type, entity ID, and timestamp. Inquiry phone numbers, email addresses, and message bodies are not copied into audit entries.
- There is no implemented retention job, inquiry deletion workflow, audit-log viewer, or configured external export schedule.
- The Worker remains undeployed. No production database is connected.

## Cloudflare D1 recovery facts (must be checked against this database)

Cloudflare's current D1 documentation describes Time Travel as automatic point-in-time recovery, without a manual enable step, for databases on the production storage subsystem. The documented restore window is up to 7 days on Workers Free and up to 30 days on Workers Paid. The database's actual `version` must be checked; the project must not assume this database is eligible until that value is confirmed.

A Time Travel restore overwrites the database in place. It is a recovery mechanism, not a substitute for an independently stored export or a tested restore procedure.

D1 also supports SQL export/import. Cloudflare documents that a running export blocks other database requests. Export files can contain private inquiry details and must never be committed to this public repository or stored in a public bucket.

References:
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/

## Proposed backup approach — approval required before implementation

1. Confirm the D1 storage `version` and effective Time Travel retention for the actual database.
2. Rely on Time Travel for short-window recovery only after eligibility and retention are verified.
3. Before any schema migration or destructive data operation, capture a fresh SQL export and record its timestamp and database identity.
4. Once real inquiries exist, schedule periodic SQL exports to a private backup destination. Keep an additional encrypted copy outside the same Cloudflare account for account-level recovery.
5. Never put SQL exports, inquiry records, or backup credentials in GitHub.
6. Test recovery using a separate disposable development database first. Never rehearse restore on the live customer database.
7. Document who may initiate restore, how the incident is approved, and how post-restore data loss is assessed.

Suggested starting cadence for owner review: daily encrypted export while customer inquiries are actively collected, plus a pre-migration export. This is a proposal, not an active schedule.

## Data retention — owner decision required

No automatic deletion should be added until the business owner approves a written retention period.

Decisions required:
- How long to retain new/unresolved inquiries with no recent activity.
- How long to retain closed, completed, or declined inquiries.
- Whether a customer deletion request should remove or anonymize the inquiry, subject to any legitimate business recordkeeping need.
- How long to retain audit events.
- Whether backups containing deleted inquiries should expire on a separate schedule.

Recommended safeguards:
- Retention should be based on the inquiry's last meaningful activity, not only its creation date.
- Do not delete open quotations or active project discussions automatically.
- Keep audit events free of customer contact details and inquiry contents.
- Any deletion/anonymization operation must be admin-only, narrowly scoped, logged, and tested against a development copy first.
- Backups may retain deleted records until their documented expiry; the privacy notice must not promise immediate erasure from every backup unless that is technically guaranteed.

## Audit-log review

Current strengths:
- Mutations write the business change and audit event in the same D1 batch.
- Events identify the verified administrator and affected entity.
- The audit table has a descending timestamp index.
- No public API exposes the audit table.

Gaps before launch:
- The application does not currently expose an authenticated audit-log viewer.
- No retention/rotation process exists.
- Append-only behavior is a design intention, not a database-enforced guarantee; no triggers currently prevent direct SQL updates/deletes.
- Audit events do not record before/after values. Keep this minimal by default; do not add customer PII or full inquiry contents to audit events.
- Define a safe procedure for exceptional audit-log deletion/retention maintenance before adding any cleanup task.

## Restore runbook outline

1. Stop or pause writes to the affected application.
2. Identify the correct database and recovery point; confirm the incident and approval.
3. Export the current state before any in-place restore, if the database is accessible.
4. Restore only the development database during rehearsal. For a production incident, follow a separately approved incident procedure.
5. Verify table counts, indexes, foreign keys, latest expected records, and Worker compatibility.
6. Reconcile any valid inquiries created after the selected recovery point.
7. Resume writes only after verification and record the recovery action in the incident log.

## Explicit non-actions

- No restore has been run.
- No backup has been exported or downloaded.
- No backup schedule or Workflow has been created.
- No retention period has been selected or implemented.
- No customer or audit records have been deleted.
- No Cloudflare settings, production resources, Worker deployment, or PR merge have been changed.
