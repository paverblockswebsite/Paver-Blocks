import type { APIRoute } from "astro";

const routes = [
  "/", "/about/", "/services/", "/services/paver-block-installation/",
  "/services/road-construction/", "/services/footpath-construction/",
  "/services/parking-area-construction/", "/services/industrial-flooring/",
  "/services/contracts/", "/paver-designs/", "/projects/", "/faqs/", "/get-a-quote/", "/contact/"
];

export const GET: APIRoute = () => {
  const urls = routes.map((route) => `<url><loc>https://paverblocks.com.pk${route}</loc></url>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};