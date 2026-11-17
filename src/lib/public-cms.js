const configuredApiBase = import.meta.env.VITE_PUBLIC_API_BASE_URL || "";

function getApiOrigin() {
  if (!configuredApiBase) return null;
  try {
    const parsed = new URL(configuredApiBase);
    const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
        parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch { return null; }
}

const API_ORIGIN = getApiOrigin();

async function fetchPublicData(path) {
  if (!API_ORIGIN || !/^\/api\/public\/[a-z0-9/-]+$/.test(path)) return null;
  try {
    const response = await fetch(new URL(path, API_ORIGIN), {
      method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const result = await response.json();
    return result && typeof result === "object" ? result.data ?? null : null;
  } catch {
    // Keep the approved static page content if the public API is unavailable.
    return null;
  }
}

const publicListCache = new Map();

export function fetchPublicList(path) {
  if (!publicListCache.has(path)) {
    publicListCache.set(path, fetchPublicData(path).then((data) => Array.isArray(data) ? data : []));
  }
  return publicListCache.get(path);
}

export async function fetchPublicProject(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  const data = await fetchPublicData("/api/public/projects/" + encodeURIComponent(slug));
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

export function publicProjectImageUrl(objectKey) {
  if (!API_ORIGIN || typeof objectKey !== "string" ||
      !/^projects\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(objectKey)) return "";
  return new URL("/media/" + objectKey, API_ORIGIN).toString();
}
