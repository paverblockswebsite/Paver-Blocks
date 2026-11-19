import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browserstack",
  testMatch: "**/*.spec.js",
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SITE_BASE_URL || "https://paver-blocks.pages.dev",
    headless: true,
    navigationTimeout: 45_000
  }
});
