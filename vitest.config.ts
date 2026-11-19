import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.json" },
      miniflare: {
        bindings: {
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
