import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { uploadProjectImage, serveProjectImage, deleteProjectImage, reorderProjectImages } from "../src/project-images.js";

function makeEnv(overrides = {}) {
  return {
    SITE_ORIGIN: "https://development-site.example",
    INQUIRY_RATE_LIMITER: { async limit() { return { success: true }; } },
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
      headers: { Origin: "https://api.example" },
    }),
    makeEnv(),
  );
  assert.equal(response.status, 401);
});

test("inquiry submission is blocked when the rate limit is exceeded before parsing or database access", async () => {
  let databaseTouched = false;
  let rateLimitKey = "";
  const env = makeEnv({
    INQUIRY_RATE_LIMITER: {
      async limit({ key }) { rateLimitKey = key; return { success: false }; },
    },
    DB: {
      prepare() { databaseTouched = true; throw new Error("Database must not be touched."); },
    },
  });
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "text/plain",
      },
      body: "invalid body",
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(rateLimitKey, "public-inquiry:203.0.113.10");
  assert.equal(databaseTouched, false);
});

test("inquiry submission fails closed when the rate limiter binding is unavailable", async () => {
  let databaseTouched = false;
  const env = makeEnv({
    INQUIRY_RATE_LIMITER: undefined,
    DB: { prepare() { databaseTouched = true; throw new Error("Database must not be touched."); } },
  });
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://development-site.example",
        "CF-Connecting-IP": "203.0.113.11",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ customer_name: "Test" }),
    }),
    env,
  );
  assert.equal(response.status, 503);
  assert.equal(databaseTouched, false);
});

