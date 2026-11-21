import { readFileSync } from "node:fs";
import { isDeepStrictEqual, parseEnv } from "node:util";

import { queueNameVars } from "../worker-config.ts";

// The root wrangler.json is the deployment definition: the Deploy to Cloudflare button
// and `pnpm run deploy` read it. The Alchemy stack, the second supported way to deploy,
// reads it too; these checks fail when the two definitions drift apart.
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pkg = JSON.parse(read("../package.json"));
const rootPkg = JSON.parse(read("../../../package.json"));
const wrangler = JSON.parse(read("../../../wrangler.json"));
const workerEntry = read("../src/worker.ts");
const deployPrompts = parseEnv(read("../../../.dev.vars.example"));
const alchemyWorker = readFileSync(new URL("../src/alchemy-worker.ts", import.meta.url), "utf8");
const alchemyRun = readFileSync(new URL("../alchemy-run.ts", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");
// The versions live in the default catalog of pnpm-workspace.yaml; the manifest says `catalog:`.
const catalog = Object.fromEntries(
  [
    ...(/^catalog:\n((?: {2}.+\n)+)/mu.exec(workspace)?.[1] ?? "").matchAll(
      /^ {2}"?([^":]+)"?: (.+)$/gmu,
    ),
  ].map(([, name, version]) => [name, version]),
);
const dependencies = Object.fromEntries(
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).map(([name, specifier]) => [
    name,
    specifier === "catalog:" ? catalog[name] : specifier,
  ]),
);
const expectedBindings = ["CLASSIFICATION_QUEUE", "DELIVERY_QUEUE"];
// Each queue's dead-letter queue, as alchemy-run.ts names its resource and its consumer.
const deadLetters = {
  CLASSIFICATION_QUEUE: {
    queue: "classificationDeadLetterQueue",
    consumer: "ClassificationDeadLetterConsumer",
  },
  DELIVERY_QUEUE: { queue: "deliveryDeadLetterQueue", consumer: "DeliveryDeadLetterConsumer" },
};
const errors = [];

for (const name of ["@effect/platform-node", "@effect/vitest"]) {
  if (dependencies[name] !== dependencies.effect) {
    errors.push(`Pin ${name} to the version of effect.`);
  }
}

for (const name of ["@alchemy.run/cloudflare", "@alchemy.run/domain"]) {
  if (dependencies[name] !== dependencies.alchemy) {
    errors.push(`Pin ${name} to the version of alchemy.`);
  }
}

