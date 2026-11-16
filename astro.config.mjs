import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://paver-blocks.pages.dev",
  output: "static",
  vite: { envPrefix: ["VITE_", "CF_PAGES_"] }
});
