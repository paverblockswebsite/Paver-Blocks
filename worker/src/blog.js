const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = new Set(["draft", "in_review", "scheduled", "published", "archived"]);
const BLOCK_TYPES = new Set(["paragraph", "heading", "list", "image", "quote", "callout", "table", "faq"]);
const ARTICLE_COLUMNS = "id, title, slug, excerpt, content_json, status, category_id, author_id, featured_media_id, seo_title, meta_description, focus_keyword, canonical_url, og_title, og_description, og_media_id, robots_index, is_featured, scheduled_at, published_at, reading_minutes, created_by, updated_by, created_at, updated_at";

function jsonBody(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function cleanString(value, max, required = false) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  if ((required && !result) || result.length > max) return null;
  return result;
}

function validDateTime(value) {
  if (typeof value !== "string" || !value || value.length > 40) return false;
  return Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

async function parseBody(request) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { error: "Use an application/json request body." };
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 600000) return { error: "The request is too large." };
  let raw;
  try { raw = await request.text(); } catch { return { error: "The request body could not be read." }; }
  if (new TextEncoder().encode(raw).byteLength > 600000) return { error: "The request is too large." };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "A JSON object is required." };
    return { value };
  } catch { return { error: "The JSON request body is invalid." }; }
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 100) return null;
  const output = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block) || !BLOCK_TYPES.has(block.type)) return null;
    if (block.type === "paragraph") {
      const text = cleanString(block.text, 12000, true);
      if (text === null) return null;
      output.push({ type: "paragraph", text });
    } else if (block.type === "heading") {
      const text = cleanString(block.text, 300, true);
      if (text === null || ![2, 3].includes(block.level)) return null;
      output.push({ type: "heading", level: block.level, text });
    } else if (block.type === "list") {
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 50) return null;
      const items = block.items.map((item) => cleanString(item, 1000, true));
      if (items.some((item) => item === null) || (block.ordered !== undefined && typeof block.ordered !== "boolean")) return null;
      output.push({ type: "list", ordered: block.ordered === true, items });
    } else if (block.type === "image") {
      if (typeof block.media_id !== "string" || !UUID.test(block.media_id)) return null;
      const alt = cleanString(block.alt, 250, true);
      const caption = cleanString(block.caption || "", 300);
      if (alt === null || caption === null) return null;
      output.push({ type: "image", media_id: block.media_id, alt, caption });
    } else if (block.type === "quote") {
      const text = cleanString(block.text, 3000, true);
      const attribution = cleanString(block.attribution || "", 180);
      if (text === null || attribution === null) return null;
      output.push({ type: "quote", text, attribution });
    } else if (block.type === "callout") {
      const text = cleanString(block.text, 2000, true);
      const title = cleanString(block.title || "", 120);
      if (text === null || title === null || !["info", "tip", "warning"].includes(block.tone || "info")) return null;
      output.push({ type: "callout", tone: block.tone || "info", title, text });
    } else if (block.type === "table") {
      if (!Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > 8 ||
          !Array.isArray(block.rows) || block.rows.length > 50) return null;
      const columns = block.columns.map((item) => cleanString(item, 100, true));
      const rows = block.rows.map((row) => Array.isArray(row) && row.length === columns.length
        ? row.map((cell) => cleanString(cell, 500, true)) : null);
      if (columns.some((item) => item === null) || rows.some((row) => !row || row.some((cell) => cell === null))) return null;
      output.push({ type: "table", columns, rows });
    } else if (block.type === "faq") {
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 20) return null;
      const items = block.items.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const question = cleanString(item.question, 300, true);
        const answer = cleanString(item.answer, 3000, true);
        return question === null || answer === null ? null : { question, answer };
      });
      if (items.some((item) => item === null)) return null;
      output.push({ type: "faq", items });
    }
  }
  const serialized = JSON.stringify(output);
  if (serialized.length > 524288) return null;
  return serialized;
}

