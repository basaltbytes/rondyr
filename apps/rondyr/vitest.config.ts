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
import { externalWorkers, workersAiBinding } from "./tests/integration/external-workers.ts";
import {
  queueNameVars,
  type QueueNameVars,
  wrangler,
  wranglerConfigPath,
} from "./worker-config.ts";

const escalationWorkers = [
  { binding: "ESCALATION_WORKER", name: "rondyr-test-escalation", classifier: "openai" },
  { binding: "SAME_CLASSIFIER_WORKER", name: "rondyr-test-same-classifier", classifier: "jev" },
] as const;

// Collect actual console entries and uncaught exceptions from the built Worker.
const workerLogFixture = `
const entries = [];
export default {
  fetch: () => Response.json(entries),
  tail(traces) {
    for (const { logs, exceptions } of traces) entries.push(...logs, ...exceptions);
  },
};
`;

const cloudflareEmailBinding = {
  name: "CLOUDFLARE_EMAIL",
  type: "rondyr-email-fixture",
  plugin: {
    name: "rondyr-email-fixture",
    package: fileURLToPath(
      new URL("./tests/integration/cloudflare-email-binding-fixture.mjs", import.meta.url),
    ),
  },
  options: {},
};
const cloudflareEmailDatabase = "00000000-0000-0000-0000-000000000033";

