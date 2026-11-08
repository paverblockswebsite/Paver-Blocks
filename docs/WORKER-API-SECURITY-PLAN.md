# Paver Blocks — Worker API and Admin Security Plan

**Status (development only):** `paver-blocks-api-dev` is deployed and connected to the development D1 database, private R2 bucket, and inquiry rate-limit binding. The public quote form has passed a real development test: Turnstile displayed success and one test inquiry was saved in `paver-blocks-dev`. The Turnstile secret and development hostname settings are configured. The separate `paver-blocks-admin-dev` gateway is code-only and has not been deployed. No Cloudflare Access application is configured yet; the API Worker admin allowlist and Access JWT settings still need to be configured. Production Pages, production data, DNS, and `main` remain outside this development setup.

## 1. Security boundary

- The public website may read only published, public-facing records.
- The public website may submit a new quotation inquiry.
- Public requests must never list, read, edit, or delete customer inquiries.
- All admin routes must require Cloudflare Access authentication and a verified identity on the server. Hiding an admin link in the browser is not authentication.
- The Worker must deny admin access by default if identity headers are missing, malformed, or untrusted.
- Never store passwords in this application database. Cloudflare Access is the planned identity gate.
- Never put API tokens, database credentials, or customer records in Git.

## 2.1 Admin origin and Access boundary

The admin interface should be served by the Worker on the same origin as its admin API. This avoids depending on cross-origin Access cookies, CORS credential configuration, and browser third-party-cookie behavior. The public Astro Pages site should link to the Worker-hosted admin URL rather than embedding or proxying the private admin interface.

Cloudflare Access Worker destinations protect the selected Worker hostname as a whole, so do not attach an Access application directly to the mixed-purpose `paver-blocks-api-dev` Worker: doing so could block the public quote API. Instead, use the dedicated `paver-blocks-admin-dev` gateway hostname as the Access-protected entry point. The gateway accepts only `/admin`, `/admin/*`, and `/api/admin/*`, then forwards those requests to the API Worker. Keep the API's independent JWT signature, issuer, audience, expiry, and administrator-email checks. The gateway is not deployed and the Access application is not configured yet; confirm the exact Worker destination and allow policy before creating either.

Cloudflare documents hostname/path Access protection for Workers, including `workers.dev` hostnames, and documents that browser CORS requests to Access-protected origins require an Access authorization cookie. This is why the same-origin admin design is preferred over a cross-origin admin dashboard. The final hostname and exact Access path patterns must be reviewed in the dashboard before enabling anything.

## 1.1 Browser request, CSRF, and cache controls

- CORS is limited to `/api/public/*` and the exact configured public Pages origin. It does not grant the public website cross-origin access to admin routes.
- Admin routes are same-origin only. Cross-origin requests to `/admin`, its assets, and `/api/admin/*` are rejected.
- Admin POST/PATCH requests require an exact same-origin `Origin`; when `Sec-Fetch-Site` is supplied it must equal `same-origin`. This check runs before admin handlers and D1 access.
- Admin API responses are marked `no-store`, `no-cache`, and `nosniff` to reduce the chance of private inquiry data being retained by browser or intermediary caches.
- The dashboard has no application-managed password or session cookie. Cloudflare Access provides the edge session and injects a signed JWT; the Worker verifies the JWT and explicit admin email allowlist on every protected request. The Access application is not configured yet; it must protect the dedicated admin-gateway Worker hostname only, while the API Worker continues its independent JWT and email-allowlist checks.

## 2. Proposed public API

| Method and route | Purpose | Access |
| --- | --- | --- |
| GET /api/public/projects | Published project summaries | Public |
| GET /api/public/projects/:slug | One published project and its approved images | Public |
| GET /api/public/services | Published services | Public |
| GET /api/public/paver-designs | Published paver designs | Public |
| GET /api/public/testimonials | Testimonials with confirmed permission and published status | Public |
| POST /api/public/inquiries | Submit a quotation inquiry | Public, rate-limited and spam-protected |

Public endpoints must return only fields required by the public site. They must not serialize database rows wholesale.

