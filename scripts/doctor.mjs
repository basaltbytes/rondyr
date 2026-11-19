import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
const expectedBindings = ["CLASSIFICATION_QUEUE", "DELIVERY_QUEUE"];
const errors = [];

for (const name of ["@effect/platform-node", "@effect/vitest"]) {
  if (dependencies[name] !== dependencies.effect) {
    errors.push(`Pin ${name} to the version of effect.`);
  }
}

if (dependencies["@alchemy.run/cloudflare"] !== dependencies.alchemy) {
  errors.push("Pin @alchemy.run/cloudflare to the version of alchemy.");
}

const { d1_databases: databases, queues } = wrangler;
if (databases.length !== 1 || databases[0]?.binding !== "DB" || databases[0]?.remote) {
  errors.push("Wrangler must use one local D1 binding named DB.");
}
for (const binding of expectedBindings) {
  if (!queues.producers.some((producer) => producer.binding === binding && !producer.remote)) {
    errors.push(`Wrangler must use a local producer binding named ${binding}.`);
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Rondyr configuration checks passed.\n");
}
