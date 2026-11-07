# Paver Blocks — Worker API and Admin Security Plan

**Status:** Initial Worker API code now exists on the development branch and is not deployed. The development D1 database and its schema have been created and verified separately, but no Worker D1 binding is configured. No Access application, Turnstile widget/secrets, R2 bucket, admin login, or production binding is active.

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

Use a hostname/path-based Cloudflare Access application for the Worker hostname and protect only the admin UI path (for example, `/admin*`) and admin API path (`/api/admin/*`). Do not protect the entire mixed-purpose Worker, because its public API routes must remain reachable. Continue verifying the Access JWT and administrator email allowlist inside the Worker; edge protection is an additional boundary, not a replacement.

Cloudflare documents hostname/path Access protection for Workers, including `workers.dev` hostnames, and documents that browser CORS requests to Access-protected origins require an Access authorization cookie. This is why the same-origin admin design is preferred over a cross-origin admin dashboard. The final hostname and exact Access path patterns must be reviewed in the dashboard before enabling anything.

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
- Initial development proposal: 5 attempts per 60 seconds per client IP key. This is approximate and local to each Cloudflare location; shared mobile-carrier/office IPs may cause false positives. Review traffic before production and do not treat it as a strict global cap.
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
4. Initial public read routes, Turnstile-protected inquiry submission, Access JWT verification, and limited inquiry-admin routes are coded on the development branch. The inquiry route now requires a rate-limit binding and fails closed with HTTP 503 if it is missing; the binding is deliberately not configured until a unique account namespace ID is confirmed. Complete integration, negative-case, and security tests before deployment.
5. Configure Cloudflare Access and verify admin identity restrictions before enabling any admin route.
6. Implement admin operations with authorization, validation, and audit tests.
7. Add development-only R2 uploads with file validation.
8. Connect the development website and test end-to-end using dummy data only.
9. Review security, privacy, cost limits, and backup/retention before any production connection.

**No production database, customer data, or live admin credentials may be used during development.**