const { d1_databases: databases, queues, vars = {} } = wrangler;
const queueNames = queueNameVars(queues);
if (databases.length !== 1 || databases[0]?.binding !== "DB" || databases[0]?.remote) {
  errors.push("Wrangler must use one local D1 binding named DB.");
}
for (const binding of expectedBindings) {
  const producer = queues.producers.find((candidate) => candidate.binding === binding);
  if (producer === undefined || producer.remote) {
    errors.push(`Wrangler must use a local producer binding named ${binding}.`);
    continue;
  }
  // The queue handler dispatches a batch by the name of its queue. The build derives the
  // variable from the queue configuration, so a renamed queue cannot leave it behind.
  if (queueNames[`${binding}_NAME`] !== producer.queue || `${binding}_NAME` in vars) {
    errors.push(`Wrangler must derive ${binding}_NAME from the queue, not set it in vars.`);
  }
  if (!alchemyWorker.includes(`${binding}_NAME:`)) {
    errors.push(`src/alchemy-worker.ts must pass ${binding}_NAME to the Worker.`);
  }
  const consumer = queues.consumers?.find((candidate) => candidate.queue === producer.queue);
  if (consumer === undefined || !consumer.dead_letter_queue) {
    errors.push(`Wrangler must consume ${producer.queue} with a dead-letter queue.`);
    continue;
  }

  // A dead-letter queue has a consumer that logs and acknowledges each message, and the
  // queue handler recognizes its batches by name.
  const deadLetterQueue = consumer.dead_letter_queue;
  const deadLetterName = binding.replace(/_QUEUE$/u, "_DEAD_LETTER_QUEUE_NAME");
  const deadLetterConsumer = queues.consumers.find(
    (candidate) => candidate.queue === deadLetterQueue,
  );
  if (deadLetterConsumer === undefined || deadLetterConsumer.dead_letter_queue) {
    errors.push(
      `Wrangler must consume ${deadLetterQueue}, without a dead-letter queue of its own.`,
    );
  }
  if (queueNames[deadLetterName] !== deadLetterQueue || deadLetterName in vars) {
    errors.push(`Wrangler must derive ${deadLetterName} from the queue, not set it in vars.`);
  }
  if (!alchemyWorker.includes(`${deadLetterName}:`)) {
    errors.push(`src/alchemy-worker.ts must pass ${deadLetterName} to the Worker.`);
  }
  const { queue: resource, consumer: consumerName } = deadLetters[binding];
  const consumerDeclaration = new RegExp(
    `Consumer\\("${consumerName}",\\s*\\{\\s*queueId: \\w+\\.queueId`,
    "u",
  );
  if (!alchemyRun.includes(`yield* ${resource};`) || !consumerDeclaration.test(alchemyRun)) {
    errors.push(
      `alchemy-run.ts must declare the ${consumerName} consumer of the ${resource} resource.`,
    );
  }
  // The Alchemy consumers take their batch size, wait and retries from wrangler.json.
  for (const kind of ["queue", "dead-letter"]) {
    if (!alchemyRun.includes(`consumerSettings("${binding}", "${kind}")`)) {
      errors.push(`alchemy-run.ts must read the ${kind} consumer settings of ${binding}.`);
    }
  }
}

// The intake limits each client, and the dashboard the test messages of each
// destination, through Rate Limiting bindings. A namespace is account-wide, so
// each limit has its own, and a period other than 10 or 60 seconds is refused at deploy.
const rateLimits = wrangler.ratelimits ?? [];
for (const name of ["CLIENT_RATE_LIMIT", "TARGET_TEST_RATE_LIMIT"]) {
  const rateLimit = rateLimits.find((candidate) => candidate.name === name);
  if (
    rateLimit === undefined ||
    !/^[1-9][0-9]*$/u.test(rateLimit.namespace_id) ||
    ![10, 60].includes(rateLimit.simple?.period)
  ) {
    errors.push(
      `Wrangler must declare the ${name} rate limit with a namespace and a period of 10 or 60.`,
    );
  }
  if (!alchemyWorker.includes(`${name}:`)) {
    errors.push(`src/alchemy-worker.ts must pass ${name} to the Worker.`);
  }
}
if (
  new Set(rateLimits.map(({ namespace_id: namespace }) => namespace)).size !== rateLimits.length
) {
  errors.push("Wrangler must give each rate limit its own namespace.");
}

// Each Durable Object class is declared in the declarative `exports` map, with SQLite
// storage, and exported by the Worker's entry. Cloudflare refuses a Worker that mixes
// `exports` with the older `migrations` list.
if (wrangler.migrations !== undefined) {
  errors.push("Wrangler must declare the Durable Object classes in exports, not migrations.");
}
const entryExports = new Set(
  (/^export \{([^}]*)\};/mu.exec(workerEntry)?.[1] ?? "").split(",").map((name) => name.trim()),
);
for (const { class_name: className } of wrangler.durable_objects?.bindings ?? []) {
  const declared = wrangler.exports?.[className];
  if (declared?.type !== "durable-object" || declared.storage !== "sqlite") {
    errors.push(`Wrangler must export the Durable Object class ${className} with SQLite storage.`);
  }
  if (!entryExports.has(className)) {
    errors.push(`src/worker.ts must export the Durable Object class ${className}.`);
  }
}

