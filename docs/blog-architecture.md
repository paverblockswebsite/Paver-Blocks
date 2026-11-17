# Paver Blocks Knowledge Hub — Architecture Plan (B1)

**Status:** Planning baseline; no blog application code, database migration, Cloudflare setting, or production resource has been changed.
**Target public URL:** `https://paverblocks.com.pk/blog/`
**Repository baseline:** `main` at the time this plan was prepared.

## 1. Existing architecture verified

- Public website: Astro, currently configured with `output: "static"`.
- Public CMS helper: `src/lib/public-cms.js` and `src/lib/public-cms-core.js`.
- API and existing Admin dashboard: `worker/src/index.js`.
- Admin gateway: `worker-admin/src/index.js`; it is a protected gateway, not the main dashboard implementation.
- Existing API bindings/configuration include D1 (`DB`) and R2 (`PROJECT_IMAGES`); production and development Wrangler configurations are separate.
- Existing D1 schema includes projects, project images, services, paver designs, testimonials, inquiries, site settings, and admin audit logs. No blog tables are present in the checked-in migrations.
- Existing public CMS routes expose published projects, services, paver designs, testimonials, and allowlisted site settings. Existing admin routes manage current site content.

This plan extends the existing system; it does not create a second CMS or a separate admin login.

## 2. Rendering and publishing decision

Keep the public website **static and pre-rendered**. Do not convert the whole Astro site to server-side rendering for the blog.

1. The existing API Worker remains the source of truth for blog records in D1.
2. Astro fetches only published blog records during the Cloudflare Pages build and generates crawlable HTML for the blog index, article pages, category pages, tag pages, and author pages.
3. Publishing, updating, unpublishing, or deleting a public article requests a Cloudflare Pages deploy hook from the API Worker. The hook URL must be stored as an encrypted Worker secret and never returned to the browser or written to Git.
4. The Worker reports separately whether the content save succeeded and whether a rebuild was successfully requested. If the hook fails, the article remains safely saved in D1; Admin displays a clear “site rebuild required” warning and provides a retry action.
5. Scheduled publication requires a Worker Cron Trigger to publish due articles and request a rebuild. Scheduled items remain non-public until their scheduled time.
6. If build-time blog API retrieval fails, the build must fail clearly rather than silently publishing an incomplete blog sitemap or removing existing article pages.

**Why:** This preserves the current static Astro deployment, produces indexable HTML without client-only article rendering, avoids a site-wide SSR migration, and uses the existing Cloudflare stack. The trade-off is that public changes appear after the Pages build completes, not instantly.

## 3. Public URL and page map

- `/blog/` — Knowledge Hub landing page.
- `/blog/articles/` — all published articles, with pagination.
- `/blog/[slug]/` — canonical article page.
- `/blog/category/[slug]/` — category archive.
- `/blog/tag/[slug]/` — tag archive.
- `/blog/author/[slug]/` — author archive.
- `/blog/search/` — search experience. Search should query the already-built public article index; no private API data.
- `/blog/featured/`, `/blog/latest/`, and `/blog/popular/` — optional curated views; popular requires a defined, privacy-conscious analytics source before it is enabled.
- `/blog/archive/` — date-based archive.

Use lowercase, readable, stable slugs. Article URLs must not contain category names so an article can be re-categorized without changing its URL. Any later slug change requires a 301 redirect record.

## 4. Admin integration

Add a Blog Management area to the existing authenticated dashboard in `worker/src/index.js`. Reuse its current Access JWT verification, admin email allowlist, same-origin protections, JSON validation, audit logging, D1 binding, and R2 binding.

Admin modules:
- Dashboard and publishing/rebuild status.
- Articles: create, edit, preview, duplicate, publish, schedule, unpublish, archive, restore, delete.
- Categories and tags.
- Authors and author biographies.
- Media library and image metadata.
- SEO fields and social preview metadata.
- Featured articles and homepage ordering.
- Redirects.
- Revision history and audit activity.
- Blog settings.
- Analytics only after an approved source and privacy approach are selected.

No public endpoint may return drafts, scheduled posts, private revision history, internal notes, subscriber data, or admin audit data.

## 5. Proposed D1 data model

Create additive migrations only; never edit or rerun the existing initial migrations against a populated database.

### Core tables

- `blog_articles`: ID, title, unique slug, excerpt, structured block content JSON, status, author, primary category, featured image, reading time, published/scheduled timestamps, created/updated timestamps.
- `blog_categories`: name, unique slug, description, optional image, sort order, active state.
- `blog_tags`: name and unique slug.
- `blog_article_tags`: many-to-many article/tag relation with foreign keys.
- `blog_authors`: display name, slug, biography, profile image, optional role/credentials, active state.
- `blog_media`: R2 object key, MIME type, byte size, dimensions, alt text, caption, credit/source, uploader, timestamps.
- `blog_article_revisions`: article ID, immutable content/metadata snapshot, editor identity, revision timestamp.
- `blog_redirects`: old path, destination path, HTTP status (301 only for the initial scope), active state.
- `blog_settings`: allowlisted public blog presentation and publishing settings.

Use foreign keys and indexes for status/published date, slug, category, author, tags, and redirect lookup. Use UUID-style IDs consistent with existing project records. Define explicit CHECK constraints and length limits.

### Optional tables — not part of the first release

- `blog_comments` and moderation records.
- `blog_subscribers` and consent/unsubscribe records.
- Per-article analytics/event tables.