function validateArticle(input, partial = false) {
  const allowed = new Set([
    "title", "slug", "excerpt", "content", "status", "category_id", "author_id",
    "featured_media_id", "seo_title", "meta_description", "focus_keyword", "canonical_url",
    "og_title", "og_description", "og_media_id", "robots_index", "is_featured",
    "scheduled_at", "reading_minutes", "tag_ids",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const out = {};
  const stringFields = {
    title: [180, true], slug: [180, true], excerpt: [500, false], seo_title: [70, false],
    meta_description: [170, false], focus_keyword: [120, false], canonical_url: [500, false],
    og_title: [100, false], og_description: [200, false],
  };
  for (const [key, [max, required]] of Object.entries(stringFields)) {
    if (partial && !Object.hasOwn(input, key)) continue;
    const value = cleanString(input[key] ?? (required ? "" : ""), max, required);
    if (value === null) return null;
    if (key === "slug" && value && !SLUG.test(value)) return null;
    if (key === "canonical_url" && value) {
      try { const u = new URL(value); if (u.protocol !== "https:" || u.username || u.password) return null; }
      catch { return null; }
    }
    out[key] = value;
  }
  if (!partial || Object.hasOwn(input, "content")) {
    const content = validateBlocks(input.content ?? []);
    if (content === null) return null;
    out.content_json = content;
  }
  if (!partial || Object.hasOwn(input, "status")) {
    const status = input.status ?? "draft";
    if (!STATUSES.has(status)) return null;
    out.status = status;
  }
  for (const key of ["category_id", "author_id", "featured_media_id", "og_media_id"]) {
    if (partial && !Object.hasOwn(input, key)) continue;
    const value = input[key] ?? "";
    if (value !== "" && (typeof value !== "string" || !UUID.test(value))) return null;
    out[key] = value || null;
  }
  for (const key of ["robots_index", "is_featured"]) {
    if (partial && !Object.hasOwn(input, key)) continue;
    const value = input[key] ?? (key === "robots_index" ? true : false);
    if (typeof value !== "boolean") return null;
    out[key] = value ? 1 : 0;
  }
  if (partial && !Object.hasOwn(input, "scheduled_at")) {
    // Leave the existing scheduled timestamp untouched.
  } else {
    const value = input.scheduled_at ?? "";
    if (value && !validDateTime(value)) return null;
    out.scheduled_at = value || null;
  }
  if (partial && !Object.hasOwn(input, "reading_minutes")) {
    // Leave the existing reading time untouched.
  } else {
    const value = input.reading_minutes ?? 1;
    if (!Number.isInteger(value) || value < 1 || value > 120) return null;
    out.reading_minutes = value;
  }
  if (Object.hasOwn(input, "tag_ids")) {
    if (!Array.isArray(input.tag_ids) || input.tag_ids.length > 30 ||
        input.tag_ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
        new Set(input.tag_ids).size !== input.tag_ids.length) return null;
    out.tag_ids = input.tag_ids;
  }
  if (out.status === "scheduled" && !out.scheduled_at) return null;
  return out;
}

const TAXONOMY = {
  categories: {
    table: "blog_categories", entity: "blog_category",
    columns: "id, name, slug, description, sort_order, is_active, created_at, updated_at",
    fields: { name: [100, true], slug: [120, true], description: [1000, false] },
    extra: ["sort_order", "is_active"],
  },
  tags: {
    table: "blog_tags", entity: "blog_tag",
    columns: "id, name, slug, created_at, updated_at",
    fields: { name: [80, true], slug: [100, true] }, extra: [],
  },
  authors: {
    table: "blog_authors", entity: "blog_author",
    columns: "id, display_name, slug, biography, role_or_credentials, is_active, created_at, updated_at",
    fields: { display_name: [120, true], slug: [140, true], biography: [3000, false], role_or_credentials: [160, false] },
    extra: ["is_active"],
  },
};

function validateTaxonomy(input, config, partial) {
  const allowed = new Set([...Object.keys(config.fields), ...config.extra]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const out = {};
  for (const [key, [max, required]] of Object.entries(config.fields)) {
    if (partial && !Object.hasOwn(input, key)) continue;
    const value = cleanString(input[key] ?? "", max, required);
    if (value === null || (key === "slug" && value && !SLUG.test(value))) return null;
    out[key] = value;
  }
  if (config.extra.includes("sort_order") && (!partial || Object.hasOwn(input, "sort_order"))) {
    if (!Number.isInteger(input.sort_order ?? 0) || Math.abs(input.sort_order ?? 0) > 100000) return null;
    out.sort_order = input.sort_order ?? 0;
  }
  if (config.extra.includes("is_active") && (!partial || Object.hasOwn(input, "is_active"))) {
    if (typeof (input.is_active ?? true) !== "boolean") return null;
    out.is_active = (input.is_active ?? true) ? 1 : 0;
  }
  return out;
}

async function audit(env, identity, action, entity, id) {
  await env.DB.prepare(
    "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), identity.email, action, entity, id || null).run();
}

async function handleTaxonomy(request, env, url, identity, resource, id) {
  const config = TAXONOMY[resource];
  if (!config) return null;
  if (request.method === "GET" && !id) {
    const rows = await env.DB.prepare("SELECT " + config.columns + " FROM " + config.table + " ORDER BY " +
      (resource === "categories" ? "sort_order ASC, name ASC" : "created_at DESC")).all();
    return jsonBody({ data: rows.results || [] });
  }
  if (request.method === "POST" && !id) {
    const parsed = await parseBody(request);
    if (parsed.error) return jsonBody({ error: parsed.error }, 400);
    const values = validateTaxonomy(parsed.value, config, false);
    if (!values) return jsonBody({ error: "Please check the fields and try again." }, 400);
    const recordId = crypto.randomUUID();
    const cols = ["id", ...Object.keys(values)];
    const vals = [recordId, ...Object.values(values)];
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO " + config.table + " (" + cols.join(", ") + ") VALUES (" + cols.map(() => "?").join(", ") + ")").bind(...vals),
        env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "create", config.entity, recordId),
      ]);
    } catch (error) {
      if (/unique|constraint/i.test(String(error))) return jsonBody({ error: "A record with this name or URL slug already exists." }, 409);
      throw error;
    }
    return jsonBody({ success: true, id: recordId }, 201);
  }
  if (request.method === "PATCH" && id) {
    const parsed = await parseBody(request);
    if (parsed.error) return jsonBody({ error: parsed.error }, 400);
    const values = validateTaxonomy(parsed.value, config, true);
    if (!values || !Object.keys(values).length) return jsonBody({ error: "Please check the fields and try again." }, 400);
    const current = await env.DB.prepare("SELECT id FROM " + config.table + " WHERE id = ? LIMIT 1").bind(id).first();
    if (!current) return jsonBody({ error: "Record not found." }, 404);
    const keys = Object.keys(values);
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE " + config.table + " SET " + keys.map((key) => key + " = ?").join(", ") + ", updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(...keys.map((key) => values[key]), id),
        env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "update", config.entity, id),
      ]);
    } catch (error) {
      if (/unique|constraint/i.test(String(error))) return jsonBody({ error: "A record with this name or URL slug already exists." }, 409);
      throw error;
    }
    return jsonBody({ success: true });
  }
  if (request.method === "DELETE" && id) {
    const current = await env.DB.prepare("SELECT id FROM " + config.table + " WHERE id = ? LIMIT 1").bind(id).first();
    if (!current) return jsonBody({ error: "Record not found." }, 404);
    if (resource === "categories") {
      const linked = await env.DB.prepare("SELECT COUNT(*) AS count FROM blog_articles WHERE category_id = ?").bind(id).first();
      if ((linked?.count || 0) > 0) return jsonBody({ error: "This category is assigned to articles. Reassign those articles before deleting it." }, 409);
    }
    if (resource === "authors") {
      const linked = await env.DB.prepare("SELECT COUNT(*) AS count FROM blog_articles WHERE author_id = ?").bind(id).first();
      if ((linked?.count || 0) > 0) return jsonBody({ error: "This author is assigned to articles. Reassign those articles before deleting it." }, 409);
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM " + config.table + " WHERE id = ?").bind(id),
      env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "delete", config.entity, id),
    ]);
    return jsonBody({ success: true });
  }
  return jsonBody({ error: "Method not allowed." }, 405);
}

