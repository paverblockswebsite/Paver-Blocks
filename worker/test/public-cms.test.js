import test from "node:test";
import assert from "node:assert/strict";
import api from "../src/index.js";

function createEnv(rows = {}) {
  const queries = [];
  const env = {
    SITE_ORIGIN: "https://preview.paverblocks.dev",
    DB: {
      prepare(sql) {
        const query = { sql, bindings: [] };
        queries.push(query);
        return {
          bind(...values) { query.bindings = values; return this; },
          async all() {
            const table = sql.match(/FROM\s+(projects|services|paver_designs|testimonials)/i)?.[1];
            return { results: rows[table] || [] };
          },
        };
      },
    },
  };
  return { env, queries };
}

async function getPublic(path, env, origin = "https://preview.paverblocks.dev") {
  return api.fetch(new Request("https://api.paverblocks.dev" + path, {
    method: "GET",
    headers: origin ? { Origin: origin } : {},
  }), env);
}

test("public Services endpoint returns only the published field allowlist", async () => {
  const { env, queries } = createEnv({
    services: [{ id: "s1", title: "Paving", slug: "paving", short_description: "Short", description: "Full" }],
  });
  const response = await getPublic("/api/public/services", env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), env.SITE_ORIGIN);
  assert.deepEqual((await response.json()).data, [{
    id: "s1", title: "Paving", slug: "paving", short_description: "Short", description: "Full",
  }]);
  assert.match(queries[0].sql, /WHERE status = 'published'/);
  assert.match(queries[0].sql, /ORDER BY sort_order ASC/);
});

test("public Paver Designs endpoint never selects internal supplier notes", async () => {
  const { env, queries } = createEnv({
    paver_designs: [{ id: "d1", name: "I-Shape", slug: "i-shape", shape: "Interlocking", dimensions: "200x160", thickness: "60mm", colour: "Grey" }],
  });
  const response = await getPublic("/api/public/paver-designs", env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data[0].name, "I-Shape");
  assert.doesNotMatch(queries[0].sql, /supplier_note/i);
  assert.match(queries[0].sql, /WHERE status = 'published'/);
});

test("public Testimonials endpoint requires confirmed permission and published status", async () => {
  const { env, queries } = createEnv({
    testimonials: [{ id: "t1", customer_display_name: "Approved Client", customer_role_or_company: "", testimonial_text: "Approved feedback" }],
  });
  const response = await getPublic("/api/public/testimonials", env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].customer_display_name, "Approved Client");
  assert.match(queries[0].sql, /WHERE status = 'published'/);
  assert.match(queries[0].sql, /permission_confirmed = 1/);
  assert.doesNotMatch(queries[0].sql, /phone|email|internal_notes/i);
});

test("public endpoints reject an unapproved website origin before querying D1", async () => {
  const { env, queries } = createEnv();
  const response = await getPublic("/api/public/services", env, "https://untrusted.example");
  assert.equal(response.status, 403);
  assert.equal(queries.length, 0);
});
