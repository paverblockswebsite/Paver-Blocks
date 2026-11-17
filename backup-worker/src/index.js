import { WorkflowEntrypoint } from "cloudflare:workers";
import { archiveListedImagePage, parseD1ExportResponse } from "./backup-utils.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing required backup configuration: " + name);
  }
  return value.trim();
}

async function requestD1Export(env, body) {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
  const databaseId = required(env.D1_DATABASE_ID, "D1_DATABASE_ID");
  const token = required(env.D1_REST_API_TOKEN, "D1_REST_API_TOKEN");
  const response = await fetch(
    API_BASE + "/accounts/" + encodeURIComponent(accountId) +
      "/d1/database/" + encodeURIComponent(databaseId) + "/export",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare D1 export API returned invalid JSON.");
  }

  if (!response.ok) {
    throw new Error("Cloudflare D1 export API request failed with HTTP " + response.status + ".");
  }
  return parseD1ExportResponse(payload);
}

export class ProductionBackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    required(env.BACKUPS, "BACKUPS R2 binding");
    required(env.PROJECT_IMAGES, "PROJECT_IMAGES R2 binding");
    required(env.PROJECT_IMAGE_ARCHIVE, "PROJECT_IMAGE_ARCHIVE R2 binding");
    const databaseId = required(env.D1_DATABASE_ID, "D1_DATABASE_ID");
    const databaseName = required(env.D1_DATABASE_NAME, "D1_DATABASE_NAME");
    const scheduledAt = event.schedule?.scheduledTime
      ? new Date(event.schedule.scheduledTime).toISOString()
      : new Date().toISOString();
    const date = scheduledAt.slice(0, 10);
    const runId = date + "T" + scheduledAt.slice(11, 19).replace(/:/g, "-");

    // Archive any existing live project images before taking the matching D1 snapshot.
    let cursor;
    let archivedImages = 0;
    let scannedPages = 0;
    for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
      const page = await step.do("archive image page " + pageNumber, async () => {
        return await archiveListedImagePage(
          env.PROJECT_IMAGES,
          env.PROJECT_IMAGE_ARCHIVE,
          cursor,
          scheduledAt,
        );
      });
      archivedImages += page.archived;
      scannedPages++;
      if (!page.truncated) break;
      if (!page.cursor) throw new Error("R2 image archive pagination returned no cursor.");
      cursor = page.cursor;
      if (pageNumber === 999) throw new Error("R2 image archive exceeded the safe page limit.");
    }

    let exportState = await step.do("start D1 SQL export", async () => {
      return await requestD1Export(env, {
        output_format: "polling",
        dump_options: { compatibility: "d1" },
      });
    });

    for (let pollNumber = 0; exportState.status !== "complete" && pollNumber < 90; pollNumber++) {
      if (!exportState.bookmark) throw new Error("D1 export polling bookmark is missing.");
      await step.sleep("wait for D1 export poll " + pollNumber, "10 seconds");
      exportState = await step.do("poll D1 SQL export " + pollNumber, async () => {
        return await requestD1Export(env, {
          output_format: "polling",
          current_bookmark: exportState.bookmark,
          dump_options: { compatibility: "d1" },
        });
      });
    }

    if (exportState.status !== "complete" || !exportState.signedUrl || !exportState.filename) {
      throw new Error("D1 export did not complete within the polling window.");
    }

    const sqlKey = "d1/" + date + "/" + runId + ".sql";
    const sqlResult = await step.do("store D1 SQL export", async () => {
      const download = await fetch(exportState.signedUrl);
      if (!download.ok || !download.body) {
        throw new Error("The signed D1 SQL export download failed.");
      }
      const stored = await env.BACKUPS.put(sqlKey, download.body, {
        httpMetadata: { contentType: "application/sql" },
        customMetadata: {
          databaseName,
          databaseId,
          sourceFilename: exportState.filename,
          exportedAt: scheduledAt,
        },
      });
      return { key: sqlKey, etag: stored?.etag || null };
    });

    const manifest = {
      formatVersion: 1,
      status: "complete",
      databaseName,
      databaseId,
      scheduledAt,
      completedAt: new Date().toISOString(),
      exportBookmark: exportState.bookmark,
      sql: {
        key: sqlResult.key,
        sourceFilename: exportState.filename,
        etag: sqlResult.etag,
        compatibility: "d1",
      },
      imageArchive: {
        bucketPurpose: "immutable project-image recovery archive",
        pagesScanned: scannedPages,
        newlyArchivedObjects: archivedImages,
        archivePrefix: "images/",
      },
    };
    const manifestKey = "manifests/" + date + "/" + runId + ".json";
    await step.do("store backup manifest", async () => {
      await env.BACKUPS.put(manifestKey, JSON.stringify(manifest, null, 2), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { databaseName, databaseId, status: "complete" },
      });
      return { key: manifestKey };
    });

    return {
      status: "complete",
      databaseName,
      sqlKey: sqlResult.key,
      manifestKey,
      newlyArchivedImages: archivedImages,
    };
  }
}

export default {
  async fetch() {
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  },
};
