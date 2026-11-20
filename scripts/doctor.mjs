import { readFileSync } from "node:fs";

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

// A Durable Object class needs a migration tag that creates it.
const migrated = new Set(
  (wrangler.migrations ?? []).flatMap((migration) => migration.new_sqlite_classes ?? []),
);
for (const { class_name: className } of wrangler.durable_objects?.bindings ?? []) {
  if (!migrated.has(className)) {
    errors.push(`Wrangler must create the Durable Object class ${className} in a migration.`);
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Rondyr configuration checks passed.\n");
}
