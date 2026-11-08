# Paver Blocks Worker API

**Deployment status: GitHub Workers Builds is connected to the development/site-foundation branch with root directory /worker. The application Worker code has been deployed successfully to the development Worker, and its /health endpoint returned {"ok":true}. The Cloudflare dashboard confirms the DB, PROJECT_IMAGES, and INQUIRY_RATE_LIMITER bindings are connected. The development D1 database and private R2 bucket exist, and Wrangler declares bindings for both. Access application, Turnstile secret, and Worker runtime secrets still need configuration before protected admin and inquiry flows can be used.**

This Worker is a separate API service intended to sit beside the Astro Pages website.

## Admin origin and Access boundary

The admin interface is planned to be served by this Worker on the same origin as its admin API. This avoids relying on cross-origin Access cookies and browser third-party-cookie behavior. The public Astro website will link to the Worker-hosted admin sign-in URL; it will not host or proxy the private admin interface.

When configuring Cloudflare Access, use a hostname/path-based self-hosted application for the Worker hostname and protect only the admin interface path (for example, `/admin*`) and admin API path (`/api/admin/*`). Do not apply a Worker-wide Access rule to this mixed public/private Worker, because that would also block the public API routes. Keep the Worker-side JWT verification and email allowlist even when the Access edge policy is enabled.

The intended development Worker name is `paver-blocks-api-dev` on the account's existing `workers.dev` subdomain. Confirm the final hostname before configuring Access. The development Worker is deployed and its health endpoint is verified; no Access application or Access audience is configured yet.

## Deployment status and safety

Workers Builds is connected to `paverblockswebsite/Paver-Blocks`, production branch `development/site-foundation`, and root directory `/worker`. Preview builds are disabled. The deployment command is `npx wrangler deploy`; no build command or build-time variables/secrets are configured. The application-code build completed successfully, and the /health endpoint returned {"ok":true}. This Worker must remain development-only; do not merge the draft pull request or deploy Pages production without separate approval.

## Browser security boundaries

- CORS headers are issued only for `/api/public/*` and only to the exact configured `SITE_ORIGIN`. The public CORS method allowlist is GET, POST, and OPTIONS.
- Admin pages, assets, and `/api/admin/*` never receive cross-origin CORS permission. The public website origin cannot use its public API CORS allowlist to reach private admin routes.
- Admin POST/PATCH requests require an exact `Origin` match with the Worker origin. If `Sec-Fetch-Site` is present, it must be `same-origin`. Requests without Origin or marked cross-site are rejected before any admin handler or database operation.
- Admin API JSON responses use `Cache-Control: no-store`, `Pragma: no-cache`, and `X-Content-Type-Options: nosniff`. The dashboard and its assets are also served with no-store caching.
- The dashboard uses same-origin fetches and does not manage its own password or session cookie. Cloudflare Access is intended to provide the browser session at the edge; the Worker independently verifies the signed Access JWT and administrator email allowlist on every protected request.
- The Access application is not configured yet. Before public use, protect both `/admin*` and `/api/admin/*` on the exact Worker hostname. Do not apply Access to the whole mixed public/private Worker hostname.

## Implemented routes

### Public
- GET /health — basic liveness response; does not query D1.
- GET /api/public/projects
- GET /api/public/projects/:slug — published project data and approved image metadata.
- GET /media/projects/:project-id/:image-id.(jpg|png|webp) — serves only validated image objects from the development R2 bucket.
- GET /api/public/services
- GET /api/public/paver-designs
- GET /api/public/testimonials — published records with permission confirmed only.
- GET /api/public/site-settings — a strict allowlist of public homepage text settings only.
- POST /api/public/inquiries — requires the development rate-limit binding, validates fields, requires Turnstile, and inserts one inquiry.

### Admin (Cloudflare Access required)
- GET /admin — private same-origin dashboard for inquiries and projects.
- GET /admin/assets/admin.css and /admin/assets/admin.js — private dashboard assets; each request also requires a verified Access JWT.
- GET /api/admin/inquiries — optional status, limit (max 100), and offset.
- PATCH /api/admin/inquiries/:id — may update only status and/or internal_notes; records an audit event.
- GET /api/admin/projects — lists project records, including drafts and archived records.
- POST /api/admin/projects — creates a project as draft by default; supports explicit draft/published/archived status.
- PATCH /api/admin/projects/:id — edits allowlisted project fields and records an audit event.
- POST /api/admin/projects/:id/images — Access-protected multipart image upload; accepts JPEG, PNG, and WebP up to 5 MB, verifies file signatures, requires alt text, stores the object in R2, and records image metadata plus an audit event in D1.
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

The dashboard currently supports inquiry review/status updates, plus listing, creation, and editing for projects, services, paver designs, and testimonials, along with a small homepage text editor. Project image galleries support upload, preview, reordering, and deletion. Testimonials must have explicit customer permission before publication. Homepage settings expose only approved public text keys; internal settings and customer data are not exposed. Project deletion, testimonial deletion, and broader site settings are not implemented. Other admin CRUD routes intentionally remain unavailable until their validation and authorization tests are implemented.

## Public homepage content connection

The Astro homepage can read the allowlisted public text settings from `GET /api/public/site-settings`. Configure the Pages build-time variable `VITE_PUBLIC_API_BASE_URL` to the HTTPS origin of the development Worker only after that Worker has been deployed and its public route has been verified. This is a public origin value, not a secret. Do not put API secrets or Access credentials in Pages variables with a `VITE_` prefix.

