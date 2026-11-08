# Development Worker deployment runbook

**Status: preparation only. Do not deploy from this document without separate, explicit approval.** The production Pages site and `main` branch must remain untouched.

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

## Safe setup order after approval

1. Confirm the exact development branch and Worker root directory `worker/` in the Cloudflare build setup. Confirm the Wrangler configuration is detected.
2. Create/deploy only the development Worker named `paver-blocks-api-dev`; verify the actual `workers.dev` hostname. Do not edit Pages production.
3. Verify `GET /health` returns only the liveness response and that public content routes use the development D1 binding.
4. Create a Cloudflare Access self-hosted application for the verified Worker hostname. Protect the dashboard path `/admin*`, admin assets beneath it, admin media beneath it, and the API path `/api/admin/*`. Apply an allow policy for the single initial administrator email. Do not protect the whole hostname.
5. Copy the Access application's audience tag into the Worker's encrypted `ACCESS_AUD` secret/variable, and configure the other required values above. Keep `ADMIN_EMAILS` as a server-side allowlist.
6. Verify anonymous requests to every admin route are denied, the allowed administrator can reach the dashboard, and a different identity is denied.
7. Verify public reads, exact-origin CORS, rate limiting, Turnstile rejection/acceptance, inquiry writes, R2 upload/preview/public delivery/deletion/reordering, and D1 audit events with test data only.
8. Only after the public quote form is integrated and end-to-end checks pass, set the Pages **preview-only** `VITE_PUBLIC_API_BASE_URL` to the verified development Worker origin.
9. Record test results and review privacy, backup/restore, and retention decisions before collecting real customer inquiries.

## Rollback

If a development check fails, disable or roll back only the development Worker deployment and keep the Pages production project and `main` untouched. Do not delete the D1 database or R2 bucket as a troubleshooting shortcut. Preserve logs needed to diagnose the failure, without exporting customer data into GitHub.

## Explicit approval boundary

This runbook does not authorize deployment, Access application creation, secret entry, production configuration, PR merge, or DNS/domain changes. Each consequential Cloudflare action must be reviewed at the time it is performed.
