import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://paverblocks.com.pk",
  output: "static",
  vite: { envPrefix: ["VITE_", "CF_PAGES_"] }
});
