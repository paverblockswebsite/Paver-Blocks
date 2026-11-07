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

test("Cloudflare Access admin identity validates signature, issuer, audience, expiry, and email allowlist", async () => {
  const originalFetch = globalThis.fetch;
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  jwk.kid = "test-access-key";
  const teamDomain = "paverblocks.cloudflareaccess.com";
  const now = Math.floor(Date.now() / 1000);

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  async function makeToken(overrides = {}, corruptSignature = false) {
    const header = encode({ alg: "RS256", typ: "JWT", kid: jwk.kid });
    const claims = encode({
      iss: "https://" + teamDomain,
      aud: ["test-access-audience"],
      sub: "test-user-subject",
      email: "hellopaverblocks@gmail.com",
      exp: now + 300,
      nbf: now - 10,
      ...overrides,
    });
    const content = header + "." + claims;
    const signature = Buffer.from(await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(content),
    )).toString("base64url");
    if (!corruptSignature) return content + "." + signature;
    const replacement = signature[0] === "A" ? "B" : "A";
    return content + "." + replacement + signature.slice(1);
  }

  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://" + teamDomain + "/cdn-cgi/access/certs");
    assert.ok(options.signal instanceof AbortSignal, "Access signing-key fetch must have a timeout signal");
    return Response.json({ keys: [jwk] });
  };

  const dbBatches = [];
  const preparedStatements = [];
  const env = makeEnv({
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: "test-access-audience",
    ADMIN_EMAILS: "hellopaverblocks@gmail.com",
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) { statement.values = values; return statement; },
          async all() { return { results: [] }; },
          async first() { return { id: "123e4567-e89b-12d3-a456-426614174000" }; },
          async run() { return { success: true }; },
        };
        preparedStatements.push(statement);
        return statement;
      },
      async batch(statements) {
        dbBatches.push(statements.map((statement) => ({ sql: statement.sql, values: statement.values })));
        return [];
      },
    },
  });

  async function requestWithToken(token, path = "/api/admin/inquiries", init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Cf-Access-Jwt-Assertion", token);
    return worker.fetch(
      new Request("https://api.example" + path, { ...init, headers }),
      env,
    );
  }

  try {
    const validToken = await makeToken();
    const validResponse = await requestWithToken(validToken);
    assert.equal(validResponse.status, 200, "a valid, allowlisted Access identity should be accepted");
    assert.deepEqual(await validResponse.json(), { data: [], limit: 50, offset: 0 });

    const dashboardResponse = await requestWithToken(validToken, "/admin");
    assert.equal(dashboardResponse.status, 200, "an allowlisted admin should receive the dashboard");
    assert.match(dashboardResponse.headers.get("content-type") || "", /text\/html/);
    assert.equal(dashboardResponse.headers.get("cache-control"), "no-store");
    assert.match(dashboardResponse.headers.get("content-security-policy") || "", /default-src 'none'/);
    const dashboardHtml = await dashboardResponse.text();
    assert.match(dashboardHtml, /\/admin\/assets\/admin\.js/);
    assert.match(dashboardHtml, /\/admin\/assets\/admin\.css/);
    assert.match(dashboardHtml, /id="project-form"/);
    assert.match(dashboardHtml, /name="completed_on"/);
    assert.match(dashboardHtml, /https:\/\/development-site\.example/);
    assert.doesNotMatch(dashboardHtml, /href="\/" rel="noopener"/);

    for (const [path, contentType] of [
      ["/admin/assets/admin.js", /javascript/],
      ["/admin/assets/admin.css", /text\/css/],
    ]) {
      const assetResponse = await requestWithToken(validToken, path);
      assert.equal(assetResponse.status, 200, path + " should be available to an allowlisted admin");
      assert.match(assetResponse.headers.get("content-type") || "", contentType);
      assert.equal(assetResponse.headers.get("cache-control"), "no-store");
      const assetText = await assetResponse.text();
      assert.ok(assetText.length > 0);
      if (path.endsWith(".js")) {
        assert.match(assetText, /api\/admin\/projects/);
        assert.match(assetText, /method:id\?"PATCH":"POST"/);
      }
    }

    const patchUrl = "/api/admin/inquiries/123e4567-e89b-12d3-a456-426614174000";
    const invalidPatch = await worker.fetch(new Request("https://api.example" + patchUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": validToken },
      body: JSON.stringify({ status: "invented", private_field: "not allowed" }),
    }), env);
    assert.equal(invalidPatch.status, 400);
    assert.equal(dbBatches.length, 0, "invalid updates must not reach the database batch");

    const successfulPatch = await worker.fetch(new Request("https://api.example" + patchUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": validToken },
      body: JSON.stringify({ status: "quoted", internal_notes: "Called customer" }),
    }), env);
    assert.equal(successfulPatch.status, 200);
    assert.deepEqual(await successfulPatch.json(), { success: true });
    assert.equal(dbBatches.length, 1, "the inquiry update and audit event should be submitted together");
    assert.equal(dbBatches[0].length, 2);
    assert.match(dbBatches[0][0].sql, /^UPDATE inquiries SET/);
    assert.deepEqual(dbBatches[0][0].values.slice(0, 2), ["quoted", "Called customer"]);
    assert.match(dbBatches[0][1].sql, /^INSERT INTO admin_audit_log/);
    assert.equal(dbBatches[0][1].values[1], "hellopaverblocks@gmail.com");

    const projectList = await requestWithToken(validToken, "/api/admin/projects");
    assert.equal(projectList.status, 200, "an authorized admin can list project drafts");
    assert.deepEqual((await projectList.json()).data, []);

    const projectCreate = await requestWithToken(validToken, "/api/admin/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Hyderabad Footpath Project",
        slug: "hyderabad-footpath-project",
        location: "Hyderabad, Sindh",
        completed_on: "2026-10-15",
        summary: "Footpath paving work",
        description: "Installation of paving blocks.",
        status: "draft",
        sort_order: 10,
      }),
    });
    assert.equal(projectCreate.status, 201, "a valid project is created as draft by default/explicit draft");
    assert.equal(dbBatches.at(-1).length, 2, "project creation and audit event are atomic");
    assert.match(dbBatches.at(-1)[0].sql, /^INSERT INTO projects/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    assert.equal(dbBatches.at(-1)[1].values[1], "hellopaverblocks@gmail.com");

    const projectUpdate = await requestWithToken(validToken, "/api/admin/projects/123e4567-e89b-12d3-a456-426614174000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published", summary: "Approved summary" }),
    });
    assert.equal(projectUpdate.status, 200, "an authorized admin can update a project");
    assert.match(dbBatches.at(-1)[0].sql, /^UPDATE projects SET/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);

    const batchesBeforeInvalidProject = dbBatches.length;
    const invalidProject = await requestWithToken(validToken, "/api/admin/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Invalid project", slug: "../unsafe", unexpected: "field" }),
    });
    assert.equal(invalidProject.status, 400, "unexpected fields and unsafe slugs are rejected");
    assert.equal(dbBatches.length, batchesBeforeInvalidProject, "invalid project input must not write to D1");

    const invalidCalendarDate = await requestWithToken(validToken, "/api/admin/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Invalid date", slug: "invalid-date", completed_on: "2026-02-31" }),
    });
    assert.equal(invalidCalendarDate.status, 400, "impossible calendar dates are rejected");
    assert.equal(dbBatches.length, batchesBeforeInvalidProject, "invalid dates must not write to D1");

    const wrongEmail = await requestWithToken(await makeToken({ email: "someone-else@example.com" }));
    assert.equal(wrongEmail.status, 401, "an email outside the allowlist must be rejected");

    const wrongAudience = await requestWithToken(await makeToken({ aud: ["another-audience"] }));
    assert.equal(wrongAudience.status, 401, "a token for another Access application must be rejected");

    const expired = await requestWithToken(await makeToken({ exp: now - 1 }));
    assert.equal(expired.status, 401, "an expired token must be rejected");

    const wrongIssuer = await requestWithToken(await makeToken({ iss: "https://attacker.example" }));
    assert.equal(wrongIssuer.status, 401, "a token from another issuer must be rejected");

    const invalidSignature = await requestWithToken(await makeToken({}, true));
    assert.equal(invalidSignature.status, 401, "a token with an invalid signature must be rejected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("same-origin admin requests reach Access authentication instead of being rejected by the public-site CORS rule", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/admin/inquiries", {
      headers: { Origin: "https://api.example" },
    }),
    makeEnv({ SITE_ORIGIN: "https://public-site.example" }),
  );
  assert.equal(response.status, 401);
});

test("admin requests from an unrelated origin are rejected", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/admin/inquiries", {
      headers: { Origin: "https://untrusted.example" },
    }),
    makeEnv({ SITE_ORIGIN: "https://public-site.example" }),
  );
  assert.equal(response.status, 403);
});


test("admin dashboard HTML is not served without a verified Cloudflare Access identity", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/admin"),
    makeEnv(),
  );
  assert.equal(response.status, 401);
  assert.ok((response.headers.get("content-type") || "").includes("application/json"));
});

test("admin JavaScript and CSS assets are also protected by Access verification", async () => {
  for (const path of ["/admin/assets/admin.js", "/admin/assets/admin.css"]) {
    const response = await worker.fetch(
      new Request("https://api.example" + path),
      makeEnv(),
    );
    assert.equal(response.status, 401, path + " must not be publicly readable");
  }
});

test("admin dashboard rejects non-GET methods", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/admin", { method: "POST" }),
    makeEnv(),
  );
  assert.equal(response.status, 405);
});
