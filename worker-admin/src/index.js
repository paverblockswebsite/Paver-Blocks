const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

function isAllowedAdminPath(pathname) {
  return pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/api/admin/");
}

const DEVELOPMENT_API_ORIGIN = "https://paver-blocks-api-dev.hellopaverblocks.workers.dev";

function getApiOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash ||
        url.origin !== DEVELOPMENT_API_ORIGIN) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    // This dedicated hostname is admin-only. Never proxy public API or
    // arbitrary paths through this gateway.
    if (!isAllowedAdminPath(incoming.pathname)) {
      return jsonError("Not found.", 404);
    }

    if (!["GET", "POST", "PATCH", "DELETE", "HEAD"].includes(request.method)) {
      return jsonError("Method not allowed.", 405);
    }

    // Cloudflare Access must authenticate the browser at this hostname.
    // The downstream API independently validates the signed JWT and email.
    const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!accessJwt || accessJwt.length > 8192) {
      return jsonError("Unauthorized.", 401);
    }

    const apiOrigin = getApiOrigin(env.API_ORIGIN);
    if (!apiOrigin) return jsonError("Admin service is not configured.", 503);

    const target = new URL(incoming.pathname + incoming.search, apiOrigin);
    const headers = new Headers(request.headers);

    // Do not forward the browser's Access cookie to the API hostname.
    // Forward only the signed assertion; the API verifies its signature,
    // issuer, audience, expiry, and allowlisted administrator email.
    headers.delete("cookie");
    headers.set("Cf-Access-Jwt-Assertion", accessJwt);

    // The API's same-origin CSRF guard must evaluate the gateway's internal
    // same-origin request, not the browser-facing admin hostname.
    headers.set("Origin", apiOrigin);
    headers.set("Sec-Fetch-Site", "same-origin");

    let upstream;
    try {
      const init = {
        method: request.method,
        headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
        // Node's Fetch implementation requires duplex for streamed bodies.
        // Cloudflare Workers accepts this RequestInit member as well.
        init.duplex = "half";
      }
      upstream = await fetch(new Request(target, init));
    } catch {
      return jsonError("The admin service is temporarily unavailable.", 502);
    }

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("pragma", "no-cache");
    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("referrer-policy", "no-referrer");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
