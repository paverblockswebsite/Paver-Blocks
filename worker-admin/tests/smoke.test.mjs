import test from "node:test";
import assert from "node:assert/strict";
import gateway from "../src/index.js";

function env(overrides = {}) {
  return {
    API_ORIGIN: "https://paver-blocks-api-dev.hellopaverblocks.workers.dev",
    ...overrides,
  };
}

test("gateway rejects public API and arbitrary paths without proxying", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("unexpected"); };
  try {
    for (const path of ["/health", "/api/public/inquiries", "/anything"]) {
      const response = await gateway.fetch(new Request("https://admin.example" + path), env());
      assert.equal(response.status, 404);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway requires the Cloudflare Access assertion", async () => {
  const response = await gateway.fetch(
    new Request("https://admin.example/admin"),
    env(),
  );
  assert.equal(response.status, 401);
});

test("gateway forwards only admin paths and preserves the signed assertion", async () => {
  const originalFetch = globalThis.fetch;
  const assertion = "signed-access-jwt-placeholder";
  let upstreamRequest;
  globalThis.fetch = async (request) => {
    upstreamRequest = request;
    return new Response("admin response", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  try {
    const response = await gateway.fetch(
      new Request("https://admin.example/api/admin/inquiries?limit=10", {
        method: "PATCH",
        headers: {
          "Cf-Access-Jwt-Assertion": assertion,
          Cookie: "CF_Authorization=browser-session",
          Origin: "https://admin.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "contacted" }),
      }),
      env(),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "admin response");
    assert.equal(upstreamRequest.url, "https://paver-blocks-api-dev.hellopaverblocks.workers.dev/api/admin/inquiries?limit=10");
    assert.equal(upstreamRequest.method, "PATCH");
    assert.equal(upstreamRequest.headers.get("Cf-Access-Jwt-Assertion"), assertion);
    assert.equal(upstreamRequest.headers.get("Cookie"), null);
    assert.equal(upstreamRequest.headers.get("Origin"), "https://paver-blocks-api-dev.hellopaverblocks.workers.dev");
    assert.equal(upstreamRequest.headers.get("Sec-Fetch-Site"), "same-origin");
    assert.deepEqual(await upstreamRequest.json(), { status: "contacted" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway fails closed for insecure or non-development upstream origins", async () => {
  for (const origin of [
    "http://untrusted.example",
    "https://paver-blocks-api.example.com",
    "https://paver-blocks-api-prod.hellopaverblocks.workers.dev",
  ]) {
    const response = await gateway.fetch(
      new Request("https://admin.example/admin", {
        headers: { "Cf-Access-Jwt-Assertion": "signed-access-jwt-placeholder" },
      }),
      env({ API_ORIGIN: origin }),
    );
    assert.equal(response.status, 503, origin);
  }
});
