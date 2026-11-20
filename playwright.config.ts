import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    browserName: "chromium",
    // The external form runs on local HTTPS because success URLs require HTTPS.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
});
