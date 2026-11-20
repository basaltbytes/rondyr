import { readdir } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

import {
  testEmailFrom,
  testOrigin,
  testResendKey,
  testSecretsKey,
  testSetupToken,
} from "./tests/integration/auth-fixture.ts";
import { externalWorkers } from "./tests/integration/external-workers.ts";
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
          serviceBindings: {
            TEST_WORKER: "rondyr-test-app",
            WEBHOOK_RECEIVER: "webhook-receiver-fixture",
            RESEND_FIXTURE: "resend-fixture",
            WORKERS_AI_FIXTURE: "workers-ai-fixture",
          },
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
              serviceBindings: { AI: { name: "workers-ai-fixture", entrypoint: "Ai" } },
              outboundService: "webhook-receiver-fixture",
              bindings: {
                ...wrangler.vars,
                BETTER_AUTH_SECRET: "workerd-test-only-better-auth-secret-8ea101",
                BETTER_AUTH_URL: testOrigin,
                RONDYR_SETUP_TOKEN: testSetupToken,
                RONDYR_SECRETS_KEY: testSecretsKey,
                RESEND_API_KEY: testResendKey,
                RONDYR_EMAIL_FROM: testEmailFrom,
              },
            },
            ...externalWorkers(wrangler.compatibility_date),
          ],
        },
      };
    }),
  ],
  test: {
    projects: [
      { extends: true, test: { name: "workerd", include: ["src/**/*.test.ts"] } },
      // The evaluation harness runs in Node, outside the Worker.
      "./evals/vitest.config.ts",
    ],
  },
});
