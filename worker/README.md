# Paver Blocks Worker API

**Status: development code only. Not deployed. No D1 binding, Access application, Turnstile secret, or production configuration is active.**

This Worker is a separate API service intended to sit beside the Astro Pages website.

## Admin origin and Access boundary

The admin interface is planned to be served by this Worker on the same origin as its admin API. This avoids relying on cross-origin Access cookies and browser third-party-cookie behavior. The public Astro website will link to the Worker-hosted admin sign-in URL; it will not host or proxy the private admin interface.

When configuring Cloudflare Access, use a hostname/path-based self-hosted application for the Worker hostname and protect only the admin interface path (for example, `/admin*`) and admin API path (`/api/admin/*`). Do not apply a Worker-wide Access rule to this mixed public/private Worker, because that would also block the public API routes. Keep the Worker-side JWT verification and email allowlist even when the Access edge policy is enabled.

The exact hostname will be selected only after the development Worker endpoint is confirmed. No Access application or deployment is active yet.

## Implemented routes

### Public
- GET /health — basic liveness response; does not query D1.
- GET /api/public/projects
- GET /api/public/projects/:slug — published project data and approved image metadata.
- GET /api/public/services
- GET /api/public/paver-designs
- GET /api/public/testimonials — published records with permission confirmed only.
- GET /api/public/site-settings — a strict allowlist of public homepage text settings only.
- POST /api/public/inquiries — validates fields, requires Turnstile, and inserts one inquiry.

### Admin (Cloudflare Access required)
- GET /admin — private same-origin dashboard for inquiries and projects.
- GET /admin/assets/admin.css and /admin/assets/admin.js — private dashboard assets; each request also requires a verified Access JWT.
- GET /api/admin/inquiries — optional status, limit (max 100), and offset.
- PATCH /api/admin/inquiries/:id — may update only status and/or internal_notes; records an audit event.
- GET /api/admin/projects — lists project records, including drafts and archived records.
- POST /api/admin/projects — creates a project as draft by default; supports explicit draft/published/archived status.
- PATCH /api/admin/projects/:id — edits allowlisted project fields and records an audit event.
- GET /api/admin/services — lists all service records.
- POST /api/admin/services — creates a service as draft by default.
- PATCH /api/admin/services/:id — edits allowlisted service fields and records an audit event.
- GET /api/admin/paver-designs — lists all paver design records.
- POST /api/admin/paver-designs — creates a paver design as draft by default.
- PATCH /api/admin/paver-designs/:id — edits allowlisted design fields and records an audit event.
- GET /api/admin/testimonials — lists testimonials, including drafts and permission state.
- POST /api/admin/testimonials — creates a testimonial; publishing requires explicit permission confirmation.
- PATCH /api/admin/testimonials/:id — edits a testimonial and enforces permission before publication.
- GET /api/admin/homepage-content — reads approved homepage text fields.
- PATCH /api/admin/homepage-content — updates only allowlisted homepage text fields and records an audit event.

The dashboard currently supports inquiry review/status updates, plus listing, creation, and editing for projects, services, paver designs, and testimonials, along with a small homepage text editor. Testimonials must have explicit customer permission before publication. Homepage settings expose only approved public text keys; internal settings and customer data are not exposed. Project deletion, project image uploads, testimonial deletion, and broader site settings are not implemented. Other admin CRUD routes intentionally remain unavailable until their validation and authorization tests are implemented.

## Local smoke tests

Run `npm test` from the worker directory with Node.js 22 or later. These tests cover health, public read routing, CORS rejection, Access identity validation, dashboard and asset access controls, request validation, and authenticated project create/edit operations with audit logging. They are smoke tests, not a substitute for live Cloudflare D1, Access, and Turnstile integration tests.

## Required environment configuration

Configure these as Worker environment variables/secrets in the Cloudflare dashboard only. Never commit real values:

- SITE_ORIGIN — exact allowed website origin, e.g. the approved development Pages preview origin.
- TURNSTILE_SECRET_KEY — secret key for the Turnstile widget used by the inquiry form.
- TURNSTILE_HOSTNAME — expected hostname returned by Turnstile verification.
- ACCESS_TEAM_DOMAIN — Access team hostname, e.g. your-team.cloudflareaccess.com (hostname only or full HTTPS URL).
- ACCESS_AUD — audience tag for the protected Access application.
- ADMIN_EMAILS — comma-separated allowlist of administrator email addresses. For the initial administrator, set this dashboard variable to `hellopaverblocks@gmail.com`; do not add it to source code or `wrangler.toml`.

The D1 binding must be named DB. It is deliberately not configured here. Bind only the development database after a separate review and approval.

## Security and deployment prerequisites

1. Add a Cloudflare rate-limiting rule for POST /api/public/inquiries before enabling public submissions. Turnstile is required in the code but is not a substitute for rate limiting.
2. Create a Turnstile widget for the exact development hostname, set its action to inquiry, and store its secret as a Worker secret. The API requires a matching hostname and action in the Siteverify response.
3. Create a Cloudflare Access self-hosted application for the Worker hostname and protect `/admin*` plus `/api/admin/*` paths. This must include the dashboard HTML and its assets. Restrict its policy to intended administrators.
4. Set the Worker environment values and a narrowly scoped ADMIN_EMAILS allowlist.
5. Bind only the development D1 database as DB; never bind production D1 in this development Worker.
6. Test unauthorized requests, invalid JWTs, wrong origins, missing/invalid Turnstile tokens, invalid fields, and private inquiry access before any public launch.
7. Configure monitoring, backup/retention, and a customer-data deletion policy before collecting real inquiries.

## Important implementation notes

- Admin identity is accepted only after verifying the Cloudflare Access JWT signature against the team's published RSA keys, issuer, audience, expiry, and email allowlist. The Worker does not trust a bare email header.
- SQL values are bound parameters. Public SQL selects explicit public fields and only published content.
- The API never returns inquiry data from a public route.
- Error responses do not expose database or verification internals.
- This is an initial API implementation, not a completed production security review.