-- Paver Blocks: production D1 schema
-- Target: the newly created paver-blocks-production database only.
-- This file creates schema only; it inserts no customer or business records.
-- Before applying, confirm the selected database is paver-blocks-production and has zero tables.
-- Never apply this file to paver-blocks-dev.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 180),
  location TEXT,
  completed_on TEXT,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_public_order
  ON projects(status, sort_order, completed_on);

CREATE TABLE IF NOT EXISTS project_images (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  alt_text TEXT NOT NULL CHECK (length(alt_text) BETWEEN 1 AND 250),
  caption TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_images_project_order
  ON project_images(project_id, sort_order);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 180),
  short_description TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_services_public_order
  ON services(status, sort_order);

CREATE TABLE IF NOT EXISTS paver_designs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 160),
  shape TEXT,
  dimensions TEXT,
  thickness TEXT,
  colour TEXT,
  supplier_note TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paver_designs_public_order
  ON paver_designs(status, sort_order);

CREATE TABLE IF NOT EXISTS testimonials (
  id TEXT PRIMARY KEY,
  customer_display_name TEXT NOT NULL CHECK (length(customer_display_name) BETWEEN 1 AND 120),
  customer_role_or_company TEXT,
  testimonial_text TEXT NOT NULL CHECK (length(testimonial_text) BETWEEN 1 AND 2000),
  permission_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (permission_confirmed IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status != 'published' OR permission_confirmed = 1)
);

CREATE INDEX IF NOT EXISTS idx_testimonials_public_order
  ON testimonials(status, sort_order);

-- Private customer data. Public clients may submit an inquiry, but must never
-- receive list/read/update/delete access to this table.
CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 120),
  phone TEXT NOT NULL CHECK (length(phone) BETWEEN 5 AND 40),
  email TEXT CHECK (email IS NULL OR length(email) <= 254),
  location TEXT NOT NULL CHECK (length(location) BETWEEN 1 AND 180),
  work_type TEXT NOT NULL CHECK (length(work_type) BETWEEN 1 AND 120),
  approximate_area TEXT,
  budget TEXT,
  project_details TEXT NOT NULL CHECK (length(project_details) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'quoted', 'completed', 'closed')),
  internal_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inquiries_status_created
  ON inquiries(status, created_at DESC);

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key TEXT PRIMARY KEY CHECK (length(setting_key) BETWEEN 1 AND 100),
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Administrative audit trail. Never expose this table through public endpoints.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 80),
  entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit_log(created_at DESC);
