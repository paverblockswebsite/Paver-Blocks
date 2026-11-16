import { defineConfig } from "astro/config";

export default defineConfig({
  // Current production canonical domain. Update this single value when a custom domain is connected.
  site: "https://paver-blocks.pages.dev",
  output: "static",
  vite: { envPrefix: ["VITE_", "CF_PAGES_"] }
});