If this variable is unset, the homepage keeps its static approved copy. If the API is unavailable, returns an error, or contains invalid/empty values, the same static copy remains visible. The browser requests only the public settings route, omits credentials, and writes returned strings through `textContent`; it does not call admin routes. Set the Worker `SITE_ORIGIN` to the exact Pages preview origin to permit the browser request through CORS. Do not configure a production API origin until separately reviewed and approved.

## Development-only Cloudflare bindings

The Worker configuration declares an R2 binding named `PROJECT_IMAGES` for the development bucket `paver-blocks-project-images-dev`. The private development bucket `paver-blocks-project-images-dev` has been created in Cloudflare with Standard storage class and Public Access disabled. The Wrangler binding name and bucket name match. The Cloudflare dashboard confirms the Worker PROJECT_IMAGES binding points to this private bucket. No project images have been uploaded yet; end-to-end upload and delivery still require live integration testing. Uploads accept JPEG, PNG, or WebP only, cap file size at 5 MiB, check the file signature, require descriptive alt text, and use random object keys. Public image delivery validates the object-key format and D1 ownership, serves only published-project images and approved MIME types, and sets `nosniff`; public responses use a one-hour cache lifetime while draft admin previews are private and no-store. No public R2 bucket access is enabled by this code; media is served through the Worker route.

The checked-in `worker/wrangler.toml` binds only the development D1 database `paver-blocks-dev` (database ID `642fbb24-2b16-41f6-b77e-e14de49eebe8`) as `env.DB`. It also allows the exact stable Pages branch-preview origin `https://development-site-foundation.paver-blocks.pages.dev` through `SITE_ORIGIN`, and sets the matching Turnstile hostname for later inquiry-form setup. These are public development configuration values, not secrets.

This config change does not run migrations, create an Access application, configure an Access audience, or set any secret. The D1 schema was already created manually in the development database and should be checked against `migrations/0001_initial.sql` before any future migration command. Do not run migration commands until the separate development setup review is complete. Production resources remain out of scope.

## Inquiry rate limiting

The inquiry route checks `env.INQUIRY_RATE_LIMITER` before reading the request body or touching D1. If the binding is absent or errors, the route fails closed with HTTP 503; if the limit is exceeded, it returns HTTP 429. The planned initial setting is 5 attempts per 60 seconds per client IP key, using the Cloudflare Workers Rate Limiting API. This is an approximate limit maintained separately in each Cloudflare location, not a strict global cap. IP-based counters can affect multiple legitimate visitors who share a mobile-carrier or office IP address, so the threshold must be reviewed against real development traffic before production use.

The development Wrangler binding is configured with namespace ID `1001`, after confirming that no other Worker exists in this Cloudflare account. The initial setting is 5 attempts per 60 seconds. Cloudflare requires each namespace ID to be a positive integer unique within the account; bindings that reuse an ID share counters. The ID is a developer-defined configuration value, not a secret. The Cloudflare dashboard confirms the INQUIRY_RATE_LIMITER binding is connected. Public inquiry submission remains unavailable until the required Turnstile widget and secret are configured and end-to-end tested. The code fails closed with HTTP 503 whenever the binding is absent or errors. Cloudflare recommends avoiding IP keys where possible because many legitimate visitors can share one IP; IP is being used only as a temporary anonymous-form abuse key and must be reviewed before production.

## Local smoke tests

Run `npm test` from the worker directory with Node.js 22 or later. These tests cover health, public read routing, CORS rejection, Access identity validation, dashboard and asset access controls, request validation, authenticated project create/edit operations with audit logging, and project image upload/delivery/deletion/reordering safeguards. They are smoke tests, not a substitute for live Cloudflare D1, Access, and Turnstile integration tests.

## Required environment configuration

Configure these as Worker environment variables/secrets in the Cloudflare dashboard only. Never commit real values:

- INQUIRY_RATE_LIMITER — development-only Workers Rate Limiting binding configured in `worker/wrangler.toml` with namespace ID `1001`, 5 per 60 seconds. Do not reuse this namespace ID for another independent limiter in the same account.
- SITE_ORIGIN — exact allowed website origin, e.g. the approved development Pages preview origin.
- TURNSTILE_SECRET_KEY — secret key for the Turnstile widget used by the inquiry form.
- TURNSTILE_HOSTNAME — expected hostname returned by Turnstile verification.
- ACCESS_TEAM_DOMAIN — Access team hostname, e.g. your-team.cloudflareaccess.com (hostname only or full HTTPS URL).
- ACCESS_AUD — audience tag for the protected Access application.
- ADMIN_EMAILS — comma-separated allowlist of administrator email addresses. For the initial administrator, set this dashboard variable to `hellopaverblocks@gmail.com`; do not add it to source code or `wrangler.toml`.

The D1 binding must be named `DB`; the Wrangler file currently points only to the development database. Do not add or switch to a production database.

## Security and deployment prerequisites

1. Review the development `INQUIRY_RATE_LIMITER` binding (namespace `1001`, 5 per 60 seconds) for POST `/api/public/inquiries`. The binding is defined in Wrangler config and should become active with the first application-code deployment. Do not reuse its namespace ID for another independent limiter. The IP key is temporary due to shared-IP false-positive risk. Turnstile is also required and is not a substitute for rate limiting.
2. Create a Turnstile widget for the exact development hostname, set its action to inquiry, and store its secret as a Worker secret. The API requires a matching hostname and action in the Siteverify response.
3. After a Cloudflare-managed public hostname is configured and can be selected as a path-scoped destination, create a Cloudflare Access self-hosted application protecting `/admin*` plus `/api/admin/*` only. Do not select a Worker-wide destination for this mixed public/private Worker. Restrict its policy to intended administrators.
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
