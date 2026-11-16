const deploymentBranch = (import.meta as any).env?.CF_PAGES_BRANCH || "main";
const isPreviewDeployment = deploymentBranch !== "main";

export const GET = ({ site }: { site?: URL }) => {
  const sitemapUrl = new URL("/sitemap.xml", site ?? "https://paver-blocks.pages.dev").toString();
  const content = isPreviewDeployment
    ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;

  return new Response(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
};
