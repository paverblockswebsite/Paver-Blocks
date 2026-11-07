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


test("public inquiry endpoint rejects missing Turnstile configuration without writing to D1", async () => {
  let writes = 0;
  const env = makeEnv({
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async run() { writes += 1; },
            };
          },
        };
      },
    },
  });
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer_name: "Test Customer",
        phone: "+923000000000",
        location: "Hyderabad",
        work_type: "Paver block installation",
        project_details: "Test enquiry",
        turnstile_token: "test-token",
      }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(writes, 0);
});

test("public API does not expose inquiry records through a read route", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      headers: { Origin: "https://development-site.example" },
    }),
    makeEnv(),
  );
  assert.equal(response.status, 404);
});

test("inquiry submission rejects unexpected fields before database access", async () => {
  let databaseTouched = false;
  const env = makeEnv({
    DB: {
      prepare() {
        databaseTouched = true;
        throw new Error("Database should not be queried for invalid input.");
      },
    },
  });
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customer_name: "Test", unexpected: "not allowed" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(databaseTouched, false);
});


test("inquiry submission rejects malformed JSON without database access", async () => {
  let databaseTouched = false;
  const env = makeEnv({
    DB: {
      prepare() {
        databaseTouched = true;
        throw new Error("Database must not be touched for malformed JSON.");
      },
    },
  });
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "Content-Type": "application/json",
      },
      body: "{invalid-json",
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(databaseTouched, false);
});

test("inquiry submission rejects oversized bodies without database access", async () => {
  let databaseTouched = false;
  const env = makeEnv({
    DB: {
      prepare() {
        databaseTouched = true;
        throw new Error("Database must not be touched for oversized input.");
      },
    },
  });
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project_details: "x".repeat(17000) }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(databaseTouched, false);
});

test("admin inquiry updates reject requests without a verified Access identity", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/admin/inquiries/123e4567-e89b-12d3-a456-426614174000", {
      method: "PATCH",
      headers: {
        Origin: "https://development-site.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "quoted" }),
    }),
    makeEnv(),
  );
  assert.equal(response.status, 401);
});
