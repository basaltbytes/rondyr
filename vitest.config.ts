import { readdir } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

import { testOrigin, testSetupToken } from "./tests/integration/auth-fixture.ts";
import wrangler from "./wrangler.json" with { type: "json" };

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const {
        workerOptions: { modulesRules: _rules, ...workerOptions },
      } = unstable_getMiniflareWorkerOptions("./wrangler.json");
      const files = await readdir("./dist/rondyr", { recursive: true });
      const chunks = files.filter((file) => file !== "index.js" && file.endsWith(".js"));
      const modules = ["index.js", ...chunks].map((path) => ({ type: "ESModule" as const, path }));
      return {
        remoteBindings: false,
        miniflare: {
          compatibilityDate: wrangler.compatibility_date,
          compatibilityFlags: wrangler.compatibility_flags,
          d1Databases: Object.fromEntries(
            wrangler.d1_databases.map(({ binding, database_id }) => [binding, database_id]),
          ),
          queueProducers: Object.fromEntries(
            wrangler.queues.producers.map(({ binding, queue }) => [binding, queue]),
          ),
          serviceBindings: { TEST_WORKER: "rondyr-test-app" },
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations({
              migrationsDir: "database/migrations",
              migrationsPattern: "database/migrations/*/migration.sql",
            }),
          },
          // A native worker lets Alchemy's Durable Object proxy dispatch its RPC methods.
          workers: [
            {
              ...workerOptions,
              name: "rondyr-test-app",
              rootPath: "./dist/rondyr",
              modules,
              bindings: {
                BETTER_AUTH_SECRET: "workerd-test-only-better-auth-secret-8ea101",
                BETTER_AUTH_URL: testOrigin,
                RONDYR_SETUP_TOKEN: testSetupToken,
              },
            },
          ],
        },
      };
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
