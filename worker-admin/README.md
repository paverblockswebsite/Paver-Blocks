# Development admin gateway

## Purpose

`paver-blocks-admin-dev` is a dedicated, admin-only gateway in front of the existing `paver-blocks-api-dev` Worker. It exists because Cloudflare Access protection on a Worker destination can cover the whole Worker hostname; protecting the mixed-purpose API Worker directly could block the public quotation form.

## Allowed paths

The gateway accepts only:

- `/admin` and `/admin/*`
- `/api/admin/*`

All other paths return 404 without contacting the API Worker. Only GET, POST, PATCH, DELETE, and HEAD are accepted. Requests require the Cloudflare Access JWT assertion. The gateway removes the browser Access cookie and forwards the signed assertion to the API Worker, which independently verifies its signature, issuer, audience, expiry, and administrator email allowlist.

## Development configuration

- Worker name: `paver-blocks-admin-dev`
- Wrangler root: `worker-admin/`
- Upstream: development API Worker only, via `API_ORIGIN` in `wrangler.toml`
- No production API origin is permitted in this development configuration.

## Current state

- Gateway source and smoke tests are committed to `development/site-foundation`.
- Automated CI runs gateway tests and Wrangler dry-run validation.
- Gateway is **not deployed**.
- Cloudflare Access application is **not configured**.
- API Worker admin allowlist and Access JWT settings still need configuration before admin access can work.
- Do not protect the mixed-purpose API Worker hostname with Access.
- Do not merge PR #1 or change the production Pages branch, production Worker, production database, DNS, or domain as part of this setup.

## Safe deployment sequence (only after separate approval)

1. Require green gateway smoke tests and Wrangler dry-run in GitHub Actions.
2. Review the exact Cloudflare Worker destination and create an Access application for the gateway Worker only.
3. Apply a single-user allow policy for the business owner's confirmed account.
4. Deploy only `paver-blocks-admin-dev` from `worker-admin/`.
5. Configure the API Worker Access issuer, audience, and admin email allowlist as dashboard-side variables/secrets; never commit secrets.
6. Verify anonymous denial, allowed-admin success, disallowed-identity denial, and that public quote submission remains reachable.
7. Keep all production changes behind separate explicit approval.