const cloudflareEmailFixture = `
const received = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__received") {
      const recipient = url.searchParams.get("recipient");
      return Response.json(received.filter(({ to }) => to.includes(recipient)));
    }
    const message = await request.json();
    const recipient = message.to[0];
    received.push(message);
    const attempts = received.filter(({ to }) => to[0] === recipient).length;
    let code;
    if (recipient.startsWith("rate-limit-once@") && attempts === 1) code = "E_RATE_LIMIT_EXCEEDED";
    if (recipient.startsWith("suppressed@")) code = "E_RECIPIENT_SUPPRESSED";
    if (recipient.startsWith("unknown-error@")) code = message.text;
    if (code !== undefined) return Response.json({ code, message: message.text }, { status: 400 });
    return Response.json({ messageId: crypto.randomUUID() });
  },
};
`;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const {
        // Workers AI is the fixture of tests/integration/external-workers.ts.
        workerOptions: { modulesRules: _rules, ai: _ai, ...workerOptions },
      } = unstable_getMiniflareWorkerOptions(wranglerConfigPath);
      const files = await readdir("./dist/rondyr", { recursive: true });
      const chunks = files.filter((file) => file !== "index.js" && file.endsWith(".js"));
      const modules = ["index.js", ...chunks].map((path) => ({ type: "ESModule" as const, path }));
      const worker = {
        ...workerOptions,
        rootPath: "./dist/rondyr",
        modules,
        outboundService: "webhook-receiver-fixture",
        tails: ["worker-log-fixture"],
      };
      const queueNames = queueNameVars(wrangler.queues);
      const queueName = (variable: keyof QueueNameVars) => {
        const name = queueNames[variable];
        if (name === undefined) throw new Error(`wrangler.json names no queue for ${variable}`);
        return name;
      };
      const bindings = {
        ...queueNames,
        BETTER_AUTH_SECRET: "workerd-test-only-better-auth-secret-8ea101",
        BETTER_AUTH_URL: testOrigin,
        RONDYR_SETUP_TOKEN: testSetupToken,
        RONDYR_EMAIL_FROM: testEmailFrom,
      };
      const queueProducers = Object.fromEntries(
        wrangler.queues.producers.map(({ binding, queue }) => [binding, queue]),
      );
      // The tests send messages to the dead-letter queues, which the Worker consumes.
      const deadLetterProducers = {
        CLASSIFICATION_DEAD_LETTER_QUEUE: queueName("CLASSIFICATION_DEAD_LETTER_QUEUE_NAME"),
        DELIVERY_DEAD_LETTER_QUEUE: queueName("DELIVERY_DEAD_LETTER_QUEUE_NAME"),
      };
      return {
        remoteBindings: false,
        miniflare: {
          compatibilityDate: wrangler.compatibility_date,
          compatibilityFlags: wrangler.compatibility_flags,
          d1Databases: Object.fromEntries([
            // Wrangler names a local database without an ID after its binding.
            ...wrangler.d1_databases.map(({ binding }) => [binding, binding]),
            ["CLOUDFLARE_EMAIL_DB", cloudflareEmailDatabase],
          ]),
          queueProducers: { ...queueProducers, ...deadLetterProducers },
          durableObjects: {
            "Submissions.SubmissionAggregate": {
              className: "SubmissionAggregate",
              scriptName: "rondyr-test-app",
            },
          },
          serviceBindings: {
            TEST_WORKER: "rondyr-test-app",
            CLOUDFLARE_EMAIL_WORKER: "rondyr-test-cloudflare-email",
            KEYLESS_WORKER: "rondyr-test-keyless",
            DERIVED_ORIGIN_WORKER: "rondyr-test-derived-origin",
            CLOUDFLARE_EMAIL_FIXTURE: "cloudflare-email-fixture",
            WEBHOOK_RECEIVER: "webhook-receiver-fixture",
            RESEND_FIXTURE: "resend-fixture",
            WORKERS_AI_FIXTURE: "workers-ai-fixture",
            SITEVERIFY_FIXTURE: "siteverify-fixture",
            WORKER_LOGS: "worker-log-fixture",
            ...Object.fromEntries(escalationWorkers.map(({ binding, name }) => [binding, name])),
          },
          unsafeBindings: [cloudflareEmailBinding],
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations({
              migrationsDir: "database/migrations",
              migrationsPattern: "database/migrations/*/migration.sql",
            }),
          },
          // A native worker lets Alchemy's Durable Object proxy dispatch its RPC methods.
          workers: [
            {
              ...worker,
              name: "rondyr-test-app",
              unsafeBindings: [workersAiBinding],
              bindings: {
                ...bindings,
                RESEND_API_KEY: testResendKey,
                RONDYR_SECRETS_KEY: testSecretsKey,
              },
            },
            {
              ...worker,
              name: "rondyr-test-cloudflare-email",
              d1Databases: { DB: cloudflareEmailDatabase },
              queueConsumers: {},
              unsafeBindings: [cloudflareEmailBinding],
              bindings: {
                ...bindings,
                RONDYR_EMAIL_PROVIDER: "cloudflare",
                RONDYR_SECRETS_KEY: testSecretsKey,
              },
            },
            {
              ...worker,
              name: "rondyr-test-keyless",
              queueConsumers: {},
              bindings,
            },
            // A deployment from the Deploy to Cloudflare button before its owner chose a
            // setup token: no BETTER_AUTH_URL, so the origin is the request's.
            {
              ...worker,
              name: "rondyr-test-derived-origin",
              queueConsumers: {},
              bindings: {
                ...queueNames,
                BETTER_AUTH_SECRET: "workerd-test-only-derived-origin-secret-5b2e07",
              },
            },
            ...escalationWorkers.map(({ name, classifier }) => {
              const queue = `${name}-classification`;
              return {
                ...worker,
                name,
                queueProducers: { ...queueProducers, CLASSIFICATION_QUEUE: queue },
                queueConsumers: { [queue]: { maxBatchTimeout: 1 } },
                unsafeBindings: [workersAiBinding],
                bindings: {
                  ...bindings,
                  CLASSIFICATION_QUEUE_NAME: queue,
                  RONDYR_ESCALATION_CLASSIFIER: classifier,
                },
              };
            }),
            ...externalWorkers(wrangler.compatibility_date),
            {
              name: "cloudflare-email-fixture",
              modules: true,
              script: cloudflareEmailFixture,
              compatibilityDate: wrangler.compatibility_date,
            },
            {
              name: "worker-log-fixture",
              modules: true,
              script: workerLogFixture,
              compatibilityDate: wrangler.compatibility_date,
            },
          ],
        },
      };
    }),
  ],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "workerd",
          // The EmDash plugin's contract tests run its code against the built Worker.
          // Its unit tests run in Node with the plugin's own Vitest configuration.
          include: ["src/**/*.test.ts", "../../packages/emdash-plugin/test/**/*.test.ts"],
        },
      },
      // The evaluation harness runs in Node, outside the Worker.
      "./evals/vitest.config.ts",
      // The dashboard's calculations run in Node, without a DOM.
      "./dashboard/vitest.config.ts",
    ],
  },
});
