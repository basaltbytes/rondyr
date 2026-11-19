import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { testOrigin, testSetupToken } from "./tests/integration/auth-fixture.ts";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.json" },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "workerd-test-only-better-auth-secret-8ea101",
          BETTER_AUTH_URL: testOrigin,
          RONDYR_SETUP_TOKEN: testSetupToken,
          TEST_MIGRATIONS: await readD1Migrations({
            migrationsDir: "database/migrations",
            migrationsPattern: "database/migrations/*/migration.sql",
          }),
        },
      },
    })),
  ],
  test: { include: ["tests/**/*.test.ts", "src/**/*.test.ts"] },
});
