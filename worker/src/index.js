const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY_BYTES = 16384;
const VALID_INQUIRY_STATUSES = new Set(["new", "contacted", "quoted", "completed", "closed"]);
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let jwksCache = { teamDomain: "", expiresAt: 0, keys: [] };

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

function isValidDateOnly(value) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { error: "Content-Type must be application/json." };

  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader)) return { error: "Invalid Content-Length." };
    if (Number(lengthHeader) > MAX_BODY_BYTES) return { error: "Request is too large." };
  }

  if (!request.body) return { error: "Invalid JSON." };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: "Request is too large." };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "Request body could not be read." };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(raw);
    return isPlainObject(value) ? { value } : { error: "A JSON object is required." };
  } catch {
    return { error: "Invalid JSON." };
  }
}

async function checkInquiryRateLimit(request, env) {
  const limiter = env.INQUIRY_RATE_LIMITER;
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (!limiter || typeof limiter.limit !== "function" || !clientIp) {
    return { allowed: false, unavailable: true };
  }
  try {
    const result = await limiter.limit({ key: "public-inquiry:" + clientIp });
    return { allowed: result?.success === true, unavailable: false };
  } catch {
    return { allowed: false, unavailable: true };
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
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonSegment(value) {
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)));
  if (!isPlainObject(decoded)) throw new Error("JWT segment must contain an object.");
  return decoded;
}

async function getAccessKeys(teamDomain) {
  const now = Date.now();
  if (jwksCache.teamDomain === teamDomain && jwksCache.expiresAt > now && jwksCache.keys.length) {
    return jwksCache.keys;
  }

  const url = "https://" + teamDomain + "/cdn-cgi/access/certs";
  const result = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error("Access signing keys could not be retrieved.");
  const body = await result.json();
  if (!Array.isArray(body.keys)) throw new Error("Access signing keys response was invalid.");

  jwksCache = { teamDomain, keys: body.keys, expiresAt: now + 5 * 60 * 1000 };
  return jwksCache.keys;
}