async function validateTagIds(env, ids) {
  if (!ids || !ids.length) return true;
  const rows = await env.DB.prepare("SELECT id FROM blog_tags WHERE id IN (" + ids.map(() => "?").join(",") + ")").bind(...ids).all();
  return (rows.results || []).length === ids.length;
}

async function handleArticles(request, env, url, identity, id) {
  if (request.method === "GET" && !id) {
    const status = url.searchParams.get("status") || "";
    if (status && !STATUSES.has(status)) return jsonBody({ error: "Invalid article status filter." }, 400);
    const limitRaw = Number(url.searchParams.get("limit") || 30);
    const offsetRaw = Number(url.searchParams.get("offset") || 0);
    if (!Number.isInteger(limitRaw) || !Number.isInteger(offsetRaw) || offsetRaw < 0) return jsonBody({ error: "Invalid pagination." }, 400);
    const limit = Math.min(Math.max(limitRaw, 1), 100);
    const offset = Math.min(offsetRaw, 1000000);
    const where = status ? " WHERE status = ?" : "";
    const rows = await env.DB.prepare("SELECT " + ARTICLE_COLUMNS + " FROM blog_articles" + where + " ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .bind(...(status ? [status, limit, offset] : [limit, offset])).all();
    return jsonBody({ data: rows.results || [], limit, offset });
  }
  if (request.method === "GET" && id) {
    const article = await env.DB.prepare("SELECT " + ARTICLE_COLUMNS + " FROM blog_articles WHERE id = ? LIMIT 1").bind(id).first();
    if (!article) return jsonBody({ error: "Article not found." }, 404);
    const tags = await env.DB.prepare("SELECT t.id, t.name, t.slug FROM blog_tags t INNER JOIN blog_article_tags at ON at.tag_id = t.id WHERE at.article_id = ? ORDER BY t.name").bind(id).all();
    const revisions = await env.DB.prepare("SELECT id, edited_by, created_at FROM blog_article_revisions WHERE article_id = ? ORDER BY created_at DESC LIMIT 20").bind(id).all();
    return jsonBody({ data: { ...article, content: JSON.parse(article.content_json), tags: tags.results || [], revisions: revisions.results || [] } });
  }
  if (request.method === "POST" && !id) {
    const parsed = await parseBody(request);
    if (parsed.error) return jsonBody({ error: parsed.error }, 400);
    const values = validateArticle(parsed.value, false);
    if (!values) return jsonBody({ error: "Please check the article fields and structured content blocks." }, 400);
    if (!(await validateTagIds(env, values.tag_ids))) return jsonBody({ error: "One or more selected tags do not exist." }, 400);
    if (values.status === "published" && !values.published_at) values.published_at = new Date().toISOString();
    if (values.status === "published" && !values.author_id) return jsonBody({ error: "Select an author before publishing." }, 400);
    if (values.status === "published" && values.robots_index === 1 && !values.meta_description) return jsonBody({ error: "Add a meta description before publishing an indexable article." }, 400);
    const articleId = crypto.randomUUID();
    const tagIds = values.tag_ids || [];
    delete values.tag_ids;
    const record = {
      ...values,
      published_at: values.status === "published" ? new Date().toISOString() : null,
      created_by: identity.email,
      updated_by: identity.email,
    };
    const cols = ["id", ...Object.keys(record)];
    try {
      const statements = [
        env.DB.prepare("INSERT INTO blog_articles (" + cols.join(", ") + ") VALUES (" + cols.map(() => "?").join(", ") + ")").bind(articleId, ...Object.values(record)),
        ...tagIds.map((tagId) => env.DB.prepare("INSERT INTO blog_article_tags (article_id, tag_id) VALUES (?, ?)").bind(articleId, tagId)),
        env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "create", "blog_article", articleId),
      ];
      await env.DB.batch(statements);
    } catch (error) {
      if (/unique|constraint/i.test(String(error))) return jsonBody({ error: "The article slug is already in use or a referenced record is invalid." }, 409);
      throw error;
    }
    return jsonBody({ success: true, id: articleId }, 201);
  }
  if (request.method === "PATCH" && id) {
    const parsed = await parseBody(request);
    if (parsed.error) return jsonBody({ error: parsed.error }, 400);
    const values = validateArticle(parsed.value, true);
    if (!values || !Object.keys(values).length) return jsonBody({ error: "Please check the article fields." }, 400);
    if (values.tag_ids && !(await validateTagIds(env, values.tag_ids))) return jsonBody({ error: "One or more selected tags do not exist." }, 400);
    const current = await env.DB.prepare("SELECT " + ARTICLE_COLUMNS + " FROM blog_articles WHERE id = ? LIMIT 1").bind(id).first();
    if (!current) return jsonBody({ error: "Article not found." }, 404);
    if (values.status === "published" && !values.author_id && !current.author_id) return jsonBody({ error: "Select an author before publishing." }, 400);
    if (values.status === "published" && values.robots_index === 1 && !values.meta_description && !current.meta_description) return jsonBody({ error: "Add a meta description before publishing an indexable article." }, 400);
    const tagIds = values.tag_ids;
    delete values.tag_ids;
    const nextStatus = values.status || current.status;
    if (nextStatus === "published") {
      values.published_at = current.published_at || new Date().toISOString();
      values.scheduled_at = null;
    } else if (nextStatus !== "scheduled") {
      values.published_at = null;
    }
    const snapshot = JSON.stringify(current);
    const keys = Object.keys(values);
    try {
      const statements = [
        env.DB.prepare("INSERT INTO blog_article_revisions (id, article_id, snapshot_json, edited_by) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), id, snapshot, identity.email),
      ];
      if (keys.length) {
        statements.push(env.DB.prepare("UPDATE blog_articles SET " + keys.map((key) => key + " = ?").join(", ") + ", updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(...keys.map((key) => values[key]), identity.email, id));
      }
      if (tagIds) {
        statements.push(env.DB.prepare("DELETE FROM blog_article_tags WHERE article_id = ?").bind(id));
        for (const tagId of tagIds) statements.push(env.DB.prepare("INSERT INTO blog_article_tags (article_id, tag_id) VALUES (?, ?)").bind(id, tagId));
      }
      statements.push(env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "update", "blog_article", id));
      await env.DB.batch(statements);
    } catch (error) {
      if (/unique|constraint/i.test(String(error))) return jsonBody({ error: "The article slug is already in use or a referenced record is invalid." }, 409);
      throw error;
    }
    return jsonBody({ success: true });
  }
  if (request.method === "DELETE" && id) {
    const current = await env.DB.prepare("SELECT id FROM blog_articles WHERE id = ? LIMIT 1").bind(id).first();
    if (!current) return jsonBody({ error: "Article not found." }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM blog_articles WHERE id = ?").bind(id),
      env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "delete", "blog_article", id),
    ]);
    return jsonBody({ success: true });
  }
  return jsonBody({ error: "Method not allowed." }, 405);
}

