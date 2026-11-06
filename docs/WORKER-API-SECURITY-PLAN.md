# Paver Blocks — Worker API and Admin Security Plan

**Status:** Design only. No Worker, D1 database, R2 bucket, Access application, admin login, or production binding has been created.

## 1. Security boundary

- The public website may read only published, public-facing records.
- The public website may submit a new quotation inquiry.
- Public requests must never list, read, edit, or delete customer inquiries.
- All admin routes must require Cloudflare Access authentication and a verified identity on the server. Hiding an admin link in the browser is not authentication.
- The Worker must deny admin access by default if identity headers are missing, malformed, or untrusted.
- Never store passwords in this application database. Cloudflare Access is the planned identity gate.
- Never put API tokens, database credentials, or customer records in Git.

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
- Add Turnstile verification and rate limiting before accepting public submissions.
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
2. Create a separate development-only D1 database, after explicit approval.
3. Apply the reviewed migration to development D1 and verify table/constraint behavior.
4. Implement public read and inquiry-submit endpoints first, with tests.
5. Configure Cloudflare Access and verify admin identity restrictions before adding admin endpoints.
6. Implement admin operations with authorization, validation, and audit tests.
7. Add development-only R2 uploads with file validation.
8. Connect the development website and test end-to-end using dummy data only.
9. Review security, privacy, cost limits, and backup/retention before any production connection.

**No production database, customer data, or live admin credentials may be used during development.**
