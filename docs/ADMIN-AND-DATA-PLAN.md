# Admin Panel and Data Architecture Plan

Status: design proposal only. Nothing in this document creates a database, enables an admin route, or changes production.

## Goals

- Let the business owner manage projects, project photos, services, paver designs, testimonials, and homepage content.
- Save quotation and contact inquiries privately so they can be reviewed and tracked.
- Keep the public website fast and mostly static.
- Keep customer information and credentials out of the public Git repository.

## Proposed Cloudflare architecture

- **Astro / Cloudflare Pages:** public website and static pages.
- **Cloudflare Worker:** server-side API for admin operations, inquiry submission, and protected uploads.
- **Cloudflare D1:** structured records (projects, services, designs, testimonials, inquiries, and site settings).
- **Cloudflare R2:** uploaded project and gallery images; D1 stores only object keys and metadata.
- **Cloudflare Access:** protect the admin area with an identity-based login (for example, email one-time PIN) and an explicit allowlist. The Worker must independently verify the Access identity/token before every admin operation; hiding the admin page is not security.

Development resources now exist: the Astro Pages preview, `paver-blocks-api-dev`, D1 database `paver-blocks-dev`, and private R2 bucket `paver-blocks-project-images-dev` are connected for development. The quote form has passed one development submission test and that test inquiry was saved in D1. The admin gateway code exists but is not deployed; Cloudflare Access is not configured. Production resources and production website settings must remain separate. Confirm current Cloudflare plan limits and any paid usage before expanding usage.

## Proposed data model

| Table | Purpose | Public exposure |
| --- | --- | --- |
| `projects` | Project title, location, date, work summary, publication status, sort order | Published fields only |
| `project_images` | R2 object key, alt text, sort order, project relation | Published images only |
| `services` | Service title, slug, description, publication status, sort order | Published records only |
| `paver_designs` | Design name, shape, dimensions/thickness where verified, colour, supplier note if appropriate | Published records only |
| `testimonials` | Customer-approved wording, attribution consent, publication status | Approved and published records only |
| `inquiries` | Name, phone, location, work type, approximate area, optional budget, details, status, timestamps | Never public; write-only public submission |
| `site_settings` | Small editable public-site content values | Explicitly allowlisted fields only |

No password table is proposed. Do not store plaintext passwords or invent a custom password system. Authentication should be handled by Cloudflare Access, with server-side identity verification and a small allowlist of authorized administrator emails.

## Security requirements before implementation

1. Admin API routes deny access by default and verify the Access identity on every request.
2. Public visitors may submit an inquiry but cannot list, read, update, or delete inquiries.
3. Validate and length-limit every submitted field on the server; normalize phone numbers and reject malformed input.
4. Add spam controls (Turnstile and/or rate limiting) to public inquiry submission.
5. Never place API tokens, Access secrets, database credentials, private customer data, or production environment values in Git.
6. Validate image MIME type, file size, and extension; generate safe object keys; do not trust a filename supplied by a visitor.
7. Restrict uploads and deletes to authenticated administrators. Store images in R2, not in D1 blobs.
8. Use prepared/bound SQL parameters. Escape user content when rendering it.
9. Keep inquiry status changes and administrative edits behind authorization. Consider an audit log before launch.
10. Define a privacy notice and retention/deletion process for inquiry data before collecting it publicly.
11. Back up/export important D1 data periodically and test restoration before relying on it operationally.

## Delivery sequence

1. Review and approve this design.
2. Confirm the Cloudflare account's available Access, Workers, D1, R2, and Turnstile features and costs.
3. Create a D1 schema migration on the development branch only; do not bind production resources yet.
4. Build and test the public inquiry endpoint with validation and spam protection.
5. Configure Access and verify server-side authorization before exposing any admin UI.
6. Add private admin CRUD screens and R2 uploads.
7. Test unauthorized access, public data leakage, malformed submissions, upload abuse, and backup/restore.
8. Review the preview site and obtain explicit approval before merging or connecting production resources.

## Business-content safeguards

- Do not describe Paver Blocks as a paver manufacturer. Pavers are sourced from third-party suppliers when needed; the core service is installation and related construction work.
- Publish only real project photos and verified project details.
- Publish testimonials only with customer permission.
- Keep unpublished drafts hidden from public APIs and pages.
- Do not add invented registrations, offices, certifications, client names, or project claims.
