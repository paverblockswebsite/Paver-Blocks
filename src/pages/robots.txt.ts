const deploymentBranch = (import.meta as any).env?.CF_PAGES_BRANCH || "main";
const isPreviewDeployment = deploymentBranch !== "main";

export const GET = () => {
  const content = isPreviewDeployment
    ? "User-agent: *\nDisallow: /\n"
    : "User-agent: *\nAllow: /\n\nSitemap: https://paverblocks.com.pk/sitemap.xml\n";

  return new Response(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
};
