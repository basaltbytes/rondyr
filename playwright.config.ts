import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    browserName: "chromium",
    // The dashboard follows the language of the browser. The tests read it in English.
    locale: "en-GB",
    // The external form runs on local HTTPS because success URLs require HTTPS.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
});
