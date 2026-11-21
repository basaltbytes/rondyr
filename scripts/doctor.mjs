import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
const alchemyWorker = readFileSync(new URL("../src/alchemy-worker.ts", import.meta.url), "utf8");
const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
const expectedBindings = ["CLASSIFICATION_QUEUE", "DELIVERY_QUEUE"];
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
if (databases.length !== 1 || databases[0]?.binding !== "DB" || databases[0]?.remote) {
  errors.push("Wrangler must use one local D1 binding named DB.");
}
for (const binding of expectedBindings) {
  const producer = queues.producers.find((candidate) => candidate.binding === binding);
  if (producer === undefined || producer.remote) {
    errors.push(`Wrangler must use a local producer binding named ${binding}.`);
    continue;
  }
  // The queue handler dispatches a batch by the name of its queue.
  if (vars[`${binding}_NAME`] !== producer.queue) {
    errors.push(`Wrangler must set ${binding}_NAME to the queue "${producer.queue}".`);
  }
  if (!alchemyWorker.includes(`${binding}_NAME:`)) {
    errors.push(`src/alchemy-worker.ts must pass ${binding}_NAME to the Worker.`);
  }
  const consumer = queues.consumers?.find((candidate) => candidate.queue === producer.queue);
  if (consumer === undefined || !consumer.dead_letter_queue) {
    errors.push(`Wrangler must consume ${producer.queue} with a dead-letter queue.`);
  }
}

// The intake limits each client through a Rate Limiting binding. Its namespace is
// account-wide, and a period other than 10 or 60 seconds is refused at deploy.
const rateLimit = (wrangler.ratelimits ?? []).find(({ name }) => name === "CLIENT_RATE_LIMIT");
if (
  rateLimit === undefined ||
  !/^[1-9][0-9]*$/u.test(rateLimit.namespace_id) ||
  ![10, 60].includes(rateLimit.simple?.period)
) {
  errors.push(
    "Wrangler must declare the CLIENT_RATE_LIMIT rate limit with a namespace and a period of 10 or 60.",
  );
}
if (!alchemyWorker.includes("CLIENT_RATE_LIMIT:")) {
  errors.push("src/alchemy-worker.ts must pass CLIENT_RATE_LIMIT to the Worker.");
}

// A Durable Object class needs a migration tag that creates it.
const migrated = new Set(
  (wrangler.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? []),
);
for (const { class_name: className } of wrangler.durable_objects?.bindings ?? []) {
  if (!migrated.has(className)) {
    errors.push(`Wrangler must create the Durable Object class ${className} in a migration.`);
  }
}

// Wrangler doesn't inherit bindings or vars into a named environment, so each
// environment repeats them and must change with the top level.
const repeatedKeys = ["d1_databases", "queues", "ratelimits", "durable_objects", "workflows"];
for (const [name, environment] of Object.entries(wrangler.env ?? {})) {
  for (const key of repeatedKeys) {
    if (!isDeepStrictEqual(environment[key], wrangler[key])) {
      errors.push(`Wrangler environment ${name} must repeat the top-level ${key} unchanged.`);
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
