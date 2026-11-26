// Deploys the Worker with Wrangler, after `pnpm build`. Workers Builds runs it for the
// Deploy to Cloudflare button and on every push to the production branch:
//
//   1. creates the D1 database when it does not exist yet (a fork imported into Workers
//      Builds; the button creates it before the first build);
//   2. applies the D1 migrations that are not applied yet, before the new code runs;
//   3. generates RONDYR_SESSION_SECRET and RONDYR_SECRETS_KEY when the Worker has no such
//      secret (skipping RONDYR_SESSION_SECRET when legacy BETTER_AUTH_SECRET already exists).
//      A secret that exists is never replaced: a new RONDYR_SECRETS_KEY would leave every
//      stored webhook secret and Turnstile key undecryptable;
//   4. deploys the Worker, with the generated secrets in the same version.
//
// A generated value is never printed. It goes to Cloudflare through a file that only
// this process can read, deleted right after the deployment.
//
//   node scripts/deploy-cloudflare.mjs
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The root wrangler.json, which names the database and which the button may have edited. */
const userConfig = fileURLToPath(new URL("../../../wrangler.json", import.meta.url));
/** The configuration that the Vite build generated from it, with the built Worker. */
const builtConfig = fileURLToPath(new URL("../dist/rondyr/wrangler.json", import.meta.url));

/** The secrets that the deployment generates when the Worker has none, and how. */
export const generatedSecrets = {
  RONDYR_SESSION_SECRET: () => randomBytes(32).toString("hex"),
  RONDYR_SECRETS_KEY: () => randomBytes(32).toString("base64"),
};

/** Legacy secret names that satisfy a generated secret on upgraded Workers. */
const legacySecretAliases = {
  RONDYR_SESSION_SECRET: ["BETTER_AUTH_SECRET"],
};

/** The Worker's name: Workers Builds can override the one of the configuration. */
export function workerName(config, environment) {
  const override = environment.WRANGLER_CI_OVERRIDE_NAME;
  return override === undefined || override === "" ? config.name : override;
}

/** Whether Wrangler failed because the D1 database does not exist. */
export function isMissingDatabase(output) {
  return /Couldn't find a D1 DB named/u.test(output);
}

/** Whether Wrangler failed because the Worker has never been deployed. */
export function isMissingWorker(output) {
  return /Worker "[^"]+"(?: \(env: [^)]+\))? not found/u.test(output);
}

/**
 * The names of the secrets to generate, from the outcome of `wrangler secret list`. A
 * listing that failed for any other reason than a Worker that does not exist yet stops
 * the deployment: generating a secret that may exist would replace it.
 *
 * @param {{ status: number | null, stdout: string, stderr: string }} listing
 * @returns {{ create: string[] } | { error: string }}
 */
export function secretsToCreate(listing) {
  let existing;
  if (listing.status === 0) {
    try {
      existing = JSON.parse(listing.stdout).map(({ name }) => name);
    } catch {
      return { error: "The secrets of the Worker could not be read." };
    }
  } else if (isMissingWorker(`${listing.stdout}\n${listing.stderr}`)) {
    existing = [];
  } else {
    return { error: "The secrets of the Worker could not be listed." };
  }
  return {
    create: Object.keys(generatedSecrets).filter((name) => {
      const satisfiedBy = [name, ...(legacySecretAliases[name] ?? [])];
      return !satisfiedBy.some((candidate) => existing.includes(candidate));
    }),
  };
}

const require = createRequire(import.meta.url);
const wranglerBin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

/** Run Wrangler, showing its output, and return its status and its captured error output. */
function wrangler(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    stdio: capture ? ["inherit", "pipe", "pipe"] : ["inherit", "inherit", "pipe"],
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (!capture) process.stderr.write(result.stderr);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const applyPendingMigrations = () =>
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", userConfig]);

function applyMigrations(databaseName) {
  let result = applyPendingMigrations();
  if (result.status !== 0 && isMissingDatabase(result.stderr)) {
    process.stdout.write(`Creating the D1 database ${databaseName}.\n`);
    const created = wrangler(["d1", "create", databaseName, "-c", userConfig]);
    if (created.status !== 0) fail("The D1 database could not be created.");
    result = applyPendingMigrations();
  }
  if (result.status !== 0) fail("The D1 migrations could not be applied; nothing was deployed.");
}

function main() {
  const config = JSON.parse(readFileSync(builtConfig, "utf8"));
  const database = config.d1_databases.find(({ binding }) => binding === "DB");
  if (database === undefined) fail("wrangler.json declares no D1 binding named DB.");
  applyMigrations(database.database_name);

  const name = workerName(config, process.env);
  const listing = wrangler(["secret", "list", "--name", name, "-c", builtConfig], {
    capture: true,
  });
  const secrets = secretsToCreate(listing);
  if ("error" in secrets) {
    process.stderr.write(listing.stderr);
    fail(`${secrets.error} Nothing was deployed, so no existing secret is replaced.`);
  }

  const directory = mkdtempSync(join(tmpdir(), "rondyr-deploy-"));
  try {
    const args = ["deploy", "-c", builtConfig];
    if (secrets.create.length > 0) {
      const file = join(directory, "secrets.json");
      const values = Object.fromEntries(
        secrets.create.map((secret) => [secret, generatedSecrets[secret]()]),
      );
      writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
      args.push("--secrets-file", file);
      process.stdout.write(`Generating the secrets ${secrets.create.join(" and ")}.\n`);
    }
    if (wrangler(args).status !== 0) fail("The Worker could not be deployed.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
