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
  const result = payload.result;
  if (result.status === "error") {
    throw new Error(typeof result.error === "string" ? result.error : "D1 export failed.");
  }
  if (typeof result.signed_url === "string" && typeof result.filename === "string") {
    return { status: "complete", bookmark: result.at_bookmark || null, filename: result.filename, signedUrl: result.signed_url };
  }
  if (typeof result.at_bookmark === "string" && result.at_bookmark) {
    return { status: "running", bookmark: result.at_bookmark };
  }
  throw new Error("Cloudflare D1 export response contains neither a polling bookmark nor a downloadable SQL file.");
}
