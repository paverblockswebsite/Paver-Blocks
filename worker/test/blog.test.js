import test from "node:test";
import assert from "node:assert/strict";
import { handleBlogAdmin, handleBlogPublic } from "../src/blog.js";

function fakeDb() {
  const calls = [];
  const db = {
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      return {
        bind(...values) { call.values = values; return this; },
        async all() { return { results: [] }; },
        async first() { return null; },
        async run() { return { success: true }; },
      };
    },
    async batch(statements) {
      calls.push({ batch: statements.length });
      return statements.map(() => ({ success: true }));
    },
  };
  return { db, calls };
}

function request(path, method = "GET", body) {
  return new Request("https://api.example.test" + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const identity = { email: "admin@example.test" };

test("admin article creation rejects unknown content block types before touching D1", async () => {
  const { db, calls } = fakeDb();
  const response = await handleBlogAdmin(
    request("/api/admin/blog/articles", "POST", {
      title: "Unsafe article",
      slug: "unsafe-article",
      content: [{ type: "html", html: "<script>alert(1)</script>" }],
    }),
    { DB: db },
    new URL("https://api.example.test/api/admin/blog/articles"),
    identity,
  );
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("admin article creation uses parameterized D1 statements and records an audit event", async () => {
  const { db, calls } = fakeDb();
  const response = await handleBlogAdmin(
    request("/api/admin/blog/articles", "POST", {
      title: "Paver block installation guide",
      slug: "paver-block-installation-guide",
      excerpt: "A practical guide.",
      content: [
        { type: "paragraph", text: "Prepare and compact the base." },
        { type: "heading", level: 2, text: "Prepare the base" },
      ],
      status: "draft",
    }),
    { DB: db },
    new URL("https://api.example.test/api/admin/blog/articles"),
    identity,
  );
  assert.equal(response.status, 201);
  assert.equal(calls.at(-1).batch, 2);
  assert.match(calls[0].sql, /^INSERT INTO blog_articles/);
  assert.ok(calls[0].values.includes("Paver block installation guide"));
  assert.match(calls[1].sql, /INSERT INTO admin_audit_log/);
});

test("public article lookup only returns published content and keeps noindex articles accessible", async () => {
  const calls = [];
  const article = {
    id: "article-id",
    title: "A published guide",
    slug: "published-guide",
    content_json: '[{"type":"paragraph","text":"Public content"}]',
  };
  const db = {
    prepare(sql) {
      const call = { sql, values: [] };
      calls.push(call);
      return {
        bind(...values) { call.values = values; return this; },
        async first() { return article; },
        async all() { return { results: [] }; },
      };
    },
  };
  const response = await handleBlogPublic(
    request("/api/public/blog/articles/published-guide"),
    { DB: db },
    new URL("https://api.example.test/api/public/blog/articles/published-guide"),
    (_request, _env, data, status = 200) => new Response(JSON.stringify(data), { status }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.content[0].text, "Public content");
  assert.match(calls[0].sql, /a\.status = 'published'/);
  assert.doesNotMatch(calls[0].sql, /robots_index = 1/);
  assert.deepEqual(calls[0].values, ["published-guide"]);
});

test("unknown blog routes are left for the existing router to handle", async () => {
  const { db } = fakeDb();
  const result = await handleBlogAdmin(
    request("/api/admin/blog/not-a-resource"),
    { DB: db },
    new URL("https://api.example.test/api/admin/blog/not-a-resource"),
    identity,
  );
  assert.equal(result, null);
});
