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

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { error: "Content-Type must be application/json." };
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
.notice{min-height:26px;color:var(--muted)}.notice.error{color:#a12626}.inquiry-list{display:grid;gap:14px}.inquiry{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 2px 8px #172b4508}.inquiry-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.inquiry h2{font-size:1.12rem;color:var(--navy);margin:0 0 4px}.meta{color:var(--muted);font-size:.9rem}.pill{font-size:.75rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border-radius:30px;padding:5px 9px;background:#edf1f5;color:#43546a;white-space:nowrap}.details{white-space:pre-wrap;overflow-wrap:anywhere;margin:14px 0}.facts{display:flex;gap:10px 18px;flex-wrap:wrap;font-size:.9rem;color:#48576a}.editor{border-top:1px solid var(--line);margin-top:16px;padding-top:16px;display:grid;grid-template-columns:minmax(140px,220px) 1fr auto;gap:10px;align-items:end}.editor label{display:grid;gap:5px;font-size:.85rem;font-weight:650}.editor textarea{min-height:42px;resize:vertical}.empty{background:#fff;border:1px dashed #bdc7d3;border-radius:14px;padding:30px;text-align:center;color:var(--muted)}.footnote{font-size:.82rem;margin-top:34px}
@media(max-width:650px){.shell{padding-top:28px}.editor{grid-template-columns:1fr}.inquiry-head{align-items:flex-start}.topbar{padding:0 16px}}
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
load();
`;

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