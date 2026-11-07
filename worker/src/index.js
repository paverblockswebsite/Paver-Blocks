const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY_BYTES = 16384;
const VALID_INQUIRY_STATUSES = new Set(["new", "contacted", "quoted", "completed", "closed"]);
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let jwksCache = { expiresAt: 0, keys: [] };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !env.SITE_ORIGIN || origin !== env.SITE_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}

function response(request, env, data, status = 200, extraHeaders = {}) {
  return json(data, status, { ...corsHeaders(request, env), ...extraHeaders });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value, max, required = false) {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if ((required && cleaned.length === 0) || cleaned.length > max) return null;
  return cleaned;
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return { error: "Request is too large." };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { error: "Request is too large." };
  try {
    const value = JSON.parse(raw);
    return isPlainObject(value) ? { value } : { error: "A JSON object is required." };
  } catch {
    return { error: "Invalid JSON." };
  }
}

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_HOSTNAME || !token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);

  try {
    const verifyResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    if (!verifyResponse.ok) return false;
    const result = await verifyResponse.json();
    if (!result.success || result.hostname !== env.TURNSTILE_HOSTNAME) return false;
    if (result.action !== "inquiry") return false;
    return true;
  } catch {
    return false;
  }
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonSegment(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getAccessKeys(teamDomain) {
  const now = Date.now();
  if (jwksCache.expiresAt > now && jwksCache.keys.length) return jwksCache.keys;

  const url = "https://" + teamDomain + "/cdn-cgi/access/certs";
  const result = await fetch(url, { headers: { accept: "application/json" } });
  if (!result.ok) throw new Error("Access signing keys could not be retrieved.");
  const body = await result.json();
  if (!Array.isArray(body.keys)) throw new Error("Access signing keys response was invalid.");

  jwksCache = { keys: body.keys, expiresAt: now + 5 * 60 * 1000 };
  return jwksCache.keys;
}

async function verifyAccessIdentity(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAILS) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = decodeJsonSegment(parts[0]);
    const claims = decodeJsonSegment(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const expectedIssuer = "https://" + teamDomain;
    if (claims.iss !== expectedIssuer) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60) return null;
    if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return null;

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const allowedEmails = env.ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (!email || !allowedEmails.includes(email)) return null;

    const keys = await getAccessKeys(teamDomain);
    const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) return null;

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signedContent = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const signature = decodeBase64Url(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signedContent);
    if (!valid) return null;

    return { email };
  } catch {
    return null;
  }
}

async function publicList(request, env, table, columns, extraWhere = "") {
  const sql = "SELECT " + columns + " FROM " + table +
    " WHERE status = 'published' " + extraWhere + " ORDER BY sort_order ASC";
  const result = await env.DB.prepare(sql).all();
  return response(request, env, { data: result.results || [] });
}

async function handlePublic(request, env, url) {
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/public/projects") {
    return publicList(request, env, "projects", "id, title, slug, location, completed_on, summary");
  }

  if (request.method === "GET" && path.startsWith("/api/public/projects/")) {
    let slug;
    try {
      slug = decodeURIComponent(path.slice("/api/public/projects/".length));
    } catch {
      return response(request, env, { error: "Not found." }, 404);
    }
    if (!slug || slug.includes("/")) return response(request, env, { error: "Not found." }, 404);
    const project = await env.DB.prepare(
      "SELECT id, title, slug, location, completed_on, summary, description FROM projects WHERE slug = ? AND status = 'published' LIMIT 1",
    ).bind(slug).first();
    if (!project) return response(request, env, { error: "Not found." }, 404);
    const images = await env.DB.prepare(
      "SELECT object_key, alt_text, caption FROM project_images WHERE project_id = ? ORDER BY sort_order ASC",
    ).bind(project.id).all();
    return response(request, env, { data: { ...project, images: images.results || [] } });
  }

  if (request.method === "GET" && path === "/api/public/services") {
    return publicList(request, env, "services", "id, title, slug, short_description, description");
  }

  if (request.method === "GET" && path === "/api/public/paver-designs") {
    return publicList(request, env, "paver_designs", "id, name, slug, shape, dimensions, thickness, colour");
  }

  if (request.method === "GET" && path === "/api/public/testimonials") {
    return publicList(
      request,
      env,
      "testimonials",
      "id, customer_display_name, customer_role_or_company, testimonial_text",
      "AND permission_confirmed = 1",
    );
  }

  if (request.method === "POST" && path === "/api/public/inquiries") {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);

    const input = parsed.value;
    const allowedKeys = new Set([
      "customer_name", "phone", "email", "location", "work_type",
      "approximate_area", "budget", "project_details", "turnstile_token",
    ]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
      return response(request, env, { error: "Unexpected field in request." }, 400);
    }

    const customerName = cleanString(input.customer_name, 120, true);
    const phone = cleanString(input.phone, 40, true);
    const email = cleanString(input.email, 254);
    const location = cleanString(input.location, 180, true);
    const workType = cleanString(input.work_type, 120, true);
    const area = cleanString(input.approximate_area, 120);
    const budget = cleanString(input.budget, 120);
    const details = cleanString(input.project_details, 4000, true);

    if ([customerName, phone, location, workType, details].some((value) => value === null) ||
        email === null || area === null || budget === null ||
        (email && !VALID_EMAIL.test(email))) {
      return response(request, env, { error: "Please check the inquiry fields and try again." }, 400);
    }

    const token = cleanString(input.turnstile_token, 2048, true);
    if (!token) return response(request, env, { error: "Please complete the spam-protection check." }, 400);
    if (!(await verifyTurnstile(token, request, env))) {
      return response(request, env, { error: "Spam-protection verification failed. Please try again." }, 400);
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO inquiries " +
      "(id, customer_name, phone, email, location, work_type, approximate_area, budget, project_details) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, customerName, phone, email || null, location, workType, area || null, budget || null, details).run();

    return response(request, env, { success: true, message: "Your inquiry has been received." }, 201);
  }

  return response(request, env, { error: "Not found." }, 404);
}

