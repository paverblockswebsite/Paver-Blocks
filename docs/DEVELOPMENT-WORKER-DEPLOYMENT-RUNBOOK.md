# Development Worker deployment runbook

**Status:** The development API Worker `paver-blocks-api-dev` is already deployed and its public inquiry flow has passed one end-to-end test. This runbook now governs remaining development admin-gateway setup. Do not deploy the admin gateway or create Access policies without separate, explicit approval. The production Pages site and `main` branch must remain untouched.

## Confirmed development resources

| Resource | Value |
|---|---|
| GitHub repository | `paverblockswebsite/Paver-Blocks` |
| Development branch | `development/site-foundation` |
| Worker name in Wrangler | `paver-blocks-api-dev` |
| Existing Workers subdomain | `hellopaverblocks.workers.dev` |
| Expected Worker origin | `https://paver-blocks-api-dev.hellopaverblocks.workers.dev` |
| Development D1 database | `paver-blocks-dev` |
| Development D1 database ID | `642fbb24-2b16-41f6-b77e-e14de49eebe8` |
| Development R2 bucket | `paver-blocks-project-images-dev` |
| R2 public access | Disabled |
| Pages preview origin | `https://development-site-foundation.paver-blocks.pages.dev` |
| Cloudflare Access team domain | `withered-frost-198b.cloudflareaccess.com` |
| Initial admin email allowlist | `hellopaverblocks@gmail.com` |

The expected Worker origin is derived from the checked-in Worker name and the account's existing Workers subdomain. Verify the actual hostname in Cloudflare after the development Worker is created; do not change the account subdomain.

## Pre-deployment safeguards

- Keep GitHub PR #1 as draft and unmerged until separately approved.
- Keep Pages production branch `main` unchanged.
- Bind only the development D1 database above. Never select a production database.
- Bind only the private development R2 bucket above. Do not enable public bucket access.
- Do not place credentials, API tokens, Turnstile secret keys, or customer information in GitHub, source files, or plain-text Wrangler variables.
- Do not create a broad Access application covering the entire Worker hostname: public API routes must remain reachable.
- Do not configure the Pages production API origin.

## Required Worker bindings and configuration

The checked-in `worker/wrangler.toml` is the source of truth for the intended development bindings:

- D1 binding: `DB` -> `paver-blocks-dev`.
- R2 binding: `PROJECT_IMAGES` -> `paver-blocks-project-images-dev`.
- Rate-limit binding: `INQUIRY_RATE_LIMITER` -> namespace `1001`, 5 attempts per 60 seconds.
- `SITE_ORIGIN` -> the exact Pages development preview origin above.
- `TURNSTILE_HOSTNAME` -> the exact Pages development preview hostname above.

Do not change the namespace ID or database ID without a deliberate review. The D1 schema has already been created manually in the development database; do not run migrations automatically during first deployment.

## Secrets and Access values

Set these only in the Worker dashboard's encrypted secrets / environment configuration after the Worker exists:

- `TURNSTILE_SECRET_KEY`: secret from a Turnstile widget restricted to the Pages development preview hostname, configured with action `inquiry`.
- `ACCESS_TEAM_DOMAIN`: `withered-frost-198b.cloudflareaccess.com`.
- `ACCESS_AUD`: audience tag copied from the narrowly scoped Cloudflare Access application after it is created.
- `ADMIN_EMAILS`: `hellopaverblocks@gmail.com`.

The Turnstile public site key is not a secret, but the public quote form must be integrated with it before inquiry submissions can work end-to-end. The Worker intentionally fails closed if the rate-limit binding or Turnstile configuration is missing.

## Remaining development admin setup (after separate approval)

1. Keep the already deployed `paver-blocks-api-dev` Worker connected only to `paver-blocks-dev` and `paver-blocks-project-images-dev`. Do not recreate or redeploy it as part of gateway setup.
2. Require green GitHub Actions results for both Worker test suites and both Wrangler dry-run checks.
3. Deploy only `paver-blocks-admin-dev` from the `worker-admin/` root on branch `development/site-foundation`. Do not deploy or change the API Worker in this step. The gateway requires a Cloudflare Access JWT assertion and must deny admin requests when that assertion is absent.
4. After the gateway appears in Cloudflare, create a Cloudflare Access application with the dedicated `paver-blocks-admin-dev` Worker as its only destination. **Never attach Access to `paver-blocks-api-dev`**, because public quote routes must remain reachable.
5. Apply a single-user Allow policy for exactly `hellopaverblocks@gmail.com`; all other identities must remain denied. Use Cloudflare's default one-time PIN login unless another identity provider is deliberately configured.
6. Copy the Access application's audience tag, then configure the API Worker's encrypted `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` values plus the `ADMIN_EMAILS` allowlist. Keep secrets and account settings out of Git.
7. Verify anonymous admin denial, allowed-admin access, disallowed-identity denial, and continued public quote form access.
8. Test admin CRUD, inquiry status updates, audit logging, R2 upload/preview/public delivery/deletion/reordering, and D1 backup/restore using dummy data only.
9. Review privacy notice, retention/deletion, cost limits, and operational backups before accepting real customer inquiries.
10. Keep PR #1 unmerged and production Pages, production Workers, production data, DNS, and domain unchanged until separate explicit approval.

## Rollback

If a development check fails, disable or roll back only the development Worker deployment and keep the Pages production project and `main` untouched. Do not delete the D1 database or R2 bucket as a troubleshooting shortcut. Preserve logs needed to diagnose the failure, without exporting customer data into GitHub.

## Explicit approval boundary

This runbook does not authorize deployment, Access application creation, secret entry, production configuration, PR merge, or DNS/domain changes. Each consequential Cloudflare action must be reviewed at the time it is performed.
