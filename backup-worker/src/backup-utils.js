const IMAGE_KEY = /^projects\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i;

export function isProjectImageKey(key) {
  return typeof key === "string" && IMAGE_KEY.test(key);
}

export async function archiveListedImagePage(sourceBucket, archiveBucket, cursor = undefined, archivedAt = new Date().toISOString()) {
  if (!sourceBucket || typeof sourceBucket.list !== "function" ||
      typeof sourceBucket.get !== "function" ||
      !archiveBucket || typeof archiveBucket.put !== "function" ||
      typeof archiveBucket.head !== "function") {
    throw new Error("Both source and archive R2 buckets must be configured.");
  }

  const page = await sourceBucket.list({ cursor, limit: 25 });
  let archived = 0;
  let skipped = 0;

  for (const item of page.objects || []) {
    if (!isProjectImageKey(item.key)) {
      skipped++;
      continue;
    }

    const archiveKey = "images/" + item.key;
    const existing = await archiveBucket.head(archiveKey);
    if (existing) {
      skipped++;
      continue;
    }

    const source = await sourceBucket.get(item.key);
    if (!source) {
      throw new Error("A listed project image disappeared before it could be archived.");
    }

    await archiveBucket.put(archiveKey, source.body, {
      httpMetadata: source.httpMetadata,
      customMetadata: {
        ...(source.customMetadata || {}),
        originalKey: item.key,
        archivedAt,
      },
    });
    archived++;
  }

  return {
    archived,
    skipped,
    truncated: page.truncated === true,
    cursor: page.truncated === true ? page.cursor : null,
  };
}

export function parseD1ExportResponse(payload) {
  if (!payload || payload.success !== true || !payload.result) {
    throw new Error("Cloudflare D1 export API returned an unsuccessful response.");
  }

  // Cloudflare wraps the export response in the API envelope:
  // payload.result.status and payload.result.result.{filename,signed_url}.
  const envelope = payload.result;
  if (envelope.status === "error") {
    throw new Error(typeof envelope.error === "string" ? envelope.error : "D1 export failed.");
  }

  if (envelope.status === "complete") {
    const completed = envelope.result;
    if (!completed || typeof completed.signed_url !== "string" ||
        typeof completed.filename !== "string") {
      throw new Error("Completed D1 export response is missing its SQL download details.");
    }
    return {
      status: "complete",
      bookmark: envelope.at_bookmark || null,
      filename: completed.filename,
      signedUrl: completed.signed_url,
    };
  }

  if (typeof envelope.at_bookmark === "string" && envelope.at_bookmark) {
    return { status: "running", bookmark: envelope.at_bookmark };
  }

  throw new Error("Cloudflare D1 export response contains neither a polling bookmark nor a completed SQL file.");
}