async function handleAdmin(request, env, url, identity) {
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/admin/inquiries") {
    const status = url.searchParams.get("status");
    if (status && !VALID_INQUIRY_STATUSES.has(status)) {
      return response(request, env, { error: "Invalid inquiry status." }, 400);
    }
    const limitValue = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 100) : 50;
    const offsetValue = Number(url.searchParams.get("offset") || 0);
    const offset = Number.isInteger(offsetValue) ? Math.max(offsetValue, 0) : 0;

    const query = status
      ? env.DB.prepare(
          "SELECT id, customer_name, phone, email, location, work_type, approximate_area, budget, project_details, status, internal_notes, created_at, updated_at FROM inquiries WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        ).bind(status, limit, offset)
      : env.DB.prepare(
          "SELECT id, customer_name, phone, email, location, work_type, approximate_area, budget, project_details, status, internal_notes, created_at, updated_at FROM inquiries ORDER BY created_at DESC LIMIT ? OFFSET ?",
        ).bind(limit, offset);

    const result = await query.all();
    return response(request, env, { data: result.results || [], limit, offset });
  }

  const inquiryMatch = path.match(/^\/api\/admin\/inquiries\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && inquiryMatch) {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);
    const input = parsed.value;
    const keys = Object.keys(input);
    if (keys.length === 0 || keys.some((key) => !["status", "internal_notes"].includes(key))) {
      return response(request, env, { error: "Only status and internal_notes may be updated." }, 400);
    }

    const current = await env.DB.prepare("SELECT id FROM inquiries WHERE id = ? LIMIT 1")
      .bind(inquiryMatch[1]).first();
    if (!current) return response(request, env, { error: "Inquiry not found." }, 404);

    const status = input.status === undefined ? null : cleanString(input.status, 20, true);
    const notes = input.internal_notes === undefined ? null : cleanString(input.internal_notes, 4000);
    if ((input.status !== undefined && (!status || !VALID_INQUIRY_STATUSES.has(status))) ||
        (input.internal_notes !== undefined && notes === null)) {
      return response(request, env, { error: "Invalid inquiry update." }, 400);
    }

    await env.DB.prepare(
      "UPDATE inquiries SET status = COALESCE(?, status), internal_notes = COALESCE(?, internal_notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(status, notes, inquiryMatch[1]).run();

    await env.DB.prepare(
      "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), identity.email, "update", "inquiry", inquiryMatch[1]).run();

    return response(request, env, { success: true });
  }

  return response(request, env, { error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request, env);
      if (!headers["access-control-allow-origin"]) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return response(request, env, { ok: true });
    }

    const allowedOrigin = corsHeaders(request, env);
    if (request.headers.get("Origin") && !allowedOrigin["access-control-allow-origin"]) {
      return json({ error: "Origin not allowed." }, 403);
    }

    try {
      if (url.pathname.startsWith("/api/public/")) {
        if (request.method !== "GET" && request.method !== "POST") {
          return response(request, env, { error: "Method not allowed." }, 405, { allow: "GET, POST" });
        }
        return await handlePublic(request, env, url);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const identity = await verifyAccessIdentity(request, env);
        if (!identity) return response(request, env, { error: "Unauthorized." }, 401);
        if (request.method !== "GET" && request.method !== "PATCH") {
          return response(request, env, { error: "Method not allowed." }, 405);
        }
        return await handleAdmin(request, env, url, identity);
      }

      return response(request, env, { error: "Not found." }, 404);
    } catch {
      return response(request, env, { error: "The request could not be completed." }, 500);
    }
  },
};