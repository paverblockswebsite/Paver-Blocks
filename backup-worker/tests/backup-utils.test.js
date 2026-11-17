import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveListedImagePage,
  isProjectImageKey,
  parseD1ExportResponse,
} from "../src/backup-utils.js";

const projectId = "123e4567-e89b-12d3-a456-426614174000";
const imageId = "123e4567-e89b-12d3-a456-426614174001";
const imageKey = "projects/" + projectId + "/" + imageId + ".jpg";

test("only validated project image keys are eligible for archive", () => {
  assert.equal(isProjectImageKey(imageKey), true);
  assert.equal(isProjectImageKey("../private/inquiries.csv"), false);
  assert.equal(isProjectImageKey("projects/not-a-uuid/" + imageId + ".jpg"), false);
});

test("image archive copies object and metadata without deleting the source", async () => {
  const events = [];
  const sourceBucket = {
    async list() { return { objects: [{ key: imageKey }], truncated: false }; },
    async get(key) {
      events.push(["get", key]);
      return {
        body: new Uint8Array([1, 2, 3]),
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: { projectId },
      };
    },
  };
  const archiveBucket = {
    async head(key) { events.push(["head", key]); return null; },
    async put(key, body, options) {
      events.push(["put", key, options.customMetadata.originalKey]);
      assert.deepEqual(Array.from(body), [1, 2, 3]);
      return { etag: "archive-etag" };
    },
  };

  const result = await archiveListedImagePage(sourceBucket, archiveBucket, undefined, "2026-11-17T21:00:00.000Z");
  assert.deepEqual(result, { archived: 1, skipped: 0, truncated: false, cursor: null });
  assert.deepEqual(events, [
    ["head", "images/" + imageKey],
    ["get", imageKey],
    ["put", "images/" + imageKey, imageKey],
  ]);
});

test("image archive skips an existing immutable archive object", async () => {
  let sourceReads = 0;
  let archiveWrites = 0;
  const sourceBucket = {
    async list() { return { objects: [{ key: imageKey }], truncated: false }; },
    async get() { sourceReads++; return null; },
  };
  const archiveBucket = {
    async head() { return { key: "already-archived" }; },
    async put() { archiveWrites++; },
  };
  const result = await archiveListedImagePage(sourceBucket, archiveBucket);
  assert.equal(result.skipped, 1);
  assert.equal(sourceReads, 0);
  assert.equal(archiveWrites, 0);
});

test("D1 export parser accepts Cloudflare's documented running polling response", () => {
  assert.deepEqual(parseD1ExportResponse({
    success: true,
    result: { at_bookmark: "bookmark-123" },
  }), { status: "running", bookmark: "bookmark-123" });
});

test("D1 export parser accepts Cloudflare's documented nested completed response", () => {
  assert.deepEqual(parseD1ExportResponse({
    success: true,
    result: {
      at_bookmark: "bookmark-456",
      status: "complete",
      result: {
        filename: "export.sql",
        signed_url: "https://example.invalid/export.sql",
      },
    },
  }), {
    status: "complete",
    bookmark: "bookmark-456",
    filename: "export.sql",
    signedUrl: "https://example.invalid/export.sql",
  });
});

test("D1 export parser rejects API errors and incomplete responses", () => {
  assert.throws(() => parseD1ExportResponse({ success: false }), /unsuccessful response/);
  assert.throws(() => parseD1ExportResponse({
    success: true,
    result: { status: "error", error: "export failed" },
  }), /export failed/);
  assert.throws(() => parseD1ExportResponse({
    success: true,
    result: { status: "complete" },
  }), /missing its SQL download details/);
  assert.throws(() => parseD1ExportResponse({
    success: true,
    result: { status: "running" },
  }), /neither a polling bookmark nor a completed SQL file/);
});
