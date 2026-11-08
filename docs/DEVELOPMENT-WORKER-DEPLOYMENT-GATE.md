# Development Worker deployment gate

**Current state: do not deploy yet.** This checklist is a review aid, not authorization to deploy or change Cloudflare settings. The Worker source remains on `development/site-foundation`; the production Pages site and `main` branch must remain untouched.

## Before any development deployment

- [ ] Review the Worker source, Wrangler configuration, migration, and security plan at the exact commit proposed for deployment.
- [ ] Confirm `worker/wrangler.toml` still names `paver-blocks-api-dev`, uses `src/index.js`, and contains no production database ID, binding, token, or secret.
- [ ] Confirm there is no CI workflow or package script that deploys the Worker automatically.
- [ ] Confirm the target hostname is the intended development `workers.dev` hostname and does not replace or alter the account subdomain.
- [ ] Create/verify a development-only Cloudflare Access application protecting only `/admin*` and `/api/admin/*`; keep public API routes outside that Access application.
- [ ] Set the approved development `SITE_ORIGIN`, Turnstile hostname, Access team domain, Access audience, and administrator allowlist in the Worker dashboard. Store the Turnstile secret only as an encrypted Worker secret.
- [ ] Bind only the existing `paver-blocks-dev` D1 database as `DB`. Do not bind a production database.
- [ ] Add a rate limit for `POST /api/public/inquiries` before accepting public submissions.
- [ ] Run unit tests and verify Access, Turnstile, origin, validation, and D1 behavior with dummy data.
- [ ] Verify unauthorized admin HTML, CSS, JavaScript, and API requests all fail closed; verify the approved admin can access them.
- [ ] Verify public routes cannot read inquiries and that no real customer data is used.
- [ ] Review logging, backup/retention, deletion, and cost controls before enabling any real submissions.

## Explicit approval gates

1. **Configuration review:** no Cloudflare dashboard changes until the development hostname, Access route patterns, variables, and D1 binding are reviewed together.
2. **Development deployment:** deploy only after the user explicitly approves the exact development deployment.
3. **Production:** no production Worker, database, domain routing, or customer-data migration without a separate review and explicit approval. A successful development deployment does not authorize production deployment.

## Known implementation limits

The current admin interface supports inquiry viewing, status updates, and internal notes only. Project, gallery, service, paver-design, testimonial, and site-settings management are not implemented yet. R2 uploads are not implemented. Do not present this as a complete CMS or production-ready system.