async function verifyAccessIdentity(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAILS) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (typeof token !== "string" || token.length > 8192) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;

    const header = decodeJsonSegment(parts[0]);
    const claims = decodeJsonSegment(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" ||
        header.kid.length === 0 || header.kid.length > 256) return null;

    const configuredDomain = env.ACCESS_TEAM_DOMAIN.trim();
    let parsedDomain;
    try {
      parsedDomain = new URL(configuredDomain.startsWith("https://") ? configuredDomain : "https://" + configuredDomain);
    } catch {
      return null;
    }
    if (parsedDomain.protocol !== "https:" || parsedDomain.username || parsedDomain.password ||
        parsedDomain.port || parsedDomain.pathname !== "/" || parsedDomain.search || parsedDomain.hash) return null;
    const teamDomain = parsedDomain.hostname.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(teamDomain) || teamDomain.includes("..")) return null;
    const expectedIssuer = "https://" + teamDomain;
    if (claims.iss !== expectedIssuer) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
    if (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + 60)) return null;
    if (typeof claims.sub !== "string" || claims.sub.trim().length === 0) return null;

    const audiences = Array.isArray(claims.aud) ? claims.aud :
      (typeof claims.aud === "string" ? [claims.aud] : []);
    if (!audiences.length || audiences.some((audience) => typeof audience !== "string") ||
        !audiences.includes(env.ACCESS_AUD)) return null;

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const allowedEmails = env.ADMIN_EMAILS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (!email || !allowedEmails.includes(email)) return null;

    const keys = await getAccessKeys(teamDomain);
    const jwk = keys.find((key) =>
      key && key.kid === header.kid && key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256") &&
      (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify")))
    );
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


  if (request.method === "GET" && path === "/api/public/site-settings") {
    const keys = ["hero_title", "hero_subtitle", "hero_cta_label", "about_heading", "about_text", "experience_statement"];
    const result = await env.DB.prepare(
      "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (" + keys.map(() => "?").join(", ") + ")",
    ).bind(...keys).all();
    const data = {};
    for (const row of result.results || []) data[row.setting_key] = row.setting_value;
    return response(request, env, { data });
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
    const rateLimit = await checkInquiryRateLimit(request, env);
    if (rateLimit.unavailable) {
      return response(request, env, { error: "Inquiry submission is temporarily unavailable. Please try again later." }, 503);
    }
    if (!rateLimit.allowed) {
      return response(request, env, { error: "Too many inquiry attempts. Please wait before trying again." }, 429, { "retry-after": "60" });
    }
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


const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Admin dashboard | Paver Blocks</title>
  <link rel="stylesheet" href="/admin/assets/admin.css">
  <script src="/admin/assets/admin.js" defer></script>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/admin" aria-label="Paver Blocks admin home">PAVER BLOCKS <span>ADMIN</span></a>
    <a class="public-link" href="/" rel="noopener">Public website ↗</a>
  </header>
  <main class="shell">
    <section class="intro">
      <p class="eyebrow">PRIVATE ADMINISTRATION</p>
      <h1>Customer inquiries</h1>
      <p class="muted">Review incoming quotation requests and keep their progress up to date.</p>
    </section>
    <section class="toolbar" aria-label="Inquiry filters">
      <label for="status-filter">Filter by status</label>
      <select id="status-filter">
        <option value="">All inquiries</option>
        <option value="new">New</option>
        <option value="contacted">Contacted</option>
        <option value="quoted">Quoted</option>
        <option value="completed">Completed</option>
        <option value="closed">Closed</option>
      </select>
      <button id="refresh" type="button" class="button secondary">Refresh</button>
    </section>
    <p id="notice" class="notice" role="status" aria-live="polite">Loading inquiries…</p>
    <section id="inquiry-list" class="inquiry-list" aria-label="Inquiry list"></section>

    <section class="content-heading">
      <div><p class="eyebrow">PORTFOLIO CONTENT</p><h2>Projects</h2><p class="muted">Create projects and update their public visibility.</p></div>
      <button id="project-new" type="button" class="button primary">Add project</button>
    </section>
    <p id="project-notice" class="notice" role="status" aria-live="polite">Loading projects…</p>
    <form id="project-form" class="project-form" hidden>
      <h3 id="project-form-title">Add project</h3>
      <input type="hidden" name="id">
      <div class="project-fields">
        <label>Project title<input name="title" maxlength="160" required></label>
        <label>URL slug<input name="slug" maxlength="180" pattern="[a-z0-9]+(-[a-z0-9]+)*" required><small>Lowercase letters, numbers and hyphens only.</small></label>
        <label>Location<input name="location" maxlength="180"></label>
        <label>Completion date<input name="completed_on" type="date"></label>
        <label>Status<select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
        <label>Display order<input name="sort_order" type="number" min="-100000" max="100000" step="1" value="0"></label>
        <label class="wide">Short summary<textarea name="summary" maxlength="2000" rows="3"></textarea></label>
        <label class="wide">Project description<textarea name="description" maxlength="10000" rows="5"></textarea></label>
      </div>
      <div class="form-actions"><button type="submit" class="button primary">Save project</button><button id="project-cancel" type="button" class="button secondary">Cancel</button></div>
    </form>
    <section id="project-list" class="project-list" aria-label="Projects"></section>

    <section class="content-heading">
      <div><p class="eyebrow">SERVICE CATALOGUE</p><h2>Services</h2><p class="muted">Manage the services shown on the public website.</p></div>
      <button id="service-new" type="button" class="button primary">Add service</button>
    </section>
    <p id="service-notice" class="notice" role="status" aria-live="polite">Loading services…</p>
    <form id="service-form" class="content-form" hidden>
      <h3 id="service-form-title">Add service</h3><input type="hidden" name="id">
      <div class="content-fields">
        <label>Service title<input name="title" maxlength="160" required></label>
        <label>URL slug<input name="slug" maxlength="180" pattern="[a-z0-9]+(-[a-z0-9]+)*" required></label>
        <label>Status<select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
        <label>Display order<input name="sort_order" type="number" min="-100000" max="100000" step="1" value="0"></label>
        <label class="wide">Short description<textarea name="short_description" maxlength="2000" rows="2"></textarea></label>
        <label class="wide">Full description<textarea name="description" maxlength="10000" rows="4"></textarea></label>
      </div>
      <div class="form-actions"><button type="submit" class="button primary">Save service</button><button id="service-cancel" type="button" class="button secondary">Cancel</button></div>
    </form>
    <section id="service-list" class="project-list" aria-label="Services"></section>

    <section class="content-heading">
      <div><p class="eyebrow">PAVER CATALOGUE</p><h2>Paver designs</h2><p class="muted">Record available designs and supplier details. Do not imply in-house manufacturing.</p></div>
      <button id="design-new" type="button" class="button primary">Add paver design</button>
    </section>
    <p id="design-notice" class="notice" role="status" aria-live="polite">Loading paver designs…</p>
    <form id="design-form" class="content-form" hidden>
      <h3 id="design-form-title">Add paver design</h3><input type="hidden" name="id">
      <div class="content-fields">
        <label>Design name<input name="name" maxlength="120" required></label>
        <label>URL slug<input name="slug" maxlength="160" pattern="[a-z0-9]+(-[a-z0-9]+)*" required></label>
        <label>Shape<input name="shape" maxlength="120" placeholder="e.g. I-shape, Zigzag"></label>
        <label>Dimensions<input name="dimensions" maxlength="120" placeholder="Supplier-confirmed dimensions"></label>
        <label>Thickness<input name="thickness" maxlength="80" placeholder="Supplier-confirmed thickness"></label>
        <label>Colour<input name="colour" maxlength="80"></label>
        <label>Status<select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
        <label>Display order<input name="sort_order" type="number" min="-100000" max="100000" step="1" value="0"></label>
        <label class="wide">Supplier note (internal)<textarea name="supplier_note" maxlength="500" rows="2"></textarea></label>
      </div>
      <div class="form-actions"><button type="submit" class="button primary">Save design</button><button id="design-cancel" type="button" class="button secondary">Cancel</button></div>
    </form>
    <section id="design-list" class="project-list" aria-label="Paver designs"></section>


    <section class="content-heading">
      <div><p class="eyebrow">CUSTOMER FEEDBACK</p><h2>Testimonials</h2><p class="muted">Only publish a testimonial after the customer has given permission.</p></div>
      <button id="testimonial-new" type="button" class="button primary">Add testimonial</button>
    </section>
    <p id="testimonial-notice" class="notice" role="status" aria-live="polite">Loading testimonials…</p>
    <form id="testimonial-form" class="content-form" hidden>
      <h3 id="testimonial-form-title">Add testimonial</h3><input type="hidden" name="id">
      <div class="content-fields">
        <label>Customer display name<input name="customer_display_name" maxlength="120" required></label>
        <label>Role or company (optional)<input name="customer_role_or_company" maxlength="160"></label>
        <label class="wide">Testimonial text<textarea name="testimonial_text" maxlength="2000" rows="4" required></textarea></label>
        <label>Status<select name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></label>
        <label>Display order<input name="sort_order" type="number" min="-100000" max="100000" step="1" value="0"></label>
        <label class="consent wide"><input name="permission_confirmed" type="checkbox"> I confirm the customer has explicitly permitted this testimonial to be published.</label>
      </div>
      <div class="form-actions"><button type="submit" class="button primary">Save testimonial</button><button id="testimonial-cancel" type="button" class="button secondary">Cancel</button></div>
    </form>
    <section id="testimonial-list" class="project-list" aria-label="Testimonials"></section>

    <section class="content-heading">
      <div><p class="eyebrow">HOMEPAGE EDITOR</p><h2>Homepage content</h2><p class="muted">Update approved text fields. Save only accurate, verified business information.</p></div>
    </section>
    <p id="homepage-notice" class="notice" role="status" aria-live="polite">Loading homepage content…</p>
    <form id="homepage-form" class="content-form">
      <div class="content-fields">
        <label>Hero heading<input name="hero_title" maxlength="120"></label>
        <label>Hero button label<input name="hero_cta_label" maxlength="60"></label>
        <label class="wide">Hero subtitle<textarea name="hero_subtitle" maxlength="300" rows="2"></textarea></label>
        <label>About heading<input name="about_heading" maxlength="120"></label>
        <label>Experience statement<input name="experience_statement" maxlength="180"></label>
        <label class="wide">About text<textarea name="about_text" maxlength="2000" rows="4"></textarea></label>
      </div>
      <div class="form-actions"><button type="submit" class="button primary">Save homepage content</button></div>
    </form>


    <p class="footnote">Private business information. Sign out of your Cloudflare Access session on shared devices.</p>
  </main>
</body>
</html>`;

const ADMIN_CSS = `
:root{color-scheme:light;--navy:#172b45;--yellow:#f5c542;--ink:#1d2938;--muted:#657386;--line:#dce2e9;--paper:#f5f7fa}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.topbar{height:68px;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 max(22px,calc((100% - 1100px)/2))}
.brand{color:#fff;text-decoration:none;font-weight:800;letter-spacing:.06em}.brand span{color:var(--yellow);font-size:.75rem;margin-left:8px}.public-link{color:#fff;text-decoration:none;font-size:.9rem}
.shell{max-width:1100px;margin:0 auto;padding:42px 22px 64px}.intro{margin-bottom:28px}.eyebrow{font-size:.75rem;font-weight:800;letter-spacing:.14em;color:#8b6810}.intro h1{font-size:clamp(2rem,5vw,2.7rem);line-height:1.1;margin:8px 0;color:var(--navy)}.muted,.footnote{color:var(--muted)}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:18px}.toolbar label{font-weight:650}.toolbar select,.editor select,.editor textarea{font:inherit;border:1px solid #bdc7d3;border-radius:8px;padding:10px;background:#fff;color:var(--ink)}.button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}.primary{background:var(--navy);color:#fff}.secondary{background:#e9eef4;color:var(--navy)}button:focus-visible,a:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #d69e00;outline-offset:2px}
.notice{min-height:26px;color:var(--muted)}.notice.error{color:#a12626}.inquiry-list,.project-list{display:grid;gap:14px}.inquiry,.project-card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 2px 8px #172b4508}.inquiry-head,.project-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.inquiry h2,.project-card h3{font-size:1.12rem;color:var(--navy);margin:0 0 4px}.meta{color:var(--muted);font-size:.9rem}.pill{font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border-radius:30px;padding:5px 9px;background:#edf1f5;color:#43546a;white-space:nowrap}.details{white-space:pre-wrap;overflow-wrap:anywhere;margin:14px 0}.facts{display:flex;gap:10px 18px;flex-wrap:wrap;font-size:.9rem;color:#48576a}.editor{border-top:1px solid var(--line);margin-top:16px;padding-top:16px;display:grid;grid-template-columns:minmax(140px,220px) 1fr auto;gap:10px;align-items:end}.editor label,.project-fields label{display:grid;gap:5px;font-size:.85rem;font-weight:650}.editor textarea,.project-fields input,.project-fields select,.project-fields textarea{font:inherit;border:1px solid #bdc7d3;border-radius:8px;padding:10px;background:#fff;color:var(--ink);width:100%}.editor textarea{min-height:42px;resize:vertical}.empty{background:#fff;border:1px dashed #bdc7d3;border-radius:14px;padding:30px;text-align:center;color:var(--muted)}.content-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:48px 0 12px}.content-heading h2{font-size:1.7rem;color:var(--navy);margin:4px 0}.project-form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0}.project-form h3{margin:0 0 16px;color:var(--navy)}.project-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.project-fields .wide{grid-column:1/-1}.project-fields small{font-weight:400;color:var(--muted)}.form-actions{display:flex;gap:10px;margin-top:18px}.project-card p{margin:8px 0}.project-card .project-actions{display:flex;gap:8px;margin-top:14px}.footnote{font-size:.82rem;margin-top:34px}
.content-fields .consent{display:flex;align-items:flex-start;gap:10px}.content-fields .consent input{width:auto;margin-top:4px}
.content-form{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0}.content-form h3{margin:0 0 16px;color:var(--navy)}.content-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.content-fields label{display:grid;gap:5px;font-size:.85rem;font-weight:650}.content-fields input,.content-fields select,.content-fields textarea{font:inherit;border:1px solid #bdc7d3;border-radius:8px;padding:10px;background:#fff;color:var(--ink);width:100%}.content-fields .wide{grid-column:1/-1}.content-actions{display:flex;gap:8px;margin-top:14px}
@media(max-width:650px){.shell{padding-top:28px}.editor{grid-template-columns:1fr}.inquiry-head,.project-head{align-items:flex-start}.topbar{padding:0 16px}.project-fields{grid-template-columns:1fr}.project-fields .wide{grid-column:auto}.content-heading{align-items:flex-start;flex-direction:column}}
`;

const ADMIN_JS = `
const list = document.querySelector("#inquiry-list");
const notice = document.querySelector("#notice");
const filter = document.querySelector("#status-filter");
const statuses = ["new","contacted","quoted","completed","closed"];
const labelStatus = value => value.charAt(0).toUpperCase() + value.slice(1);
const element = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}
function makeInquiry(item) {
  const card = element("article","inquiry");
  const head = element("div","inquiry-head");
  const heading = element("div");
  heading.append(element("h2","",item.customer_name || "Unnamed customer"));
  heading.append(element("p","meta",item.created_at ? new Date(item.created_at.replace(" ","T")+"Z").toLocaleString() : ""));
  head.append(heading,element("span","pill",labelStatus(item.status || "new")));
  card.append(head);
  const facts = element("div","facts");
  [item.phone,item.email,item.location,item.work_type,item.approximate_area ? "Area: "+item.approximate_area : "",item.budget ? "Budget: "+item.budget : ""]
    .filter(Boolean).forEach(value => facts.append(element("span","",value)));
  card.append(facts);
  card.append(element("p","details",item.project_details || "No project details provided."));
  const editor = element("form","editor");
  const statusLabel = element("label","","Status");
  const status = document.createElement("select");
  statuses.forEach(value => { const option=document.createElement("option");option.value=value;option.textContent=labelStatus(value);status.append(option); });
  status.value = statuses.includes(item.status) ? item.status : "new";
  statusLabel.append(status);
  const notesLabel = element("label","","Internal notes");
  const notes = document.createElement("textarea");
  notes.maxLength=4000;notes.value=item.internal_notes || "";notes.placeholder="Private notes for your team…";
  notesLabel.append(notes);
  const save = element("button","button primary","Save update");save.type="submit";
  editor.append(statusLabel,notesLabel,save);
  editor.addEventListener("submit",async event=>{
    event.preventDefault();save.disabled=true;save.textContent="Saving…";
    try {
      await api("/api/admin/inquiries/"+encodeURIComponent(item.id),{
        method:"PATCH",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({status:status.value,internal_notes:notes.value})
      });
      notice.className="notice";notice.textContent="Inquiry updated.";
      await load();
    } catch(error) { notice.className="notice error";notice.textContent=error.message; }
    finally { save.disabled=false;save.textContent="Save update"; }
  });
  card.append(editor);
  return card;
}
async function load() {
  list.replaceChildren();notice.className="notice";notice.textContent="Loading inquiries…";
  try {
    const query=filter.value ? "?status="+encodeURIComponent(filter.value) : "";
    const payload=await api("/api/admin/inquiries"+query);
    const items=Array.isArray(payload.data)?payload.data:[];
    if (!items.length) list.append(element("div","empty","No inquiries found for this filter."));
    else items.forEach(item=>list.append(makeInquiry(item)));
    notice.textContent=items.length+" inquiry record"+(items.length===1?"":"s")+" loaded.";
  } catch(error) { notice.className="notice error";notice.textContent=error.message; }
}
document.querySelector("#refresh").addEventListener("click",load);
filter.addEventListener("change",load);

const projectList = document.querySelector("#project-list");
const projectNotice = document.querySelector("#project-notice");
const projectForm = document.querySelector("#project-form");
const projectFields = projectForm.elements;
function showProjectForm(item) {
  projectForm.reset();
  projectFields.namedItem("id").value = item?.id || "";
  projectFields.namedItem("title").value = item?.title || "";
  projectFields.namedItem("slug").value = item?.slug || "";
  projectFields.namedItem("location").value = item?.location || "";
  projectFields.namedItem("completed_on").value = item?.completed_on || "";
  projectFields.namedItem("status").value = item?.status || "draft";
  projectFields.namedItem("sort_order").value = Number.isInteger(item?.sort_order) ? item.sort_order : 0;
  projectFields.namedItem("summary").value = item?.summary || "";
  projectFields.namedItem("description").value = item?.description || "";
  document.querySelector("#project-form-title").textContent = item ? "Edit project" : "Add project";
  projectForm.hidden = false;
  projectFields.namedItem("title").focus();
}
function makeProject(item) {
  const card=element("article","project-card");
  const head=element("div","project-head");
  const title=element("div");
  title.append(element("h3","",item.title || "Untitled project"));
  title.append(element("p","meta",item.slug || ""));
  head.append(title,element("span","pill",labelStatus(item.status || "draft")));
  card.append(head);
  if(item.location) card.append(element("p","meta",item.location));
  if(item.summary) card.append(element("p","",item.summary));
  const actions=element("div","project-actions");
  const edit=element("button","button secondary","Edit");
  edit.type="button";edit.addEventListener("click",()=>showProjectForm(item));
  actions.append(edit);card.append(actions);
  return card;
}
async function loadProjects() {
  projectList.replaceChildren();projectNotice.className="notice";projectNotice.textContent="Loading projects…";
  try {
    const payload=await api("/api/admin/projects");
    const items=Array.isArray(payload.data)?payload.data:[];
    if(!items.length) projectList.append(element("div","empty","No projects yet. Add a project when you are ready."));
    else items.forEach(item=>projectList.append(makeProject(item)));
    projectNotice.textContent=items.length+" project record"+(items.length===1?"":"s")+" loaded.";
  } catch(error) { projectNotice.className="notice error";projectNotice.textContent=error.message; }
}
document.querySelector("#project-new").addEventListener("click",()=>showProjectForm());
document.querySelector("#project-cancel").addEventListener("click",()=>{projectForm.hidden=true;projectForm.reset();});
projectForm.addEventListener("submit",async event=>{
  event.preventDefault();
  const id=projectFields.namedItem("id").value;
  const body={
    title:projectFields.namedItem("title").value,
    slug:projectFields.namedItem("slug").value,
    location:projectFields.namedItem("location").value,
    completed_on:projectFields.namedItem("completed_on").value,
    status:projectFields.namedItem("status").value,
    sort_order:Number(projectFields.namedItem("sort_order").value),
    summary:projectFields.namedItem("summary").value,
    description:projectFields.namedItem("description").value
  };
  const save=projectForm.querySelector('button[type="submit"]');
  save.disabled=true;save.textContent="Saving…";
  try {
    await api(id?"/api/admin/projects/"+encodeURIComponent(id):"/api/admin/projects",{
      method:id?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    projectNotice.className="notice";projectNotice.textContent="Project saved.";
    projectForm.hidden=true;await loadProjects();
  } catch(error) { projectNotice.className="notice error";projectNotice.textContent=error.message; }
  finally { save.disabled=false;save.textContent="Save project"; }
});

function setupContentManager(config) {
  const listNode=document.querySelector(config.list);
  const noticeNode=document.querySelector(config.notice);
  const form=document.querySelector(config.form);
  const fields=form.elements;
  const fieldNames=config.fields;
  function showForm(item) {
    form.reset();
    fields.namedItem("id").value=item?.id || "";
    for(const name of fieldNames) {
      const field=fields.namedItem(name);
      if(field) field.value=item?.[name] ?? "";
    }
    fields.namedItem("status").value=item?.status || "draft";
    fields.namedItem("sort_order").value=Number.isInteger(item?.sort_order)?item.sort_order:0;
    document.querySelector(config.title).textContent=(item?"Edit ":"Add ")+config.singular;
    form.hidden=false;
    fields.namedItem(config.requiredField).focus();
  }
  function makeCard(item) {
    const card=element("article","project-card");
    const head=element("div","project-head");
    const title=element("div");
    title.append(element("h3","",item[config.nameField] || "Untitled"));
    title.append(element("p","meta",item.slug || ""));
    head.append(title,element("span","pill",labelStatus(item.status || "draft")));
    card.append(head);
    config.summaryFields.forEach(key=>{if(item[key])card.append(element("p","",item[key]));});
    const actions=element("div","content-actions");
    const edit=element("button","button secondary","Edit");
    edit.type="button";edit.addEventListener("click",()=>showForm(item));
    actions.append(edit);card.append(actions);
    return card;
  }
  async function loadItems() {
    listNode.replaceChildren();noticeNode.className="notice";noticeNode.textContent="Loading "+config.plural.toLowerCase()+"…";
    try {
      const payload=await api(config.endpoint);
      const items=Array.isArray(payload.data)?payload.data:[];
      if(!items.length)listNode.append(element("div","empty","No "+config.plural.toLowerCase()+" yet."));
      else items.forEach(item=>listNode.append(makeCard(item)));
      noticeNode.textContent=items.length+" "+config.plural.toLowerCase()+" record"+(items.length===1?"":"s")+" loaded.";
    } catch(error) {noticeNode.className="notice error";noticeNode.textContent=error.message;}
  }
  document.querySelector(config.add).addEventListener("click",()=>showForm());
  document.querySelector(config.cancel).addEventListener("click",()=>{form.hidden=true;form.reset();});
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const id=fields.namedItem("id").value;
    const body={};
    fieldNames.forEach(name=>{
      const field=fields.namedItem(name);
      body[name]=name==="sort_order"?Number(field.value):field.value;
    });
    const save=form.querySelector('button[type="submit"]');
    save.disabled=true;save.textContent="Saving…";
    try {
      await api(id?config.endpoint+"/"+encodeURIComponent(id):config.endpoint,{
        method:id?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
      });
      noticeNode.className="notice";noticeNode.textContent=config.singular+" saved.";
      form.hidden=true;await loadItems();
    } catch(error) {noticeNode.className="notice error";noticeNode.textContent=error.message;}
    finally {save.disabled=false;save.textContent=config.saveLabel;}
  });
  loadItems();
}
setupContentManager({
  endpoint:"/api/admin/services",list:"#service-list",notice:"#service-notice",form:"#service-form",
  title:"#service-form-title",add:"#service-new",cancel:"#service-cancel",singular:"service",plural:"Services",
  nameField:"title",requiredField:"title",summaryFields:["short_description"],
  fields:["title","slug","status","sort_order","short_description","description"],saveLabel:"Save service"
});
setupContentManager({
  endpoint:"/api/admin/paver-designs",list:"#design-list",notice:"#design-notice",form:"#design-form",
  title:"#design-form-title",add:"#design-new",cancel:"#design-cancel",singular:"paver design",plural:"Paver designs",
  nameField:"name",requiredField:"name",summaryFields:["shape","dimensions","thickness","colour"],
  fields:["name","slug","shape","dimensions","thickness","colour","status","sort_order","supplier_note"],saveLabel:"Save design"
});


const testimonialList=document.querySelector("#testimonial-list");
const testimonialNotice=document.querySelector("#testimonial-notice");
const testimonialForm=document.querySelector("#testimonial-form");
const testimonialFields=testimonialForm.elements;
function showTestimonialForm(item) {
  testimonialForm.reset();
  testimonialFields.namedItem("id").value=item?.id || "";
  for(const name of ["customer_display_name","customer_role_or_company","testimonial_text","status","sort_order"]) {
    testimonialFields.namedItem(name).value=item?.[name] ?? (name==="status"?"draft":name==="sort_order"?0:"");
  }
  testimonialFields.namedItem("permission_confirmed").checked=Boolean(item?.permission_confirmed);
  document.querySelector("#testimonial-form-title").textContent=item?"Edit testimonial":"Add testimonial";
  testimonialForm.hidden=false;
  testimonialFields.namedItem("customer_display_name").focus();
}
function makeTestimonial(item) {
  const card=element("article","project-card");
  const head=element("div","project-head");
  const title=element("div");
  title.append(element("h3","",item.customer_display_name || "Unnamed customer"));
  if(item.customer_role_or_company)title.append(element("p","meta",item.customer_role_or_company));
  head.append(title,element("span","pill",labelStatus(item.status || "draft")));
  card.append(head,element("p","",item.testimonial_text || ""));
  card.append(element("p","meta",item.permission_confirmed?"Permission confirmed":"Permission not confirmed"));
  const edit=element("button","button secondary","Edit");edit.type="button";edit.addEventListener("click",()=>showTestimonialForm(item));
  const actions=element("div","content-actions");actions.append(edit);card.append(actions);
  return card;
}
async function loadTestimonials() {
  testimonialList.replaceChildren();testimonialNotice.className="notice";testimonialNotice.textContent="Loading testimonials…";
  try {
    const payload=await api("/api/admin/testimonials");
    const items=Array.isArray(payload.data)?payload.data:[];
    if(!items.length)testimonialList.append(element("div","empty","No testimonials yet."));
    else items.forEach(item=>testimonialList.append(makeTestimonial(item)));
    testimonialNotice.textContent=items.length+" testimonial record"+(items.length===1?"":"s")+" loaded.";
  } catch(error) {testimonialNotice.className="notice error";testimonialNotice.textContent=error.message;}
}
document.querySelector("#testimonial-new").addEventListener("click",()=>showTestimonialForm());
document.querySelector("#testimonial-cancel").addEventListener("click",()=>{testimonialForm.hidden=true;testimonialForm.reset();});
testimonialForm.addEventListener("submit",async event=>{
  event.preventDefault();
  const id=testimonialFields.namedItem("id").value;
  const body={
    customer_display_name:testimonialFields.namedItem("customer_display_name").value,
    customer_role_or_company:testimonialFields.namedItem("customer_role_or_company").value,
    testimonial_text:testimonialFields.namedItem("testimonial_text").value,
    permission_confirmed:testimonialFields.namedItem("permission_confirmed").checked,
    status:testimonialFields.namedItem("status").value,
    sort_order:Number(testimonialFields.namedItem("sort_order").value)
  };
  const save=testimonialForm.querySelector('button[type="submit"]');save.disabled=true;save.textContent="Saving…";
  try {
    await api(id?"/api/admin/testimonials/"+encodeURIComponent(id):"/api/admin/testimonials",{
      method:id?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    testimonialForm.hidden=true;testimonialNotice.className="notice";testimonialNotice.textContent="Testimonial saved.";
    await loadTestimonials();
  } catch(error) {testimonialNotice.className="notice error";testimonialNotice.textContent=error.message;}
  finally {save.disabled=false;save.textContent="Save testimonial";}
});

const homepageForm=document.querySelector("#homepage-form");
const homepageNotice=document.querySelector("#homepage-notice");
const homepageKeys=["hero_title","hero_subtitle","hero_cta_label","about_heading","about_text","experience_statement"];
async function loadHomepageContent() {
  try {
    const payload=await api("/api/admin/homepage-content");
    homepageKeys.forEach(key=>homepageForm.elements.namedItem(key).value=payload.data?.[key] || "");
    homepageNotice.textContent="Homepage content loaded.";
  } catch(error) {homepageNotice.className="notice error";homepageNotice.textContent=error.message;}
}
homepageForm.addEventListener("submit",async event=>{
  event.preventDefault();
  const body={};homepageKeys.forEach(key=>body[key]=homepageForm.elements.namedItem(key).value);
  const save=homepageForm.querySelector('button[type="submit"]');save.disabled=true;save.textContent="Saving…";
  try {
    await api("/api/admin/homepage-content",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    homepageNotice.className="notice";homepageNotice.textContent="Homepage content saved.";
  } catch(error) {homepageNotice.className="notice error";homepageNotice.textContent=error.message;}
  finally {save.disabled=false;save.textContent="Save homepage content";}
});
loadTestimonials();
loadHomepageContent();

load();
loadProjects();
`;


const ADMIN_CONTENT_TYPES = {
  services: {
    table: "services",
    entity: "service",
    fields: {
      title: { max: 160, required: true },
      slug: { max: 180, required: true, slug: true },
      short_description: { max: 2000, default: "" },
      description: { max: 10000, default: "" },
      status: { status: true, default: "draft" },
      sort_order: { number: true, default: 0 },
    },
    columns: ["id", "title", "slug", "short_description", "description", "status", "sort_order", "created_at", "updated_at"],
  },
  "paver-designs": {
    table: "paver_designs",
    entity: "paver_design",
    fields: {
      name: { max: 120, required: true },
      slug: { max: 160, required: true, slug: true },
      shape: { max: 120, nullable: true },
      dimensions: { max: 120, nullable: true },
      thickness: { max: 80, nullable: true },
      colour: { max: 80, nullable: true },
      supplier_note: { max: 500, nullable: true },
      status: { status: true, default: "draft" },
      sort_order: { number: true, default: 0 },
    },
    columns: ["id", "name", "slug", "shape", "dimensions", "thickness", "colour", "supplier_note", "status", "sort_order", "created_at", "updated_at"],
  },
};

function validateAdminContentInput(input, config, partial = false) {
  const keys = Object.keys(input);
  const allowed = Object.keys(config.fields);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) return null;
  const values = {};
  for (const key of keys) {
    const rule = config.fields[key];
    if (rule.number) {
      if (!Number.isInteger(input[key]) || input[key] < -100000 || input[key] > 100000) return null;
      values[key] = input[key];
      continue;
    }
    if (rule.status) {
      const value = cleanString(input[key], 20, true);
      if (!value || !["draft", "published", "archived"].includes(value)) return null;
      values[key] = value;
      continue;
    }
    const value = cleanString(input[key], rule.max, Boolean(rule.required));
    if (value === null || (rule.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))) return null;
    values[key] = value;
  }
  if (!partial) {
    for (const [key, rule] of Object.entries(config.fields)) {
      if (values[key] !== undefined) continue;
      if (rule.required) return null;
      values[key] = rule.default !== undefined ? rule.default : "";
    }
  }
  return values;
}


const HOMEPAGE_SETTING_KEYS = {
  hero_title: 120,
  hero_subtitle: 300,
  hero_cta_label: 60,
  about_heading: 120,
  about_text: 2000,
  experience_statement: 180,
};

async function handleAdminEditorial(request, env, url, identity) {
  if (url.pathname === "/api/admin/testimonials") {
    if (request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT id, customer_display_name, customer_role_or_company, testimonial_text, permission_confirmed, status, sort_order, created_at, updated_at FROM testimonials ORDER BY sort_order ASC, created_at DESC",
      ).all();
      return response(request, env, { data: result.results || [] });
    }
    if (request.method === "POST") {
      const parsed = await readJson(request);
      if (parsed.error) return response(request, env, { error: parsed.error }, 400);
      const input = parsed.value;
      const allowed = ["customer_display_name", "customer_role_or_company", "testimonial_text", "permission_confirmed", "status", "sort_order"];
      if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.includes(key))) {
        return response(request, env, { error: "Unexpected or missing testimonial fields." }, 400);
      }
      const name = cleanString(input.customer_display_name, 120, true);
      const role = cleanString(input.customer_role_or_company, 160);
      const quote = cleanString(input.testimonial_text, 2000, true);
      const permission = input.permission_confirmed;
      const status = input.status === undefined ? "draft" : cleanString(input.status, 20, true);
      const sortOrder = input.sort_order === undefined ? 0 : input.sort_order;
      if (!name || role === null || !quote || typeof permission !== "boolean" ||
          !["draft", "published", "archived"].includes(status) ||
          !Number.isInteger(sortOrder) || sortOrder < -100000 || sortOrder > 100000 ||
          (status === "published" && permission !== true)) {
        return response(request, env, { error: "Please confirm permission and check the testimonial fields." }, 400);
      }
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO testimonials (id, customer_display_name, customer_role_or_company, testimonial_text, permission_confirmed, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(id, name, role || null, quote, permission ? 1 : 0, status, sortOrder),
        env.DB.prepare(
          "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), identity.email, "create", "testimonial", id),
      ]);
      return response(request, env, { success: true, id }, 201);
    }
    return response(request, env, { error: "Not found." }, 404);
  }

  const testimonialMatch = url.pathname.match(/^\/api\/admin\/testimonials\/([0-9a-f-]{36})$/i);
  if (testimonialMatch && request.method === "PATCH") {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);
    const input = parsed.value;
    const allowed = ["customer_display_name", "customer_role_or_company", "testimonial_text", "permission_confirmed", "status", "sort_order"];
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !allowed.includes(key))) {
      return response(request, env, { error: "Unexpected or missing testimonial fields." }, 400);
    }
    const values = {};
    for (const key of keys) {
      const value = input[key];
      if (key === "permission_confirmed") {
        if (typeof value !== "boolean") return response(request, env, { error: "Permission confirmation must be true or false." }, 400);
        values[key] = value ? 1 : 0;
      } else if (key === "sort_order") {
        if (!Number.isInteger(value) || value < -100000 || value > 100000) return response(request, env, { error: "Invalid display order." }, 400);
        values[key] = value;
      } else {
        const limits = { customer_display_name: 120, customer_role_or_company: 160, testimonial_text: 2000, status: 20 };
        const cleaned = cleanString(value, limits[key], key === "customer_display_name" || key === "testimonial_text" || key === "status");
        if (cleaned === null || (key === "status" && !["draft", "published", "archived"].includes(cleaned))) {
          return response(request, env, { error: "Invalid testimonial field: " + key }, 400);
        }
        values[key] = cleaned;
      }
    }
    const id = testimonialMatch[1];
    const current = await env.DB.prepare(
      "SELECT permission_confirmed, status FROM testimonials WHERE id = ? LIMIT 1",
    ).bind(id).first();
    if (!current) return response(request, env, { error: "Testimonial not found." }, 404);
    const resultingPermission = values.permission_confirmed === undefined ? current.permission_confirmed : values.permission_confirmed;
    const resultingStatus = values.status === undefined ? current.status : values.status;
    if (resultingStatus === "published" && resultingPermission !== 1) {
      return response(request, env, { error: "A testimonial cannot be published without confirmed customer permission." }, 400);
    }
    const columns = Object.keys(values);
    const assignments = columns.map((column) => column + " = ?").join(", ");
    const bindings = columns.map((column) => column === "customer_role_or_company" && values[column] === "" ? null : values[column]);
    await env.DB.batch([
      env.DB.prepare("UPDATE testimonials SET " + assignments + ", updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(...bindings, id),
      env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "update", "testimonial", id),
    ]);
    return response(request, env, { success: true });
  }

  if (url.pathname === "/api/admin/homepage-content") {
    if (request.method === "GET") {
      const keys = Object.keys(HOMEPAGE_SETTING_KEYS);
      const result = await env.DB.prepare(
        "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN (" + keys.map(() => "?").join(", ") + ")",
      ).bind(...keys).all();
      const data = {};
      for (const key of keys) data[key] = "";
      for (const row of result.results || []) data[row.setting_key] = row.setting_value;
      return response(request, env, { data });
    }
    if (request.method === "PATCH") {
      const parsed = await readJson(request);
      if (parsed.error) return response(request, env, { error: parsed.error }, 400);
      const input = parsed.value;
      const keys = Object.keys(input);
      if (!keys.length || keys.some((key) => !Object.hasOwn(HOMEPAGE_SETTING_KEYS, key))) {
        return response(request, env, { error: "Only approved homepage content fields may be updated." }, 400);
      }
      const values = {};
      for (const key of keys) {
        const value = cleanString(input[key], HOMEPAGE_SETTING_KEYS[key]);
        if (value === null) return response(request, env, { error: "Invalid homepage content field: " + key }, 400);
        values[key] = value;
      }
      const statements = [];
      for (const [key, value] of Object.entries(values)) {
        statements.push(env.DB.prepare(
          "INSERT INTO site_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP",
        ).bind(key, value));
      }
      statements.push(env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "update", "homepage_content", null));
      await env.DB.batch(statements);
      return response(request, env, { success: true });
    }
    return response(request, env, { error: "Not found." }, 404);
  }
  return null;
}

async function handleAdminContent(request, env, url, identity) {
  const match = url.pathname.match(/^\/api\/admin\/(services|paver-designs)(?:\/([0-9a-f-]{36}))?$/i);
  if (!match) return null;
  const resource = match[1].toLowerCase();
  const id = match[2];
  const config = ADMIN_CONTENT_TYPES[resource];
  if (request.method === "GET" && !id) {
    const result = await env.DB.prepare(
      "SELECT " + config.columns.join(", ") + " FROM " + config.table + " ORDER BY sort_order ASC, created_at DESC",
    ).all();
    return response(request, env, { data: result.results || [] });
  }
  if (request.method === "POST" && !id) {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);
    const values = validateAdminContentInput(parsed.value, config, false);
    if (!values) return response(request, env, { error: "Please check the content fields and try again." }, 400);
    const recordId = crypto.randomUUID();
    const columns = ["id", ...Object.keys(config.fields)];
    const bindings = [recordId, ...Object.keys(config.fields).map((key) => {
      const rule = config.fields[key];
      return rule.nullable && values[key] === "" ? null : values[key];
    })];
    const placeholders = columns.map(() => "?").join(", ");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO " + config.table + " (" + columns.join(", ") + ") VALUES (" + placeholders + ")",
      ).bind(...bindings),
      env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "create", config.entity, recordId),
    ]);
    return response(request, env, { success: true, id: recordId }, 201);
  }
  if (request.method === "PATCH" && id) {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);
    const values = validateAdminContentInput(parsed.value, config, true);
    if (!values) return response(request, env, { error: "Please check the content fields and try again." }, 400);
    const current = await env.DB.prepare(
      "SELECT id FROM " + config.table + " WHERE id = ? LIMIT 1",
    ).bind(id).first();
    if (!current) return response(request, env, { error: "Content record not found." }, 404);
    const columns = Object.keys(values);
    const assignments = columns.map((column) => column + " = ?").join(", ");
    const bindings = columns.map((column) => {
      const rule = config.fields[column];
      return rule.nullable && values[column] === "" ? null : values[column];
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE " + config.table + " SET " + assignments + ", updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).bind(...bindings, id),
      env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "update", config.entity, id),
    ]);
    return response(request, env, { success: true });
  }
  return response(request, env, { error: "Not found." }, 404);
}

async function handleAdmin(request, env, url, identity) {
  const path = url.pathname;
  const contentResponse = await handleAdminContent(request, env, url, identity);
  if (contentResponse) return contentResponse;
  const editorialResponse = await handleAdminEditorial(request, env, url, identity);
  if (editorialResponse) return editorialResponse;

  if (request.method === "GET" && path === "/api/admin/projects") {
    const result = await env.DB.prepare(
      "SELECT id, title, slug, location, completed_on, summary, description, status, sort_order, created_at, updated_at FROM projects ORDER BY sort_order ASC, created_at DESC",
    ).all();
    return response(request, env, { data: result.results || [] });
  }

  if (request.method === "POST" && path === "/api/admin/projects") {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);
    const input = parsed.value;
    const allowed = ["title", "slug", "location", "completed_on", "summary", "description", "status", "sort_order"];
    if (Object.keys(input).length === 0 || Object.keys(input).some((key) => !allowed.includes(key))) {
      return response(request, env, { error: "Unexpected or missing project fields." }, 400);
    }

    const title = cleanString(input.title, 160, true);
    const slug = cleanString(input.slug, 180, true);
    const location = cleanString(input.location, 180);
    const completedOn = cleanString(input.completed_on, 10);
    const summary = cleanString(input.summary, 2000);
    const description = cleanString(input.description, 10000);
    const status = input.status === undefined ? "draft" : cleanString(input.status, 20, true);
    const sortOrder = input.sort_order === undefined ? 0 : input.sort_order;
    const validSlug = slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
    const validDate = isValidDateOnly(completedOn);
    if (!title || !validSlug || location === null || completedOn === null || !validDate ||
        summary === null || description === null ||
        !["draft", "published", "archived"].includes(status) ||
        !Number.isInteger(sortOrder) || sortOrder < -100000 || sortOrder > 100000) {
      return response(request, env, { error: "Please check the project fields and try again." }, 400);
    }

    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, title, slug, location, completed_on, summary, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, title, slug, location || null, completedOn || null, summary, description, status, sortOrder),
      env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "create", "project", id),
    ]);
    return response(request, env, { success: true, id }, 201);
  }

  const projectMatch = path.match(/^\/api\/admin\/projects\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && projectMatch) {
    const parsed = await readJson(request);
    if (parsed.error) return response(request, env, { error: parsed.error }, 400);
    const input = parsed.value;
    const allowed = ["title", "slug", "location", "completed_on", "summary", "description", "status", "sort_order"];
    const keys = Object.keys(input);
    if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) {
      return response(request, env, { error: "Unexpected or missing project fields." }, 400);
    }

    const values = {};
    for (const key of keys) {
      if (key === "sort_order") {
        if (!Number.isInteger(input[key]) || input[key] < -100000 || input[key] > 100000) {
          return response(request, env, { error: "Invalid project sort order." }, 400);
        }
        values[key] = input[key];
        continue;
      }
      const limits = { title: 160, slug: 180, location: 180, completed_on: 10, summary: 2000, description: 10000, status: 20 };
      const value = cleanString(input[key], limits[key], key === "title" || key === "slug" || key === "status");
      if (value === null ||
          (key === "slug" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) ||
          (key === "status" && !["draft", "published", "archived"].includes(value)) ||
          (key === "completed_on" && !isValidDateOnly(value))) {
        return response(request, env, { error: "Invalid project field: " + key }, 400);
      }
      values[key] = value;
    }

    const current = await env.DB.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1")
      .bind(projectMatch[1]).first();
    if (!current) return response(request, env, { error: "Project not found." }, 404);

    const columns = Object.keys(values);
    const assignments = columns.map((column) => column + " = ?").join(", ");
    const nullableColumns = new Set(["location", "completed_on"]);
    const bindings = columns.map((column) => nullableColumns.has(column) && values[column] === "" ? null : values[column]);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE projects SET " + assignments + ", updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).bind(...bindings, projectMatch[1]),
      env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "update", "project", projectMatch[1]),
    ]);
    return response(request, env, { success: true });
  }

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

    const status = input.status === undefined ? null : cleanString(input.status, 20, true);
    const notes = input.internal_notes === undefined ? null : cleanString(input.internal_notes, 4000);
    if ((input.status !== undefined && (!status || !VALID_INQUIRY_STATUSES.has(status))) ||
        (input.internal_notes !== undefined && notes === null)) {
      return response(request, env, { error: "Invalid inquiry update." }, 400);
    }

    const current = await env.DB.prepare("SELECT id FROM inquiries WHERE id = ? LIMIT 1")
      .bind(inquiryMatch[1]).first();
    if (!current) return response(request, env, { error: "Inquiry not found." }, 404);

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE inquiries SET status = COALESCE(?, status), internal_notes = COALESCE(?, internal_notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).bind(status, notes, inquiryMatch[1]),
      env.DB.prepare(
        "INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), identity.email, "update", "inquiry", inquiryMatch[1]),
    ]);

    return response(request, env, { success: true });
  }

  return response(request, env, { error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin === url.origin) {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
            "access-control-allow-headers": "Content-Type",
            "access-control-max-age": "600",
          },
        });
      }
      const headers = corsHeaders(request, env);
      if (!headers["access-control-allow-origin"]) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return response(request, env, { ok: true });
    }

    const requestOrigin = request.headers.get("Origin");
    const allowedOrigin = corsHeaders(request, env);
    const isSameOrigin = requestOrigin === url.origin;
    if (requestOrigin && !isSameOrigin && !allowedOrigin["access-control-allow-origin"]) {
      return json({ error: "Origin not allowed." }, 403);
    }

    try {
      if (url.pathname.startsWith("/api/public/")) {
        if (request.method !== "GET" && request.method !== "POST") {
          return response(request, env, { error: "Method not allowed." }, 405, { allow: "GET, POST" });
        }
        return await handlePublic(request, env, url);
      }

      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        if (request.method !== "GET") return response(request, env, { error: "Method not allowed." }, 405);
        const identity = await verifyAccessIdentity(request, env);
        if (!identity) return response(request, env, { error: "Unauthorized." }, 401);
        const publicSiteUrl = (() => {
          try {
            const configured = new URL(env.SITE_ORIGIN);
            return configured.protocol === "https:" || configured.protocol === "http:" ? configured.origin : "";
          } catch {
            return "";
          }
        })();
        const dashboardHtml = publicSiteUrl
          ? ADMIN_HTML.replace('href="/" rel="noopener"', 'href="' + publicSiteUrl + '" rel="noopener noreferrer"')
          : ADMIN_HTML.replace('<a class="public-link" href="/" rel="noopener">Public website ↗</a>', "");
        return new Response(dashboardHtml, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          },
        });
      }

      if (url.pathname === "/admin/assets/admin.css" || url.pathname === "/admin/assets/admin.js") {
        if (request.method !== "GET") return response(request, env, { error: "Method not allowed." }, 405);
        const identity = await verifyAccessIdentity(request, env);
        if (!identity) return response(request, env, { error: "Unauthorized." }, 401);
        const isCss = url.pathname.endsWith(".css");
        return new Response(isCss ? ADMIN_CSS : ADMIN_JS, {
          headers: {
            "content-type": isCss ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'",
          },
        });
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const identity = await verifyAccessIdentity(request, env);
        if (!identity) return response(request, env, { error: "Unauthorized." }, 401);
        if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH") {
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