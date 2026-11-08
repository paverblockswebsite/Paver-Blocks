# Project Image Management

**Status:** Implemented on `development/site-foundation`; not deployed. The development R2 bucket has not been created, and the Worker is not deployed.

## Admin routes

All routes below are served by the Worker and require a valid Cloudflare Access JWT plus the configured administrator email allowlist. Mutating requests must also pass the same-origin and Fetch Metadata checks.

| Method and route | Purpose |
| --- | --- |
| GET `/api/admin/projects/:projectId/images` | List image metadata for one project |
| POST `/api/admin/projects/:projectId/images` | Upload one JPEG, PNG, or WebP image (maximum 5 MiB) |
| PATCH `/api/admin/projects/:projectId/images/order` | Replace the complete display order for the project's images |
| DELETE `/api/admin/projects/:projectId/images/:imageId` | Delete one image belonging to the specified project |

## Ordering safeguards

- The request must contain 1–100 unique UUID-shaped image IDs.
- The Worker loads the current image IDs for the specified project.
- The submitted list must contain every current image exactly once; missing, duplicate, stale, and cross-project IDs are rejected.
- Sort positions are assigned as consecutive integers starting at zero.
- The image updates and one audit event are written in a single D1 batch.

## Deletion safeguards

- The Worker looks up the image using both its image ID and project ID.
- The stored R2 key must exactly begin with that project's and image's expected key prefix and end in an allowed image extension.
- R2 deletion is attempted before the D1 metadata delete. If R2 is unavailable, the request stops and D1 is not changed.
- The D1 metadata delete and audit event are written together in a D1 batch.
- If R2 deletion succeeds but the D1 batch fails, the metadata row remains and an administrator can retry. The public media route still checks the D1 row before serving an object, so a deleted object is not served.
- R2 deletion is idempotent, which allows the retry path to complete safely.

## Cache and visibility

- Public media is served only when the D1 image row belongs to a published project. Public media responses use a one-hour cache lifetime to limit stale copies after removal.
- Admin previews may show draft-project photos only after Access verification on the admin media route. Those responses use `private, no-store` and must not be shared-cacheable.
- The R2 bucket is not configured for public direct access; the Worker remains the delivery boundary.

## Admin interface

Each project's gallery displays thumbnails, captions/alt descriptions, and Move up / Move down / Delete controls. Reordering saves the complete list; deleting asks for browser confirmation. After a successful operation, the gallery reloads from the admin API.

## Validation status and limits

Automated smoke tests cover project ownership, R2 deletion failure behavior, atomic D1/audit batches, stale or duplicate ordering requests, successful ordering, Access protection, and private draft-image cache headers.

This is application-level development code, not a live integration test. Before deployment, test against a development-only R2 bucket and D1 database using disposable sample projects and images. No production resources, real project photos, or customer records are involved.