// Workers AI runs the default classifier; without the binding every message waits in
// quarantine. Alchemy binds it outside local development.
if (wrangler.ai?.binding !== "AI" || !alchemyWorker.includes("AI: Cloudflare.Workers.AI()")) {
  errors.push("Wrangler and src/alchemy-worker.ts must bind Workers AI as AI.");
}
if (!alchemyWorker.includes("flags: wrangler.compatibility_flags")) {
  errors.push("src/alchemy-worker.ts must read the compatibility flags of wrangler.json.");
}

// A deployment from the Deploy to Cloudflare button: no preview URL serves an old version
// against the live data, variables set in the dashboard survive a redeploy, and no secret
// is required, since every new setting stays optional at deployment.
if (wrangler.preview_urls !== false) errors.push("Wrangler must set preview_urls to false.");
if (wrangler.keep_vars !== true) errors.push("Wrangler must set keep_vars to true.");
if (wrangler.secrets !== undefined) errors.push("Wrangler must not declare required secrets.");
if (wrangler.routes !== undefined || wrangler.route !== undefined) {
  errors.push("Wrangler must not declare routes: a custom domain is added in the dashboard.");
}
// The button runs the root deploy script, which applies the migrations and deploys with
// Wrangler. Alchemy keeps its own script name.
if (rootPkg.scripts?.deploy !== "pnpm --filter rondyr run deploy") {
  errors.push('The root deploy script must be "pnpm --filter rondyr run deploy".');
}
if (!pkg.scripts?.deploy?.endsWith("node scripts/deploy-cloudflare.mjs")) {
  errors.push("The deploy script of apps/rondyr must run scripts/deploy-cloudflare.mjs.");
}
// The button prompts for the secrets of .dev.vars.example, with the descriptions of the
// root package.json.
for (const name of Object.keys(deployPrompts)) {
  if (!rootPkg.cloudflare?.bindings?.[name]?.description) {
    errors.push(`The root package.json must describe ${name} in cloudflare.bindings.`);
  }
}

// Wrangler doesn't inherit bindings or vars into a named environment, so each
// environment repeats them and must change with the top level.
const repeatedKeys = ["ai", "d1_databases", "queues", "ratelimits", "durable_objects", "workflows"];
for (const [name, environment] of Object.entries(wrangler.env ?? {})) {
  for (const key of repeatedKeys) {
    if (!isDeepStrictEqual(environment[key], wrangler[key])) {
      errors.push(`Wrangler environment ${name} must repeat the top-level ${key} unchanged.`);
    }
  }
  for (const variable of Object.keys(queueNames)) {
    if (variable in (environment.vars ?? {})) {
      errors.push(`Wrangler environment ${name} must not set ${variable}: the build derives it.`);
    }
  }
  for (const [variable, value] of Object.entries(vars)) {
    if (environment.vars?.[variable] !== value) {
      errors.push(
        `Wrangler environment ${name} must set ${variable} to "${value}", as the top level does.`,
      );
    }
  }
}

// Local development with Cloudflare's email simulator uses the cloudflare-email
// environment; the top level keeps the default provider, Resend.
const cloudflareEmail = wrangler.env?.["cloudflare-email"];
if (!cloudflareEmail?.send_email?.some(({ name }) => name === "CLOUDFLARE_EMAIL")) {
  errors.push(
    "Wrangler environment cloudflare-email must declare the send_email binding CLOUDFLARE_EMAIL.",
  );
}
if (cloudflareEmail?.vars?.RONDYR_EMAIL_PROVIDER !== "cloudflare") {
  errors.push(
    'Wrangler environment cloudflare-email must set RONDYR_EMAIL_PROVIDER to "cloudflare".',
  );
}
if (wrangler.send_email !== undefined) {
  errors.push("Wrangler must not declare send_email at the top level.");
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Rondyr configuration checks passed.\n");
}
