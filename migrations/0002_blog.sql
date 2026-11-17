-- Paver Blocks Knowledge Hub: additive blog schema.
-- Development-first. Apply only to paver-blocks-dev after confirming the target.
-- Never apply this migration to production without a separate reviewed rollout.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blog_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 120 AND slug NOT GLOB '*[^a-z0-9-]*'),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  image_media_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blog_categories_active_order
  ON blog_categories(is_active, sort_order, name);

CREATE TABLE IF NOT EXISTS blog_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 100 AND slug NOT GLOB '*[^a-z0-9-]*'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blog_authors (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 140 AND slug NOT GLOB '*[^a-z0-9-]*'),
  biography TEXT NOT NULL DEFAULT '' CHECK (length(biography) <= 3000),
  role_or_credentials TEXT NOT NULL DEFAULT '' CHECK (length(role_or_credentials) <= 160),
  profile_image_media_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blog_authors_active
  ON blog_authors(is_active, display_name);

CREATE TABLE IF NOT EXISTS blog_media (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  width INTEGER,
  height INTEGER,
  alt_text TEXT NOT NULL CHECK (length(alt_text) <= 250),
  caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 300),
  credit TEXT NOT NULL DEFAULT '' CHECK (length(credit) <= 300),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blog_media_created
  ON blog_media(created_at DESC);

CREATE TABLE IF NOT EXISTS blog_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 180 AND slug NOT GLOB '*[^a-z0-9-]*'),
  excerpt TEXT NOT NULL DEFAULT '' CHECK (length(excerpt) <= 500),
  content_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(content_json) AND length(content_json) <= 524288),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'scheduled', 'published', 'archived')),
  category_id TEXT,
  author_id TEXT,
  featured_media_id TEXT,
  seo_title TEXT NOT NULL DEFAULT '' CHECK (length(seo_title) <= 70),
  meta_description TEXT NOT NULL DEFAULT '' CHECK (length(meta_description) <= 170),
  focus_keyword TEXT NOT NULL DEFAULT '' CHECK (length(focus_keyword) <= 120),
  canonical_url TEXT NOT NULL DEFAULT '' CHECK (length(canonical_url) <= 500),
  og_title TEXT NOT NULL DEFAULT '' CHECK (length(og_title) <= 100),
  og_description TEXT NOT NULL DEFAULT '' CHECK (length(og_description) <= 200),
  og_media_id TEXT,
  robots_index INTEGER NOT NULL DEFAULT 1 CHECK (robots_index IN (0, 1)),
  is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  scheduled_at TEXT,
  published_at TEXT,
  reading_minutes INTEGER NOT NULL DEFAULT 1 CHECK (reading_minutes BETWEEN 1 AND 120),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES blog_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (author_id) REFERENCES blog_authors(id) ON DELETE SET NULL,
  FOREIGN KEY (featured_media_id) REFERENCES blog_media(id) ON DELETE SET NULL,
  FOREIGN KEY (og_media_id) REFERENCES blog_media(id) ON DELETE SET NULL,
  CHECK (status != 'published' OR published_at IS NOT NULL),
  CHECK (status != 'scheduled' OR scheduled_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_blog_articles_public
  ON blog_articles(status, robots_index, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_category
  ON blog_articles(category_id, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_author
  ON blog_articles(author_id, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_articles_featured
  ON blog_articles(is_featured, status, published_at DESC);

CREATE TABLE IF NOT EXISTS blog_article_tags (
  article_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (article_id, tag_id),
  FOREIGN KEY (article_id) REFERENCES blog_articles(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES blog_tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blog_article_tags_tag
  ON blog_article_tags(tag_id, article_id);

CREATE TABLE IF NOT EXISTS blog_article_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(snapshot_json) <= 524288),
  edited_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (article_id) REFERENCES blog_articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blog_revisions_article
  ON blog_article_revisions(article_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blog_redirects (
  id TEXT PRIMARY KEY,
  old_path TEXT NOT NULL UNIQUE CHECK (length(old_path) BETWEEN 1 AND 500),
  destination_path TEXT NOT NULL CHECK (length(destination_path) BETWEEN 1 AND 500),
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code = 301),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (substr(old_path, 1, 1) = '/' AND substr(destination_path, 1, 1) = '/')
);

CREATE TABLE IF NOT EXISTS blog_settings (
  setting_key TEXT PRIMARY KEY CHECK (length(setting_key) BETWEEN 1 AND 100),
  setting_value TEXT NOT NULL CHECK (length(setting_value) <= 5000),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Initial Knowledge Hub taxonomy. Records remain editable from Admin.
INSERT OR IGNORE INTO blog_categories (id, name, slug, description, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Paver Block Installation', 'paver-block-installation', 'Installation methods, base preparation, laying patterns, joint filling and maintenance.', 1),
  ('00000000-0000-4000-8000-000000000002', 'Paver Block Types & Designs', 'paver-block-types-designs', 'Paver shapes, patterns, dimensions, thicknesses, colours and applications.', 2),
  ('00000000-0000-4000-8000-000000000003', 'Road Construction', 'road-construction', 'Road preparation, pavement layers, construction methods and maintenance.', 3),
  ('00000000-0000-4000-8000-000000000004', 'Parking Area Construction', 'parking-area-construction', 'Residential, commercial and heavy-vehicle parking surfaces.', 4),
  ('00000000-0000-4000-8000-000000000005', 'Footpath & Walkway Construction', 'footpath-walkway-construction', 'Pedestrian paths, kerbs, accessibility and walkway design.', 5),
  ('00000000-0000-4000-8000-000000000006', 'Industrial Flooring', 'industrial-flooring', 'Warehouse, industrial and heavy-duty flooring guidance.', 6),
  ('00000000-0000-4000-8000-000000000007', 'Paver Block Manufacturing', 'paver-block-manufacturing', 'Manufacturing processes, concrete materials, curing and quality control.', 7),
  ('00000000-0000-4000-8000-000000000008', 'Materials & Supply', 'materials-supply', 'Material selection, sourcing, supply, transportation and estimation.', 8),
  ('00000000-0000-4000-8000-000000000009', 'Civil Engineering & Technical Guides', 'civil-engineering-technical-guides', 'Construction terminology, measurements, specifications and site inspection.', 9),
  ('00000000-0000-4000-8000-000000000010', 'Government & Private Contracts', 'government-private-contracts', 'Tender awareness, project planning, documentation and contracts.', 10),
  ('00000000-0000-4000-8000-000000000011', 'Projects & Case Studies', 'projects-case-studies', 'Project stories, work processes, challenges and documented results.', 11),
  ('00000000-0000-4000-8000-000000000012', 'Construction in Pakistan', 'construction-in-pakistan', 'Construction guidance for Pakistan’s regional conditions and infrastructure.', 12);

-- Optional comments, subscriptions, and visitor-level analytics are deliberately
-- excluded from this foundational migration until privacy and consent requirements
-- are separately approved.