Do not collect newsletter subscriptions or comments until consent, spam controls, retention, deletion, and privacy-policy implications are approved. Prefer privacy-respecting aggregate analytics over storing visitor-level data.

## 6. Article content format and editor

Store article body as validated structured JSON blocks, not arbitrary executable HTML. Initial allowlisted block types:

- paragraph, heading, ordered/unordered list
- image and gallery
- quote and callout
- comparison/technical table
- FAQ
- related article and related service
- CTA
- approved video embed (allowlisted provider and URL validation)

Validate every block server-side. Escape text by default, reject scripts/event handlers/unsafe URLs, and render only known block types. Keep the editor usable on desktop and mobile, with preview before publication.

## 7. Media and image rules

Use the existing private R2 bucket binding through authenticated Admin upload and controlled public media delivery. Do not enable public bucket access.

- Allow only approved raster image formats (JPEG, PNG, WebP; AVIF only after the processing pipeline is tested).
- Enforce size limits, verify file signatures, generate random object keys, and validate dimensions.
- Require meaningful alt text for informative images; allow empty alt only for explicitly decorative images.
- Store caption, credit/source, dimensions, MIME type, size, and object key in D1.
- Generate responsive variants and modern formats where the existing image pipeline supports them.
- Never use user-uploaded SVG or arbitrary HTML as trusted content.
- Prevent deleting media that is still referenced by a published article unless the Admin explicitly replaces/unlinks it.

## 8. SEO and structured data

For each article, manage:
- SEO title and meta description.
- Focus and secondary keywords (editorial guidance, not a ranking guarantee).
- Canonical URL.
- Open Graph and X/Twitter title, description, and image.
- Index/noindex controls.
- Article title, excerpt, author, publication date, modified date, and featured image.

Generate at build time:
- Crawlable article HTML with one H1 and semantic H2/H3 hierarchy.
- Canonical, description, Open Graph and social metadata.
- Breadcrumbs.
- XML sitemap entries only for published, indexable pages.
- Appropriate Article/BlogPosting, BreadcrumbList, and Organization structured data.
- RSS feed as a later enhancement.

Never emit Article schema for drafts, scheduled posts, or noindex pages. FAQ structured data must only be emitted when content meets current search-engine eligibility requirements; visible FAQs remain useful regardless.

## 9. Initial taxonomy

Seed the first 12 categories as manageable records, not hard-coded UI-only categories:
1. Paver Block Installation
2. Paver Block Types & Designs
3. Road Construction
4. Parking Area Construction
5. Footpath & Walkway Construction
6. Industrial Flooring
7. Paver Block Manufacturing
8. Materials & Supply
9. Civil Engineering & Technical Guides
10. Government & Private Contracts
11. Projects & Case Studies
12. Construction in Pakistan

Admin must be able to create, rename, reorder, deactivate, and safely delete categories. Deleting a category requires reassigning or confirming handling of associated articles.

## 10. Security, privacy, and reliability

- Reuse the existing verified Cloudflare Access identity; no new password/session system.
- Enforce authorization inside every admin API route, not only in the UI or gateway.
- Use parameterized SQL, strict allowlists, request-size limits, content validation, and safe error responses.
- Protect uploads against MIME spoofing, oversized files, unsafe SVG/HTML, and path traversal.
- Apply rate limits to any public search, comment, or subscription endpoint.
- Keep unpublished content and private records out of public responses, caches, logs, and sitemaps.
- Store deploy-hook and any provider credentials only as encrypted Worker secrets.
- Audit all create/update/publish/unpublish/delete/media actions.
- Back up D1 and R2 before schema changes; test restore procedures.
- Add tests for authorization, public/private visibility, validation, slug collisions, scheduled publishing, rebuild-hook failure, redirects, and media ownership.

## 11. Build and deployment workflow

1. Add a development-only additive D1 migration and apply it only after confirming the development database target.
2. Extend API routes and tests in the existing Worker.
3. Extend the existing Admin dashboard and tests.
4. Add Astro static blog routes and build-time public-data fetching.
5. Add a development-only deploy hook and scheduled publishing configuration.
6. Verify preview build, generated HTML, sitemap, canonical/OG metadata, and public/private boundaries.
7. Run the full website and Worker test suites.
8. Review and merge via PR; deploy development first.
9. Production migration, secrets, Cron Trigger, deploy hook, and production deployment require a separate explicit safety review. No production resource is changed by this plan.

## 12. Delivery phases after B1

- B2: additive database schema and API contract.
- B3: Admin dashboard navigation and blog dashboard.
- B4: article editor, preview, revisions, and publishing.
- B5: categories, tags, and authors.
- B6: media library and image delivery.
- B7: public blog index and archives.
- B8: article detail pages and related content.
- B9: SEO, sitemap, redirects, and social metadata.
- B10: rebuild orchestration, scheduled publishing, and optional analytics.
- B11: security, accessibility, responsive design, and performance.
- B12: end-to-end audit and development preview.
- B13: prepare and fact-check initial content.
- B14: separately approved production launch and footer integration.

## 13. B1 acceptance criteria

- Existing Astro static output is preserved.
- Existing API and Admin are extended rather than duplicated.
- Blog content is pre-rendered as crawlable HTML.
- Publishing/rebuild failure behavior is explicit and recoverable.
- Database changes are additive and development-first.
- Public/private data boundaries are defined.
- Production deployment and footer changes are out of scope for B1.
