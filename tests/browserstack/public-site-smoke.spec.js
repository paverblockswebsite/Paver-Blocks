import { test, expect } from "@playwright/test";

const publicRoutes = [
  "/",
  "/about/",
  "/services/",
  "/get-a-quote/",
  "/contact/",
  "/paver-designs/",
  "/projects/",
  "/faqs/",
  "/privacy-policy/",
  "/terms-and-conditions/",
  "/services/paver-block-installation/",
  "/services/road-construction/",
  "/services/footpath-construction/",
  "/services/parking-area-construction/",
  "/services/industrial-flooring/",
  "/services/contracts/",
  "/paver-designs/i-shape/",
  "/paver-designs/zigzag/",
  "/paver-designs/rectangular/",
  "/paver-designs/uni-paver/"
];

test("public website routes load with a title, H1, and canonical URL", async ({ page, baseURL }) => {
  expect(baseURL, "SITE_BASE_URL must be configured").toBeTruthy();

  for (const route of publicRoutes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });

    expect(response, `No HTTP response for ${route}`).not.toBeNull();
    expect(response.status(), `Unexpected HTTP status for ${route}`).toBe(200);

    await expect(page).toHaveTitle(/.+/, { timeout: 15_000 });
    await expect(page.locator("h1").first(), `Missing visible H1 on ${route}`).toBeVisible();

    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical, `Missing canonical URL on ${route}`).toHaveCount(1);
    await expect(canonical).toHaveAttribute("href", /^https:\/\//);
  }
});
