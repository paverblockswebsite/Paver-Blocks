const MAX_BYTES = 5 * 1024 * 1024;
const FORM_OVERHEAD = 64 * 1024;
const FORMATS = {
  "image/jpeg": { ext: "jpg", valid: (b) => b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
  "image/png": { ext: "png", valid: (b) => b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10 },
  "image/webp": { ext: "webp", valid: (b) => b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP" },
};

async function readBoundedForm(request, maximumBytes) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function uploadProjectImage(request, env, projectId, identity, respond) {
  const bucket = env.PROJECT_IMAGES;
  if (!bucket || typeof bucket.put !== "function") return respond(request, env, { error: "Project image storage is not configured yet." }, 503);
  const length = request.headers.get("content-length");
  if (!length || !/^\d+$/.test(length) || Number(length) > MAX_BYTES + FORM_OVERHEAD) {
    return respond(request, env, { error: "Image upload must include a valid size and be no larger than 5 MB." }, 413);
  }
  if ((request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "multipart/form-data") {
    return respond(request, env, { error: "Use a multipart form upload." }, 415);
  }
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ? LIMIT 1").bind(projectId).first();
  if (!project) return respond(request, env, { error: "Project not found." }, 404);
  const boundedBody = await readBoundedForm(request, MAX_BYTES + FORM_OVERHEAD);
  if (!boundedBody) return respond(request, env, { error: "The image upload is too large or could not be read." }, 413);
  let form;
  try {
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") },
      body: boundedBody,
    });
    form = await boundedRequest.formData();
  } catch { return respond(request, env, { error: "The upload form could not be read." }, 400); }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function" || typeof file.size !== "number" || file.size < 1 || file.size > MAX_BYTES) {
    return respond(request, env, { error: "Choose one image file up to 5 MB." }, 400);
  }
  const altText = form.get("alt_text");
  const caption = form.get("caption") ?? "";
  if (typeof altText !== "string" || !altText.trim() || altText.trim().length > 250 || typeof caption !== "string" || caption.trim().length > 300) {
    return respond(request, env, { error: "Provide accessible alt text and a caption of up to 300 characters." }, 400);
  }
  const format = FORMATS[file.type];
  if (!format) return respond(request, env, { error: "Only JPEG, PNG, and WebP images are accepted." }, 415);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || !format.valid(bytes)) return respond(request, env, { error: "The file contents do not match a supported image format." }, 415);
  const imageId = crypto.randomUUID();
  const objectKey = "projects/" + projectId + "/" + imageId + "." + format.ext;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { projectId, imageId },
  });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO project_images (id, project_id, object_key, alt_text, caption, sort_order) VALUES (?, ?, ?, ?, ?, ?)").bind(imageId, projectId, objectKey, altText.trim(), caption.trim() || null, 0),
      env.DB.prepare("INSERT INTO admin_audit_log (id, admin_email, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), identity.email, "upload", "project_image", imageId),
    ]);
  } catch (error) {
    try { await bucket.delete(objectKey); } catch {}
    throw error;
  }
  return respond(request, env, { success: true, data: { id: imageId, project_id: projectId, object_key: objectKey, alt_text: altText.trim(), caption: caption.trim() || null } }, 201);
}

export async function serveProjectImage(request, env, url, respond) {
  if (request.method !== "GET") return respond(request, env, { error: "Method not allowed." }, 405, { allow: "GET" });
  const bucket = env.PROJECT_IMAGES;
  if (!bucket || typeof bucket.get !== "function") return respond(request, env, { error: "Project image storage is not configured yet." }, 503);
  const key = url.pathname.slice("/media/".length);
  const match = key.match(/^projects\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpg|png|webp)$/i);
  if (!match) return respond(request, env, { error: "Not found." }, 404);
  const approved = await env.DB.prepare(
    "SELECT pi.object_key FROM project_images pi INNER JOIN projects p ON p.id = pi.project_id WHERE pi.id = ? AND pi.project_id = ? AND p.status = 'published' LIMIT 1",
  ).bind(match[2], match[1]).first();
  if (!approved || approved.object_key !== key) return respond(request, env, { error: "Not found." }, 404);
  const object = await bucket.get(key);
  if (!object || !Object.keys(FORMATS).includes(object.httpMetadata?.contentType)) return respond(request, env, { error: "Not found." }, 404);
  return new Response(object.body, { headers: {
    "content-type": object.httpMetadata.contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    etag: object.httpEtag,
  } });
}
