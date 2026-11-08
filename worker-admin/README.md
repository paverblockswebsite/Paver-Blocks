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
- The gateway code pins the upstream to the exact development API origin `https://paver-blocks-api-dev.hellopaverblocks.workers.dev`; production or any other origin fails closed, even if a dashboard variable is changed.

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
2. Deploy only `paver-blocks-admin-dev` from the `worker-admin/` root, using the `development/site-foundation` branch. Do not deploy or change the API Worker in this step. Before Access is attached, the gateway must remain unusable for admin requests because it requires a Cloudflare Access JWT assertion.
3. After the gateway appears in Cloudflare, create a Cloudflare Access application whose only destination is `paver-blocks-admin-dev`. Never select `paver-blocks-api-dev`.
4. Apply a single-user Allow policy for exactly `hellopaverblocks@gmail.com`; leave all other identities denied. Use the default one-time PIN login unless a different identity provider is deliberately configured.
5. Copy the Access application's audience tag and configure the API Worker's `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ADMIN_EMAILS` dashboard-side values. Keep secrets and account settings out of Git.
6. Verify anonymous admin denial, allowed-admin success, disallowed-identity denial, and that public quote submission remains reachable.
7. Keep all production changes behind separate explicit approval. Do not merge PR #1 or change production Pages, Workers, databases, DNS, or domain.