export async function handleBlogAdmin(request, env, url, identity) {
  const path = url.pathname;
  const articleMatch = path.match(/^\/api\/admin\/blog\/articles(?:\/([0-9a-f-]{36}))?$/i);
  if (articleMatch) return handleArticles(request, env, url, identity, articleMatch[1] || null);
  const taxonomyMatch = path.match(/^\/api\/admin\/blog\/(categories|tags|authors)(?:\/([0-9a-f-]{36}))?$/i);
  if (taxonomyMatch) return handleTaxonomy(request, env, url, identity, taxonomyMatch[1], taxonomyMatch[2] || null);
  return null;
}

export async function handleBlogPublic(request, env, url, respond) {
  const path = url.pathname;
  if (!path.startsWith("/api/public/blog/")) return null;
  if (request.method !== "GET") return respond(request, env, { error: "Method not allowed." }, 405, { allow: "GET" });
  if (path === "/api/public/blog/categories") {
    const rows = await env.DB.prepare("SELECT id, name, slug, description FROM blog_categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC").all();
    return respond(request, env, { data: rows.results || [] });
  }
  if (path === "/api/public/blog/articles") {
    const limitRaw = Number(url.searchParams.get("limit") || 20);
    const offsetRaw = Number(url.searchParams.get("offset") || 0);
    if (!Number.isInteger(limitRaw) || !Number.isInteger(offsetRaw) || offsetRaw < 0) return respond(request, env, { error: "Invalid pagination." }, 400);
    const limit = Math.min(Math.max(limitRaw, 1), 50);
    const offset = Math.min(offsetRaw, 1000000);
    const rows = await env.DB.prepare(
      "SELECT a.id, a.title, a.slug, a.excerpt, a.category_id, c.name AS category_name, c.slug AS category_slug, a.author_id, u.display_name AS author_name, a.featured_media_id, a.seo_title, a.meta_description, a.og_media_id, a.published_at, a.reading_minutes, a.is_featured, a.robots_index FROM blog_articles a LEFT JOIN blog_categories c ON c.id = a.category_id LEFT JOIN blog_authors u ON u.id = a.author_id WHERE a.status = 'published' ORDER BY a.published_at DESC LIMIT ? OFFSET ?"
    ).bind(limit, offset).all();
    return respond(request, env, { data: rows.results || [], limit, offset });
  }
  const articleMatch = path.match(/^\/api\/public\/blog\/articles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  if (articleMatch) {
    const article = await env.DB.prepare(
      "SELECT a.id, a.title, a.slug, a.excerpt, a.content_json, a.category_id, c.name AS category_name, c.slug AS category_slug, a.author_id, u.display_name AS author_name, u.slug AS author_slug, u.biography AS author_biography, a.featured_media_id, a.seo_title, a.meta_description, a.canonical_url, a.og_title, a.og_description, a.og_media_id, a.published_at, a.updated_at, a.reading_minutes, a.robots_index FROM blog_articles a LEFT JOIN blog_categories c ON c.id = a.category_id LEFT JOIN blog_authors u ON u.id = a.author_id WHERE a.slug = ? AND a.status = 'published' LIMIT 1"
    ).bind(articleMatch[1]).first();
    if (!article) return respond(request, env, { error: "Not found." }, 404);
    const tags = await env.DB.prepare("SELECT t.name, t.slug FROM blog_tags t INNER JOIN blog_article_tags at ON at.tag_id = t.id WHERE at.article_id = ? ORDER BY t.name").bind(article.id).all();
    let content;
    try { content = JSON.parse(article.content_json); } catch { return respond(request, env, { error: "Article content is unavailable." }, 500); }
    delete article.content_json;
    return respond(request, env, { data: { ...article, content, tags: tags.results || [] } });
  }
  return respond(request, env, { error: "Not found." }, 404);
}
