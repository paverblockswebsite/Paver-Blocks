import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import gateway from "../src/index.js";
const JWT = "signed-access-jwt-placeholder";
function env(overrides = {}) {
  return { API_ORIGIN: "https://paver-blocks-api-dev.hellopaverblocks.workers.dev", ...overrides };
}
test("rejects public API and arbitrary paths without proxying", async () => {
  const old = globalThis.fetch; let called = false;
  globalThis.fetch = async () => { called = true; return new Response("unexpected"); };
  try {
    for (const path of ["/health", "/api/public/inquiries", "/anything"])
      assert.equal((await gateway.fetch(new Request("https://admin.example"+path),env())).status,404);
    assert.equal(called,false);
  } finally { globalThis.fetch=old; }
});
test("requires Cloudflare Access assertion", async () => {
  assert.equal((await gateway.fetch(new Request("https://admin.example/admin"),env())).status,401);
});
test("legacy public fetch fallback preserves request and security headers", async () => {
  const old=globalThis.fetch; let got;
  globalThis.fetch=async r=>{got=r;return new Response("admin response",{status:200,headers:{"content-type":"text/plain"}});};
  try {
    const res=await gateway.fetch(new Request("https://admin.example/api/admin/inquiries?limit=10",{method:"PATCH",headers:{"Cf-Access-Jwt-Assertion":JWT,Cookie:"CF_Authorization=x",Origin:"https://admin.example","Sec-Fetch-Site":"same-origin","Content-Type":"application/json"},body:'{"status":"contacted"}'}),env());
    assert.equal(res.status,200); assert.equal(await res.text(),"admin response");
    assert.equal(got.url,"https://paver-blocks-api-dev.hellopaverblocks.workers.dev/api/admin/inquiries?limit=10");
    assert.equal(got.method,"PATCH"); assert.equal(got.headers.get("Cf-Access-Jwt-Assertion"),JWT);
    assert.equal(got.headers.get("Cookie"),null); assert.equal(got.headers.get("Origin"),env().API_ORIGIN);
    assert.equal(got.headers.get("Sec-Fetch-Site"),"same-origin");
    assert.deepEqual(await got.json(),{status:"contacted"});
    assert.equal(res.headers.get("cache-control"),"no-store"); assert.equal(res.headers.get("x-content-type-options"),"nosniff");
  } finally {globalThis.fetch=old;}
});
test("fails closed for insecure or non-allowlisted origins", async()=>{
  for(const API_ORIGIN of ["http://untrusted.example","https://paver-blocks-api.example.com","https://paver-blocks-api-prod.hellopaverblocks.workers.dev"])
    assert.equal((await gateway.fetch(new Request("https://admin.example/admin",{headers:{"Cf-Access-Jwt-Assertion":JWT}}),env({API_ORIGIN}))).status,503);
});
test("uses service binding instead of public fetch", async()=>{
  const old=globalThis.fetch; let called=false,bound=false;
  globalThis.fetch=async()=>{called=true;throw Error("public fetch called");};
  try {
    const res=await gateway.fetch(new Request("https://admin.example/admin",{headers:{"Cf-Access-Jwt-Assertion":JWT}}),env({API:{fetch:async r=>{bound=true;assert.equal(new URL(r.url).pathname,"/admin");return new Response("bound");}}}));
    assert.equal(bound,true);assert.equal(called,false);assert.equal(await res.text(),"bound");
  } finally {globalThis.fetch=old;}
});
test("binding preserves PATCH method, path, query, body and security headers",async()=>{
  let got;
  const res=await gateway.fetch(new Request("https://admin.example/api/admin/inquiries?limit=10&status=new",{method:"PATCH",headers:{"Cf-Access-Jwt-Assertion":JWT,Cookie:"session=x",Origin:"https://admin.example","Sec-Fetch-Site":"same-origin","Content-Type":"application/json"},body:'{"status":"contacted"}'}),env({API:{fetch:async r=>{got=r;return new Response("updated",{status:202});}}}));
  assert.equal(res.status,202);assert.equal(got.method,"PATCH");
  assert.equal(new URL(got.url).pathname,"/api/admin/inquiries");assert.equal(new URL(got.url).search,"?limit=10&status=new");
  assert.deepEqual(await got.json(),{status:"contacted"});assert.equal(got.headers.get("Cf-Access-Jwt-Assertion"),JWT);
  assert.equal(got.headers.get("Cookie"),null);assert.equal(got.headers.get("Origin"),env().API_ORIGIN);assert.equal(got.headers.get("Sec-Fetch-Site"),"same-origin");
});
test("binding GET preserves query and upstream status/content type",async()=>{
  let got;
  const res=await gateway.fetch(new Request("https://admin.example/admin/?utm_source=test",{headers:{"Cf-Access-Jwt-Assertion":JWT}}),env({API:{fetch:async r=>{got=r;return new Response("dashboard",{status:203,headers:{"content-type":"text/html; charset=utf-8"}});}}}));
  assert.equal(got.method,"GET");assert.equal(new URL(got.url).search,"?utm_source=test");
  assert.equal(res.status,203);assert.equal(res.headers.get("content-type"),"text/html; charset=utf-8");assert.equal(await res.text(),"dashboard");
});
test("blocked paths and missing assertion never invoke binding",async()=>{
  let called=false;const e=env({API:{fetch:async()=>{called=true;return new Response("unexpected");}}});
  assert.equal((await gateway.fetch(new Request("https://admin.example/nope",{headers:{"Cf-Access-Jwt-Assertion":JWT}}),e)).status,404);
  assert.equal((await gateway.fetch(new Request("https://admin.example/admin"),e)).status,401);assert.equal(called,false);
});
test("binding failures return 502",async()=>{
  const res=await gateway.fetch(new Request("https://admin.example/admin",{headers:{"Cf-Access-Jwt-Assertion":JWT}}),env({API:{fetch:async()=>{throw Error("offline");}}}));
  assert.equal(res.status,502);
});
test("production config declares only the intended API service binding",()=>{
  const s=readFileSync(new URL("../wrangler.production.toml",import.meta.url),"utf8");
  assert.equal((s.match(/^\[\[services\]\]$/gm)||[]).length,1);
  assert.match(s,/^binding\s*=\s*"API"$/m);assert.match(s,/^service\s*=\s*"paver-blocks-api"$/m);
});
test("development config remains without a service binding",()=>{
  const s=readFileSync(new URL("../wrangler.toml",import.meta.url),"utf8");
  assert.doesNotMatch(s,/^\[\[services\]\]$/m);
});