test("inquiry submission rejects a non-JSON content type", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "POST",
      headers: {
        Origin: "https://api.example",
        "CF-Connecting-IP": "203.0.113.20",
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
        Origin: "https://api.example",
        "CF-Connecting-IP": "203.0.113.20",
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

test("inquiry submission stops reading oversized streamed bodies before database access", async () => {
  let databaseTouched = false;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(17000)));
    },
    cancel() {
      cancelled = true;
    },
  });
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
        "CF-Connecting-IP": "203.0.113.20",
        "Content-Type": "application/json",
      },
      body,
      duplex: "half",
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Request is too large." });
  assert.equal(databaseTouched, false);
  assert.equal(cancelled, true);
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
        "CF-Connecting-IP": "203.0.113.20",
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
        "CF-Connecting-IP": "203.0.113.20",
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
        "CF-Connecting-IP": "203.0.113.20",
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
        Origin: "https://api.example",
        "CF-Connecting-IP": "203.0.113.20",
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
  let projectImageCount = 0;
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
          async first() {
            if (sql.includes("COUNT(*) AS image_count")) return { image_count: projectImageCount };
            return sql.includes("permission_confirmed, status FROM testimonials") ? { permission_confirmed: 0, status: "draft" } : { id: "123e4567-e89b-12d3-a456-426614174000" };
          },
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
    if (["POST", "PATCH", "DELETE"].includes(init.method) && !headers.has("Origin")) {
      headers.set("Origin", "https://api.example");
    }
    return worker.fetch(
      new Request("https://api.example" + path, { ...init, headers }),
      env,
    );
  }

  try {
    const validToken = await makeToken();
    const validResponse = await requestWithToken(validToken);
    assert.equal(validResponse.status, 200, "a valid, allowlisted Access identity should be accepted");
    assert.equal(validResponse.headers.get("cache-control"), "no-store", "private inquiry responses must not be cached");
    assert.equal(validResponse.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await validResponse.json(), { data: [], limit: 50, offset: 0 });

    const pagedInquiryResponse = await requestWithToken(
      validToken,
      "/api/admin/inquiries?limit=20&offset=40",
    );
    assert.equal(pagedInquiryResponse.status, 200);
    assert.deepEqual(await pagedInquiryResponse.json(), { data: [], limit: 20, offset: 40 });
    const pagedQuery = preparedStatements.at(-1);
    assert.match(pagedQuery.sql, /ORDER BY created_at DESC LIMIT \? OFFSET \?$/);
    assert.deepEqual(pagedQuery.values, [20, 40]);

    const missingOriginMutation = await worker.fetch(new Request(
      "https://api.example/api/admin/projects",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": validToken },
        body: JSON.stringify({ title: "CSRF probe", slug: "csrf-probe" }),
      },
    ), env);
    assert.equal(missingOriginMutation.status, 403, "admin mutations without an Origin must be rejected");

    const publicOriginMutation = await worker.fetch(new Request(
      "https://api.example/api/admin/projects",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": validToken,
          Origin: "https://development-site.example",
        },
        body: JSON.stringify({ title: "CSRF probe", slug: "csrf-probe" }),
      },
    ), env);
    assert.equal(publicOriginMutation.status, 403, "admin mutations from the public site origin must be rejected");

    const crossSiteMetadataMutation = await worker.fetch(new Request(
      "https://api.example/api/admin/projects",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": validToken,
          Origin: "https://api.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ title: "CSRF probe", slug: "csrf-probe" }),
      },
    ), env);
    assert.equal(crossSiteMetadataMutation.status, 403, "cross-site Fetch Metadata must be rejected");
    assert.equal(dbBatches.length, 0, "rejected CSRF probes must not write to D1");

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
    assert.match(dashboardHtml, /id="service-form"/);
    assert.match(dashboardHtml, /id="design-form"/);
    assert.match(dashboardHtml, /id="testimonial-form"/);
    assert.match(dashboardHtml, /id="homepage-form"/);
    assert.match(dashboardHtml, /id="load-more-inquiries"/);
    assert.match(dashboardHtml, /permission_confirmed/);
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
        assert.match(assetText, /api\/admin\/services/);
        assert.match(assetText, /api\/admin\/paver-designs/);
        assert.match(assetText, /api\/admin\/testimonials/);
        assert.match(assetText, /api\/admin\/homepage-content/);
        assert.match(assetText, /method:id\?"PATCH":"POST"/);
        assert.match(assetText, /method:"DELETE"/);
        assert.match(assetText, /limit:String\(inquiryPageSize\),offset:String\(offset\)/);
      }
    }

    const patchUrl = "/api/admin/inquiries/123e4567-e89b-12d3-a456-426614174000";
    const invalidPatch = await worker.fetch(new Request("https://api.example" + patchUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": validToken, Origin: "https://api.example" },
      body: JSON.stringify({ status: "invented", private_field: "not allowed" }),
    }), env);
    assert.equal(invalidPatch.status, 400);
    assert.equal(dbBatches.length, 0, "invalid updates must not reach the database batch");

    const successfulPatch = await worker.fetch(new Request("https://api.example" + patchUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": validToken, Origin: "https://api.example" },
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

    const beforeBlockedProjectDelete = dbBatches.length;
    projectImageCount = 1;
    const blockedProjectDelete = await requestWithToken(validToken, "/api/admin/projects/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" });
    assert.equal(blockedProjectDelete.status, 409, "projects with stored photos cannot be deleted");
    assert.equal(dbBatches.length, beforeBlockedProjectDelete, "blocked project deletion must not write to D1");
    projectImageCount = 0;
    const projectDelete = await requestWithToken(validToken, "/api/admin/projects/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" });
    assert.equal(projectDelete.status, 200, "a project without photos can be deleted");
    assert.match(dbBatches.at(-1)[0].sql, /^DELETE FROM projects/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    assert.equal(dbBatches.at(-1)[1].values[2], "delete");

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


    const servicesBefore = dbBatches.length;
    const serviceList = await requestWithToken(validToken, "/api/admin/services");
    assert.equal(serviceList.status, 200);
    assert.deepEqual((await serviceList.json()).data, []);
    const serviceCreate = await requestWithToken(validToken, "/api/admin/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Road construction",
        slug: "road-construction",
        short_description: "Road construction services",
        description: "Construction and related paving work.",
        status: "draft",
        sort_order: 5,
      }),
    });
    assert.equal(serviceCreate.status, 201);
    assert.equal(dbBatches.at(-1).length, 2, "service create and audit are atomic");
    assert.match(dbBatches.at(-1)[0].sql, /^INSERT INTO services/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    const serviceUpdate = await requestWithToken(validToken, "/api/admin/services/123e4567-e89b-12d3-a456-426614174000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published", short_description: "Updated description" }),
    });
    assert.equal(serviceUpdate.status, 200);
    assert.match(dbBatches.at(-1)[0].sql, /^UPDATE services SET/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    const serviceDelete = await requestWithToken(validToken, "/api/admin/services/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" });
    assert.equal(serviceDelete.status, 200);
    assert.match(dbBatches.at(-1)[0].sql, /^DELETE FROM services/);
    assert.equal(dbBatches.at(-1)[1].values[2], "delete");

    const designList = await requestWithToken(validToken, "/api/admin/paver-designs");
    assert.equal(designList.status, 200);
    assert.deepEqual((await designList.json()).data, []);
    const designCreate = await requestWithToken(validToken, "/api/admin/paver-designs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "I-shape paver",
        slug: "i-shape-paver",
        shape: "I-shape",
        dimensions: "Supplier to confirm",
        thickness: "Supplier to confirm",
        colour: "Grey",
        supplier_note: "Confirm stock before quoting.",
      }),
    });
    assert.equal(designCreate.status, 201, "paver design defaults to draft");
    assert.equal(dbBatches.at(-1).length, 2, "design create and audit are atomic");
    assert.match(dbBatches.at(-1)[0].sql, /^INSERT INTO paver_designs/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    const designUpdate = await requestWithToken(validToken, "/api/admin/paver-designs/123e4567-e89b-12d3-a456-426614174000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colour: "Red", status: "published" }),
    });
    assert.equal(designUpdate.status, 200);
    assert.match(dbBatches.at(-1)[0].sql, /^UPDATE paver_designs SET/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    const designDelete = await requestWithToken(validToken, "/api/admin/paver-designs/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" });
    assert.equal(designDelete.status, 200);
    assert.match(dbBatches.at(-1)[0].sql, /^DELETE FROM paver_designs/);
    assert.equal(dbBatches.at(-1)[1].values[2], "delete");

    const beforeInvalidContent = dbBatches.length;
    for (const [path, body] of [
      ["/api/admin/services", { title: "Unsafe", slug: "../unsafe" }],
      ["/api/admin/services", { title: "Unknown", slug: "unknown", extra: "nope" }],
      ["/api/admin/paver-designs", { name: "Bad shape", slug: "bad-shape", sort_order: 100001 }],
      ["/api/admin/paver-designs", { name: "Bad slug", slug: "Bad Slug" }],
    ]) {
      const invalid = await requestWithToken(validToken, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400, "invalid content input must be rejected");
    }
    assert.equal(dbBatches.length, beforeInvalidContent, "invalid content must not write to D1");
    assert.ok(dbBatches.length > servicesBefore);


    const unauthTestimonials = await worker.fetch(new Request("https://api.example/api/admin/testimonials"), env);
    assert.equal(unauthTestimonials.status, 401);
    const testimonialList = await requestWithToken(validToken, "/api/admin/testimonials");
    assert.equal(testimonialList.status, 200);
    assert.deepEqual((await testimonialList.json()).data, []);
    const batchesBeforeTestimonialValidation = dbBatches.length;
    const noConsent = await requestWithToken(validToken, "/api/admin/testimonials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_display_name: "Customer",
        testimonial_text: "Great paving work.",
        permission_confirmed: false,
        status: "published",
      }),
    });
    assert.equal(noConsent.status, 400, "publishing without explicit permission is rejected");
    assert.equal(dbBatches.length, batchesBeforeTestimonialValidation, "invalid testimonial must not write");
    const testimonialCreate = await requestWithToken(validToken, "/api/admin/testimonials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_display_name: "Customer",
        customer_role_or_company: "Private client",
        testimonial_text: "The work was completed as agreed.",
        permission_confirmed: true,
        status: "draft",
        sort_order: 1,
      }),
    });
    assert.equal(testimonialCreate.status, 201);
    assert.equal(dbBatches.at(-1).length, 2, "testimonial create and audit are atomic");
    assert.match(dbBatches.at(-1)[0].sql, /^INSERT INTO testimonials/);
    assert.equal(dbBatches.at(-1)[0].values[4], 1);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    const invalidPublish = await requestWithToken(validToken, "/api/admin/testimonials/123e4567-e89b-12d3-a456-426614174000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    });
    assert.equal(invalidPublish.status, 400, "existing testimonial without permission cannot be published");
    const testimonialUpdate = await requestWithToken(validToken, "/api/admin/testimonials/123e4567-e89b-12d3-a456-426614174000", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission_confirmed: true, status: "published" }),
    });
    assert.equal(testimonialUpdate.status, 200);
    assert.match(dbBatches.at(-1)[0].sql, /^UPDATE testimonials SET/);
    assert.match(dbBatches.at(-1)[1].sql, /^INSERT INTO admin_audit_log/);
    const testimonialDelete = await requestWithToken(validToken, "/api/admin/testimonials/123e4567-e89b-12d3-a456-426614174000", { method: "DELETE" });
    assert.equal(testimonialDelete.status, 200);
    assert.match(dbBatches.at(-1)[0].sql, /^DELETE FROM testimonials/);
    assert.equal(dbBatches.at(-1)[1].values[2], "delete");

    const homepageRead = await requestWithToken(validToken, "/api/admin/homepage-content");
    assert.equal(homepageRead.status, 200);
    assert.deepEqual((await homepageRead.json()).data.hero_title, "");
    const homepageBeforeInvalid = dbBatches.length;
    const invalidHomepage = await requestWithToken(validToken, "/api/admin/homepage-content", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hero_title: "A title", arbitrary_setting: "must not be accepted" }),
    });
    assert.equal(invalidHomepage.status, 400);
    assert.equal(dbBatches.length, homepageBeforeInvalid, "unapproved setting keys must not write");
    const homepageSave = await requestWithToken(validToken, "/api/admin/homepage-content", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hero_title: "Paving and civil works", hero_subtitle: "Accurate approved text" }),
    });
    assert.equal(homepageSave.status, 200);
    assert.equal(dbBatches.at(-1).length, 3, "two settings and audit event are atomic");
    assert.match(dbBatches.at(-1)[0].sql, /^INSERT INTO site_settings/);
    assert.match(dbBatches.at(-1)[2].sql, /^INSERT INTO admin_audit_log/);

    const wrongEmail = await requestWithToken(await makeToken({ email: "someone-else@example.com" }));
    assert.equal(wrongEmail.status, 401, "an email outside the allowlist must be rejected");

    const wrongAudience = await requestWithToken(await makeToken({ aud: ["another-audience"] }));
    assert.equal(wrongAudience.status, 401, "a token for another Access application must be rejected");

    const expired = await requestWithToken(await makeToken({ exp: now - 1 }));
    assert.equal(expired.status, 401, "an expired token must be rejected");

    const wrongIssuer = await requestWithToken(await makeToken({ iss: "https://attacker.example" }));
    assert.equal(wrongIssuer.status, 401, "a token from another issuer must be rejected");

    const malformedNbf = await requestWithToken(await makeToken({ nbf: "not-a-number" }));
    assert.equal(malformedNbf.status, 401, "a malformed not-before claim must be rejected");
    const malformedAudience = await requestWithToken(await makeToken({ aud: ["test-access-audience", {}] }));
    assert.equal(malformedAudience.status, 401, "audience claims must contain only strings");
    const blankSubject = await requestWithToken(await makeToken({ sub: "   " }));
    assert.equal(blankSubject.status, 401, "a whitespace-only subject must be rejected");
    const unknownKeyToken = await makeToken();
    const unknownKeyHeader = encode({ alg: "RS256", kid: "unknown-key-id" });
    assert.equal((await requestWithToken(unknownKeyHeader + "." + unknownKeyToken.split(".").slice(1).join("."))).status, 401,
      "a token with an unknown key ID must be rejected");
    const validParts = (await makeToken()).split(".");
    const wrongAlgorithm = encode({ alg: "HS256", kid: jwk.kid }) + "." + validParts[1] + "." + validParts[2];
    assert.equal((await requestWithToken(wrongAlgorithm)).status, 401, "non-RS256 algorithms must be rejected");
    assert.equal((await requestWithToken("!!!!.e30.AA")).status, 401, "invalid base64url segments must be rejected");
    assert.equal((await requestWithToken("A".repeat(8193))).status, 401, "oversized Access tokens must be rejected");

    const configuredTeamDomain = env.ACCESS_TEAM_DOMAIN;
    env.ACCESS_TEAM_DOMAIN = "https://paverblocks.cloudflareaccess.com/unexpected-path";
    assert.equal((await requestWithToken(await makeToken())).status, 401,
      "Access team configuration must reject URL paths");
    env.ACCESS_TEAM_DOMAIN = configuredTeamDomain;

    const invalidSignature = await requestWithToken(await makeToken({}, true));
    assert.equal(invalidSignature.status, 401, "a token with an invalid signature must be rejected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("the public-site CORS allowlist never applies to private admin routes", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/api/admin/inquiries", {
      headers: { Origin: "https://public-site.example" },
    }),
    makeEnv({ SITE_ORIGIN: "https://public-site.example" }),
  );
  assert.equal(response.status, 403, "the public website origin must not cross the admin origin boundary");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("admin preflight is rejected from the public website origin while public API preflight remains allowed", async () => {
  const env = makeEnv({ SITE_ORIGIN: "https://public-site.example" });
  const adminPreflight = await worker.fetch(
    new Request("https://api.example/api/admin/projects", {
      method: "OPTIONS",
      headers: {
        Origin: "https://public-site.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }),
    env,
  );
  assert.equal(adminPreflight.status, 403);

  const publicPreflight = await worker.fetch(
    new Request("https://api.example/api/public/inquiries", {
      method: "OPTIONS",
      headers: {
        Origin: "https://public-site.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }),
    env,
  );
  assert.equal(publicPreflight.status, 204);
  assert.equal(publicPreflight.headers.get("access-control-allow-origin"), "https://public-site.example");
  assert.equal(publicPreflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
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


test("every admin API family rejects unauthenticated requests before touching the database", async () => {
  let databaseTouched = false;
  const env = makeEnv({
    DB: { prepare() { databaseTouched = true; throw new Error("Unauthenticated request must not query D1."); } },
  });
  const requests = [
    ["GET", "/api/admin/inquiries"],
    ["PATCH", "/api/admin/inquiries/123e4567-e89b-12d3-a456-426614174000"],
    ["GET", "/api/admin/projects"],
    ["POST", "/api/admin/projects"],
    ["PATCH", "/api/admin/projects/123e4567-e89b-12d3-a456-426614174000"],
    ["DELETE", "/api/admin/projects/123e4567-e89b-12d3-a456-426614174000"],
    ["DELETE", "/api/admin/projects/123e4567-e89b-12d3-a456-426614174000/images/123e4567-e89b-12d3-a456-426614174001"],
    ["GET", "/api/admin/services"],
    ["POST", "/api/admin/services"],
    ["PATCH", "/api/admin/services/123e4567-e89b-12d3-a456-426614174000"],
    ["DELETE", "/api/admin/services/123e4567-e89b-12d3-a456-426614174000"],
    ["GET", "/api/admin/paver-designs"],
    ["POST", "/api/admin/paver-designs"],
    ["PATCH", "/api/admin/paver-designs/123e4567-e89b-12d3-a456-426614174000"],
    ["DELETE", "/api/admin/paver-designs/123e4567-e89b-12d3-a456-426614174000"],
    ["GET", "/api/admin/testimonials"],
    ["POST", "/api/admin/testimonials"],
    ["PATCH", "/api/admin/testimonials/123e4567-e89b-12d3-a456-426614174000"],
    ["DELETE", "/api/admin/testimonials/123e4567-e89b-12d3-a456-426614174000"],
    ["GET", "/api/admin/homepage-content"],
    ["PATCH", "/api/admin/homepage-content"],
  ];
  for (const [method, path] of requests) {
    const response = await worker.fetch(new Request("https://api.example" + path, {
      method,
      headers: { Origin: "https://api.example" },
    }), env);
    assert.equal(response.status, 401, method + " " + path + " must require Access authentication");
  }
  assert.equal(databaseTouched, false, "unauthenticated admin requests must not touch D1");
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

test("project image upload fails closed when development R2 binding is missing", async () => {
  const response = await uploadProjectImage(
    new Request("https://api.example/api/admin/projects/123e4567-e89b-12d3-a456-426614174000/images", { method: "POST" }),
    { DB: { prepare() { throw new Error("D1 must not be touched."); } } },
    "123e4567-e89b-12d3-a456-426614174000",
    { email: "admin@example.com" },
    (request, env, body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Project image storage is not configured yet." });
});

test("project image upload rejects missing or oversized content length before D1 access", async () => {
  let databaseTouched = false;
  const response = await uploadProjectImage(
    new Request("https://api.example/api/admin/projects/123e4567-e89b-12d3-a456-426614174000/images", { method: "POST" }),
    { PROJECT_IMAGES: { async put() {} }, DB: { prepare() { databaseTouched = true; } } },
    "123e4567-e89b-12d3-a456-426614174000",
    { email: "admin@example.com" },
    (request, env, body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  assert.equal(response.status, 413);
  assert.equal(databaseTouched, false);
});

test("project image upload stops oversized streamed bodies before parsing or D1 access", async () => {
  let databaseTouched = false;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(5 * 1024 * 1024 + 70 * 1024))); },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://api.example/api/admin/projects/123e4567-e89b-12d3-a456-426614174000/images", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test-boundary", "Content-Length": "500" },
    body,
    duplex: "half",
  });
  const response = await uploadProjectImage(
    request,
    { PROJECT_IMAGES: { async put() {} }, DB: { prepare() { databaseTouched = true; } } },
    "123e4567-e89b-12d3-a456-426614174000",
    { email: "admin@example.com" },
    (req, env, payload, status) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  );
  assert.equal(response.status, 413);
  assert.equal(databaseTouched, false);
  assert.equal(cancelled, true);
});

test("project image delivery can be restricted to published projects or allowed for authenticated admin previews", async () => {
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const imageId = "123e4567-e89b-12d3-a456-426614174001";
  const key = "projects/" + projectId + "/" + imageId + ".jpg";
  let query = "";
  let bucketReads = 0;
  const env = {
    DB: { prepare(sql) { query = sql; return { bind() { return { async first() { return { object_key: key }; } }; } }; } },
    PROJECT_IMAGES: { async get() { bucketReads++; return { body: new Uint8Array([1]), httpMetadata: { contentType: "image/jpeg" }, httpEtag: '"etag"' }; } },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const publicResponse = await serveProjectImage(
    new Request("https://api.example/media/" + key),
    env,
    new URL("https://api.example/media/" + key),
    respond,
  );
  assert.match(query, /p\.status = 'published'/);
  assert.equal(publicResponse.status, 200);
  const adminResponse = await serveProjectImage(
    new Request("https://api.example/admin/media/" + key),
    env,
    new URL("https://api.example/admin/media/" + key),
    respond,
    false,
    "/admin/media/",
  );
  assert.doesNotMatch(query, /p\.status = 'published'/);
  assert.equal(adminResponse.status, 200);
  assert.equal(bucketReads, 2);
});

test("public project media rejects arbitrary object keys", async () => {
  let bucketTouched = false;
  const response = await serveProjectImage(
    new Request("https://api.example/media/../private/customer-data"),
    { PROJECT_IMAGES: { async get() { bucketTouched = true; return null; } } },
    new URL("https://api.example/media/../private/customer-data"),
    (request, env, body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  assert.equal(response.status, 404);
  assert.equal(bucketTouched, false);
});


test("project photo deletion verifies project ownership before touching R2", async () => {
  let bucketDeletes = 0;
  let batches = 0;
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const imageId = "123e4567-e89b-12d3-a456-426614174001";
  const env = {
    PROJECT_IMAGES: { async delete() { bucketDeletes++; } },
    DB: {
      prepare(sql) {
        assert.ok(sql.includes("WHERE id = ? AND project_id = ?"));
        return { bind() { return { async first() { return { id: imageId, object_key: "projects/another-project/" + imageId + ".jpg" }; } }; } };
      },
      async batch() { batches++; },
    },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const result = await deleteProjectImage(env, projectId, imageId, { email: "admin@example.com" }, respond, new Request("https://api.example"));
  assert.equal(result.status, 404);
  assert.equal(bucketDeletes, 0);
  assert.equal(batches, 0);
});

test("project photo deletion removes the R2 object and records the D1 deletion and audit together", async () => {
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const imageId = "123e4567-e89b-12d3-a456-426614174001";
  const key = "projects/" + projectId + "/" + imageId + ".webp";
  const events = [];
  const env = {
    PROJECT_IMAGES: { async delete(value) { events.push(["r2-delete", value]); } },
    DB: {
      prepare(sql) {
        events.push(["prepare", sql]);
        const statement = { sql, values: [], bind(...values) { statement.values = values; return statement; }, async first() { return { id: imageId, object_key: key }; }, async all() { return { results: [] }; } }; return statement;
      },
      async batch(statements) { events.push(["batch", statements.map(s=>s.sql)]); },
    },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const result = await deleteProjectImage(env, projectId, imageId, { email: "admin@example.com" }, respond, new Request("https://api.example"));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(await result.text()), { success: true });
  assert.deepEqual(events[0], ["prepare", "SELECT id, object_key FROM project_images WHERE id = ? AND project_id = ? LIMIT 1"]);
  assert.deepEqual(events[1], ["r2-delete", key]);
  assert.equal(events.at(-1)[0], "batch");
  assert.match(events.at(-1)[1][0], /^DELETE FROM project_images/);
  assert.match(events.at(-1)[1][1], /^INSERT INTO admin_audit_log/);
});

test("project photo deletion fails closed when R2 deletion fails", async () => {
  let batches = 0;
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const imageId = "123e4567-e89b-12d3-a456-426614174001";
  const env = {
    PROJECT_IMAGES: { async delete() { throw new Error("R2 unavailable"); } },
    DB: {
      prepare() { return { bind() { return { async first() { return { id: imageId, object_key: "projects/" + projectId + "/" + imageId + ".jpg" }; } }; } }; },
      async batch() { batches++; },
    },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const result = await deleteProjectImage(env, projectId, imageId, { email: "admin@example.com" }, respond, new Request("https://api.example"));
  assert.equal(result.status, 503);
  assert.equal(batches, 0);
});

test("gallery reorder rejects duplicate or stale/cross-project image IDs without writes", async () => {
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const first = "123e4567-e89b-12d3-a456-426614174001";
  const second = "123e4567-e89b-12d3-a456-426614174002";
  let batches = 0;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (sql.startsWith("SELECT id FROM projects")) return { async first() { return { id: projectId }; } };
            return { async all() { return { results: [{ id: first }, { id: second }] }; } };
          },
        };
      },
      async batch() { batches++; },
    },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const duplicate = await reorderProjectImages(env, projectId, [first, first], { email: "admin@example.com" }, respond, new Request("https://api.example"));
  assert.equal(duplicate.status, 400);
  const stale = await reorderProjectImages(env, projectId, [first, "123e4567-e89b-12d3-a456-426614174099"], { email: "admin@example.com" }, respond, new Request("https://api.example"));
  assert.equal(stale.status, 409);
  assert.equal(batches, 0);
});

test("gallery reorder updates every image in the same project and records an audit event", async () => {
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const first = "123e4567-e89b-12d3-a456-426614174001";
  const second = "123e4567-e89b-12d3-a456-426614174002";
  let batch = [];
  const env = {
    DB: {
      prepare(sql) {
        const statement = {
          sql, values: [],
          bind(...values) { statement.values = values; return statement; },
          async first() { return { id: projectId }; },
          async all() { return { results: [{ id: first }, { id: second }] }; },
        };
        return statement;
      },
      async batch(statements) { batch = statements; },
    },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const result = await reorderProjectImages(env, projectId, [second, first], { email: "admin@example.com" }, respond, new Request("https://api.example"));
  assert.equal(result.status, 200);
  assert.equal(batch.length, 3);
  assert.ok(batch[0].sql.includes("UPDATE project_images SET sort_order = ? WHERE id = ? AND project_id = ?"));
  assert.deepEqual(batch[0].values, [0, second, projectId]);
  assert.deepEqual(batch[1].values, [1, first, projectId]);
  assert.match(batch[2].sql, /^INSERT INTO admin_audit_log/);
});

test("draft project image previews are private and never shared-cacheable", async () => {
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const imageId = "123e4567-e89b-12d3-a456-426614174001";
  const key = "projects/" + projectId + "/" + imageId + ".jpg";
  const env = {
    DB: { prepare() { return { bind() { return { async first() { return { object_key: key }; } }; } }; } },
    PROJECT_IMAGES: { async get() { return { body: new Uint8Array([1]), httpMetadata: { contentType: "image/jpeg" }, httpEtag: '"etag"' }; } },
  };
  const respond = (request, bindings, body, status=200) => new Response(JSON.stringify(body), { status });
  const preview = await serveProjectImage(
    new Request("https://api.example/admin/media/" + key), env,
    new URL("https://api.example/admin/media/" + key), respond, false, "/admin/media/",
  );
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
});
