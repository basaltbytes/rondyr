import { readdir } from "node:fs/promises";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

import { testOrigin, testSecretsKey, testSetupToken } from "./tests/integration/auth-fixture.ts";
import wrangler from "./wrangler.json" with { type: "json" };

// Workers AI for the tests. A submission with `fixture-verdict: accept` gets low
// spam and high relevance scores from Jev; any other answer does not decode,
// so the classifier quarantines it with `classification-error`, as it does
// without an AI binding.
const workersAiFixture = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class Ai extends WorkerEntrypoint {
  run(model, input) {
    if (model !== "typesafe/jev" || input?.state?.submission_fields?.["fixture-verdict"] !== "accept") {
      return {};
    }
    const answers = { spam: { type: "noul", noul: 0.02 } };
    if (input.questions.relevance !== undefined) answers.relevance = { type: "noul", noul: 0.98 };
    return { model: "workerd-fixture", answers };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

// A webhook recipient for the tests. It records every request, which tests read
// back from GET /__received?prefix=..., and answers by the last path segment:
// ok (204), fail-once (500, then 200), bad-request (400), redirect (307 to ok).
// The test Worker's outbound fetch goes here, whatever the hostname.
const webhookReceiverFixture = `
const received = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__received") {
      const prefix = url.searchParams.get("prefix") ?? "/";
      return Response.json(received.filter((entry) => entry.path.startsWith(prefix)));
    }
    received.push({
      url: url.href,
      path: url.pathname,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    const calls = received.filter((entry) => entry.path === url.pathname).length;
    switch (url.pathname.split("/").at(-1)) {
      case "ok":
        return new Response(null, { status: 204 });
      case "fail-once":
        return calls === 1
          ? new Response("Recipient body that Rondyr must not store", { status: 500 })
          : new Response("ok", { status: 200 });
      case "bad-request":
        return new Response("Recipient body that Rondyr must not store", { status: 400 });
      case "redirect":
        return new Response(null, { status: 307, headers: { location: new URL("ok", url).href } });
      default:
        return new Response(null, { status: 404 });
    }
  },
};
`;

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
              },
            },
            {
              name: "workers-ai-fixture",
              modules: true,
              script: workersAiFixture,
              compatibilityDate: wrangler.compatibility_date,
            },
            {
              name: "webhook-receiver-fixture",
              modules: true,
              script: webhookReceiverFixture,
              compatibilityDate: wrangler.compatibility_date,
            },
          ],
        },
      };
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
