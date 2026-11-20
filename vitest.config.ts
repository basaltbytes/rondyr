import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import wrangler from "./wrangler.json" with { type: "json" };

// Workers AI for the tests. A submission with `fixture-verdict: accept` gets low
// spam and high relevance scores from Jev, or a low relevance score when the
// business context contains `fixture-relevance: low`; any other answer does
// not decode, so the classifier quarantines it with `classification-error`, as
// it does without an AI binding. It records the submission fields of every
// call, which tests read back from GET /__calls.
const workersAiFixture = `
const calls = [];
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/__calls") return Response.json(calls);
    if (path !== "/ai-gateway/run") return new Response(null, { status: 404 });
    const model = request.headers.get("cf-consn-model-id");
    const { inputs: input } = await request.json();
    calls.push(input?.state?.submission_fields ?? null);
    if (model !== "typesafe/jev" || input?.state?.submission_fields?.["fixture-verdict"] !== "accept") {
      return Response.json({});
    }
    const answers = { spam: { type: "noul", noul: 0.02 } };
    const relevance = input.state.business_context.includes("fixture-relevance: low") ? 0.05 : 0.98;
    if (input.questions.relevance !== undefined) answers.relevance = { type: "noul", noul: relevance };
    return Response.json({ model: "workerd-fixture", answers });
  },
};
`;

// A webhook recipient for the tests. It records every request, which tests read
// back from GET /__received?prefix=..., and answers by the last path segment:
// ok (204), fail-once (500, then 200), bad-request (400), redirect (307 to ok).
// The test Worker's outbound fetch goes here, whatever the hostname. Requests to
// api.resend.com go on to the Resend fixture.
const webhookReceiverFixture = `
const received = [];
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "api.resend.com") return env.RESEND.fetch(request);
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

// The Resend API for the tests. It records every POST /emails, which tests read
// back from GET /__received?recipient=..., and answers by the local part of the
// first recipient: once-<status> answers <status> to the first request with an
// idempotency key and 200 to the next ones, always-<status> answers <status>
// every time, and any other address gets 200. Error bodies have the shape that
// https://resend.com/docs/api-reference/errors documents.
const resendFixture = `
const received = [];
const names = {
  400: "validation_error",
  401: "missing_api_key",
  403: "validation_error",
  409: "concurrent_idempotent_requests",
  422: "validation_error",
  429: "rate_limit_exceeded",
  500: "application_error",
};
const recipientsOf = (entry) => JSON.parse(entry.body).to ?? [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__received") {
      const recipient = url.searchParams.get("recipient");
      return Response.json(received.filter((entry) => recipientsOf(entry).includes(recipient)));
    }
    if (request.method !== "POST" || url.pathname !== "/emails") {
      return new Response(null, { status: 404 });
    }
    const entry = {
      url: url.href,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    };
    received.push(entry);
    const key = entry.headers["idempotency-key"];
    const first = received.filter((other) => other.headers["idempotency-key"] === key).length === 1;
    const [, mode, status] = /^(once|always)-([0-9]{3})@/u.exec(recipientsOf(entry)[0] ?? "") ?? [];
    if (mode === "always" || (mode === "once" && first)) {
      const code = Number(status);
      const name = names[code] ?? "application_error";
      const message = "Resend message that Rondyr must not store";
      return Response.json({ statusCode: code, name, message }, { status: code });
    }
    return Response.json({ id: crypto.randomUUID() });
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
              unsafeBindings: [
                {
                  name: "AI",
                  type: "rondyr-ai-fixture",
                  plugin: {
                    name: "rondyr-ai-fixture",
                    package: fileURLToPath(
                      new URL(
                        "./tests/integration/workers-ai-binding-fixture.mjs",
                        import.meta.url,
                      ),
                    ),
                  },
                  options: {},
                },
              ],
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
              serviceBindings: { RESEND: "resend-fixture" },
            },
            {
              name: "resend-fixture",
              modules: true,
              script: resendFixture,
              compatibilityDate: wrangler.compatibility_date,
            },
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