## 3. Proposed admin API

All routes below require server-verified Cloudflare Access identity:

| Method and route | Purpose |
| --- | --- |
| GET /api/admin/inquiries | List inquiries for authorized admins |
| PATCH /api/admin/inquiries/:id | Update inquiry status and internal notes |
| GET /api/admin/projects | List project records, including drafts |
| POST /api/admin/projects | Create a project |
| PATCH /api/admin/projects/:id | Edit a project |
| DELETE /api/admin/projects/:id | Delete a project and its image records |
| CRUD /api/admin/services | Manage service content |
| CRUD /api/admin/paver-designs | Manage paver designs |
| CRUD /api/admin/testimonials | Manage testimonials and permission evidence |
| CRUD /api/admin/site-settings | Manage an explicit allowlist of editable site settings |
| GET /api/admin/audit-log | Read administrative audit events |

The final route contract may change during implementation. Do not expose an endpoint until its authorization and validation tests exist.

## 4. Inquiry submission safeguards

- Validate and normalize every field on the server; browser validation is only a convenience.
- Enforce the database field limits and reject unexpected fields.
- Add Turnstile verification and a mandatory Cloudflare Workers Rate Limiting binding before accepting public submissions. The route must fail closed when the binding is missing or unavailable.
- Development setting: 5 attempts per 60 seconds per client IP key, using namespace `1001`. The account owner confirmed no other Worker exists in this Cloudflare account when this namespace was selected. The namespace ID must remain unique within the account. This is approximate and local to each Cloudflare location; Cloudflare recommends avoiding IP keys where possible because shared mobile-carrier/office IPs may cause false positives. Review traffic and consider a better abuse key before production; do not treat this as a strict global cap.
- Use parameterized SQL statements only.
- Return a generic success response; never include internal notes or other customer records.
- Do not log full inquiry bodies, phone numbers, email addresses, or project details.
- Add a retention and deletion policy before collecting real customer data.

## 5. Admin and content safeguards

- Verify the Access identity at the Worker boundary on every admin request.
- Restrict administrative access to explicitly authorized identities; do not assume every authenticated visitor is an administrator.
- Record admin identity, action, entity type, and timestamp in the audit log, after identity verification.
- Keep draft and archived content out of public API responses.
- A testimonial can be published only after permission is confirmed.
- Project photos must be real, approved for publication, and uploaded with validated file type, size, and safe object keys.
- Do not claim Paver Blocks manufactures pavers; supplier details are optional sourcing notes only.
- Never publish fabricated projects, reviews, credentials, or company claims.

## 6. Safe implementation sequence

1. Review and approve this API/security design.
2. Create a separate development-only D1 database, after explicit approval. **Completed:** paver-blocks-dev exists.
3. Apply the reviewed migration to development D1 and verify table/constraint behavior. **Completed:** 8 application tables and 7 custom indexes were verified in the D1 Console; this is not yet a full live API integration test.
4. **Development public API integration completed:** `paver-blocks-api-dev` is deployed with the development D1, private R2, and inquiry rate-limit bindings. The public quote form passed one end-to-end test; Turnstile succeeded and one test inquiry was recorded in `paver-blocks-dev`.
5. **Admin access remains pending:** the dedicated `paver-blocks-admin-dev` gateway is implemented in code but not deployed. Configure Cloudflare Access for that gateway only, then set the API Worker's Access issuer, audience, and single-admin allowlist. Never attach Access to the mixed-purpose API Worker hostname.
6. Complete admin integration and negative-case tests, including anonymous denial, the authorized administrator, an unauthorized identity, and continued public quote access. Expand admin CRUD and audit coverage before relying on the dashboard.
7. Complete development-only R2 upload, preview, public-delivery, deletion, and ordering tests using dummy images.
8. Review privacy notice, retention/deletion, cost limits, and database backup/restore before collecting real customer inquiries.
9. Keep production Pages, production Workers, production data, DNS, domain, and PR merge outside this workflow until separate explicit approval.

**No production database, customer data, or live admin credentials may be used during development.**
