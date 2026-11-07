import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeEnv(overrides = {}) {
  return {
    SITE_ORIGIN: "https://development-site.example",
    DB: {
      prepare(sql) {
        return {
          async all() {
            assert.match(sql, /status = 'published'/);
            return {
              results: [
                { id: "service-1", title: "Paver block installation", slug: "paver-block-installation" },
              ],
            };
          },
        };
      },
    },
    ...overrides,
  };
}

test("health endpoint responds without database access", async () => {
  const response = await worker.fetch(new Request("https://api.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("public services endpoint returns published data with allowed CORS origin", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/public/services", {
      headers: { Origin: "https://development-site.example" },
    }),
    makeEnv(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://development-site.example");
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].slug, "paver-block-installation");
});

test("requests from an unapproved origin are rejected", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/public/services", {
      headers: { Origin: "https://untrusted.example" },
    }),
    makeEnv(),
  );
  assert.equal(response.status, 403);
});

test("admin inquiry endpoint denies requests without a verified Access identity", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/admin/inquiries", {
      headers: { Origin: "https://development-site.example" },
    }),
    makeEnv(),
  );
  assert.equal(response.status, 401);
});

test("inquiry submission rejects a non-JSON content type", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "Content-Type": "text/plain",
      },
      body: "not-json",
    }),
    makeEnv(),
  );
  assert.equal(response.status, 400);
});
