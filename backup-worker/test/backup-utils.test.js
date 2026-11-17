import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveListedImagePage,
  isProjectImageKey,
  parseD1ExportResponse,
} from "../src/backup-utils.js";

const imageKey = "projects/123e4567-e89b-12d3-a456-426614174000/123e4567-e89b-12d3-a456-426614174001.webp";

test("accepts only project image object keys", () => {
  assert.equal(isProjectImageKey(imageKey), true);
  assert.equal(isProjectImageKey("projects/not-a-uuid/photo.webp"), false);
  assert.equal(isProjectImageKey("unrelated/file.webp"), false);
});

test("parses a running D1 export bookmark", () => {
  assert.deepEqual(
    parseD1ExportResponse({ success: true, result: { status: "running", at_bookmark: "bookmark-1" } }),
    { status: "running", bookmark: "bookmark-1" },
  );
});

test("parses a completed D1 export", () => {
  assert.deepEqual(
    parseD1ExportResponse({
      success: true,
      result: {
        status: "complete",
        at_bookmark: "bookmark-2",
        result: { filename: "export.sql", signed_url: "https://example.invalid/export.sql" },
      },
    }),
    {
      status: "complete",
      bookmark: "bookmark-2",
      filename: "export.sql",
      signedUrl: "https://example.invalid/export.sql",
    },
  );
});

test("rejects an unsuccessful D1 export response", () => {
  assert.throws(
    () => parseD1ExportResponse({ success: false, result: null }),
    /unsuccessful response/,
  );
  assert.throws(
    () => parseD1ExportResponse({ success: true, result: { status: "error", error: "export failed" } }),
    /export failed/,
  );
});

test("archives valid project images and skips unrelated or already archived objects", async () => {
  const copied = [];
  const sourceBucket = {
    async list() {
      return {
        objects: [{ key: imageKey }, { key: "misc/readme.txt" }],
        truncated: false,
      };
    },
    async get(key) {
      assert.equal(key, imageKey);
      return {
        body: "image-bytes",
        httpMetadata: { contentType: "image/webp" },
        customMetadata: { source: "projects" },
      };
    },
  };
  const archiveBucket = {
    async head(key) {
      return key === "images/" + imageKey ? null : null;
    },
    async put(key, body, options) {
      copied.push({ key, body, options });
      return { etag: "etag-1" };
    },
  };

  const result = await archiveListedImagePage(
    sourceBucket,
    archiveBucket,
    undefined,
    "2026-11-17T21:00:00.000Z",
  );

  assert.deepEqual(result, { archived: 1, skipped: 1, truncated: false, cursor: null });
  assert.equal(copied.length, 1);
  assert.equal(copied[0].key, "images/" + imageKey);
  assert.equal(copied[0].body, "image-bytes");
  assert.equal(copied[0].options.httpMetadata.contentType, "image/webp");
  assert.equal(copied[0].options.customMetadata.originalKey, imageKey);
});
