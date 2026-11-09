const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}
function isAllowedAdminPath(pathname) {
  return pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/");
}
const ALLOWED_API_ORIGINS = new Set([
  "https://paver-blocks-api-dev.hellopaverblocks.workers.dev",
  "https://paver-blocks-api.hellopaverblocks.workers.dev",
]);
function getApiOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || !ALLOWED_API_ORIGINS.has(url.origin)) return null;
    return url.origin;
  } catch { return null; }
}
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (!isAllowedAdminPath(incoming.pathname)) return jsonError("Not found.", 404);
    if (!["GET", "POST", "PATCH", "DELETE", "HEAD"].includes(request.method)) return jsonError("Method not allowed.", 405);
    const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!accessJwt || accessJwt.length > 8192) return jsonError("Unauthorized.", 401);
    const apiOrigin = getApiOrigin(env.API_ORIGIN);
    if (!apiOrigin) return jsonError("Admin service is not configured.", 503);
    const target = new URL(incoming.pathname + incoming.search, apiOrigin);
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.set("Cf-Access-Jwt-Assertion", accessJwt);
    headers.set("Origin", apiOrigin);
    headers.set("Sec-Fetch-Site", "same-origin");
    let upstream;
    try {
      const init = { method: request.method, headers, redirect: "manual" };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
        init.duplex = "half";
      }
      const upstreamRequest = new Request(target, init);
      upstream = env.API && typeof env.API.fetch === "function"
        ? await env.API.fetch(upstreamRequest)
        : await fetch(upstreamRequest);
    } catch {
      return jsonError("The admin service is temporarily unavailable.", 502);
    }
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("pragma", "no-cache");
    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("referrer-policy", "no-referrer");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  },
};
