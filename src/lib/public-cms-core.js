const PUBLIC_PATH = /^\/api\/public\/[a-z0-9/-]+$/;
const PROJECT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_IMAGE_KEY = /^projects\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i;

export function resolvePublicApiOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
        parsed.pathname !== "/" || parsed.search || parsed.hash ||
        parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function selectPublicApiBase(configured, pagesBranch) {
  if (typeof configured === "string" && configured.trim()) return configured;
  return pagesBranch === "main"
    ? "https://paver-blocks-api.hellopaverblocks.workers.dev"
    : "https://paver-blocks-api-dev.hellopaverblocks.workers.dev";
}

export function createPublicCmsClient(apiBase, fetchImpl = fetch) {
  const origin = resolvePublicApiOrigin(apiBase);
  const listCache = new Map();

  async function fetchData(path) {
    if (!origin || typeof path !== "string" || !PUBLIC_PATH.test(path)) return null;
    try {
      const response = await fetchImpl(new URL(path, origin), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      const result = await response.json();
      return result && typeof result === "object" ? result.data ?? null : null;
    } catch {
      return null;
    }
  }

  function fetchPublicList(path) {
    if (!listCache.has(path)) {
      listCache.set(path, fetchData(path).then((data) => Array.isArray(data) ? data : []));
    }
    return listCache.get(path);
  }

  async function fetchPublicProject(slug) {
    if (typeof slug !== "string" || !PROJECT_SLUG.test(slug)) return null;
    const data = await fetchData("/api/public/projects/" + encodeURIComponent(slug));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  }

  function publicProjectImageUrl(objectKey) {
    if (!origin || typeof objectKey !== "string" || !PROJECT_IMAGE_KEY.test(objectKey)) return "";
    return new URL("/media/" + objectKey, origin).toString();
  }

  return { fetchPublicList, fetchPublicProject, publicProjectImageUrl };
}
