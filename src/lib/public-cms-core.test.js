import test from "node:test";
import assert from "node:assert/strict";
import { createPublicCmsClient, resolvePublicApiOrigin } from "./public-cms-core.js";

test("accepts only safe HTTPS API origins (and local HTTP development)", () => {
  assert.equal(resolvePublicApiOrigin("https://api.example.com"), "https://api.example.com");
  assert.equal(resolvePublicApiOrigin("http://localhost:8787"), "http://localhost:8787");
  for (const value of [
    "",
    "not a URL",
    "http://api.example.com",
    "https://api.example.com/path",
    "https://api.example.com/?x=1",
    "https://user:pass@api.example.com",
    "https://api.example.com#fragment",
  ]) assert.equal(resolvePublicApiOrigin(value), null, String(value));
});

test("does not call fetch when no valid API origin is configured", async () => {
  let calls = 0;
  const cms = createPublicCmsClient("", async () => { calls++; throw new Error("must not run"); });
  assert.deepEqual(await cms.fetchPublicList("/api/public/services"), []);
  assert.equal(await cms.fetchPublicProject("sample-project"), null);
  assert.equal(cms.publicProjectImageUrl("projects/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000.webp"), "");
  assert.equal(calls, 0);
});

test("returns published list payload and reuses the build-time request", async () => {
  let calls = 0;
  const cms = createPublicCmsClient("https://api.example.com", async (url, options) => {
    calls++;
    assert.equal(url.href, "https://api.example.com/api/public/services");
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Accept, "application/json");
    return new Response(JSON.stringify({ data: [{ title: "Test service" }] }), { status: 200 });
  });
  const [first, second] = await Promise.all([
    cms.fetchPublicList("/api/public/services"),
    cms.fetchPublicList("/api/public/services"),
  ]);
  assert.deepEqual(first, [{ title: "Test service" }]);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("fails closed for bad responses, invalid payloads, and network errors", async () => {
  const failed = createPublicCmsClient("https://api.example.com", async () =>
    new Response("unavailable", { status: 503 }));
  assert.deepEqual(await failed.fetchPublicList("/api/public/services"), []);

  const malformed = createPublicCmsClient("https://api.example.com", async () =>
    new Response(JSON.stringify({ data: { unexpected: true } }), { status: 200 }));
  assert.deepEqual(await malformed.fetchPublicList("/api/public/services"), []);

  const network = createPublicCmsClient("https://api.example.com", async () => {
    throw new Error("network unavailable");
  });
  assert.equal(await network.fetchPublicProject("valid-slug"), null);
});

test("validates project slugs before requesting details", async () => {
  let calls = 0;
  const cms = createPublicCmsClient("https://api.example.com", async () => {
    calls++;
    return new Response(JSON.stringify({ data: { title: "A project" } }), { status: 200 });
  });
  assert.equal(await cms.fetchPublicProject("../private"), null);
  assert.equal(calls, 0);
  assert.deepEqual(await cms.fetchPublicProject("valid-project"), { title: "A project" });
  assert.equal(calls, 1);
});

test("only creates media URLs for the approved project object-key format", () => {
  const cms = createPublicCmsClient("https://api.example.com");
  const key = "projects/00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111.webp";
  assert.equal(cms.publicProjectImageUrl(key), "https://api.example.com/media/" + key);
  assert.equal(cms.publicProjectImageUrl("../private/file.webp"), "");
  assert.equal(cms.publicProjectImageUrl("projects/id/image.svg"), "");
});
