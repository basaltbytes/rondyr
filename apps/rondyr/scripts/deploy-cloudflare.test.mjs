import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generatedSecrets,
  isMissingDatabase,
  secretsToCreate,
  workerName,
} from "./deploy-cloudflare.mjs";

// The texts that wrangler 4.165 prints for a Worker and a database that do not exist.
const missingWorker = `✘ [ERROR] Worker "rondyr" not found.

If this is a new Worker, run \`wrangler deploy\` first to create it.`;
const missingDatabase =
  "✘ [ERROR] Couldn't find a D1 DB named 'rondyr' (bound as 'DB') in the API. Run 'wrangler d1 create rondyr' to create it.";

test("generates both secrets for a Worker that does not exist yet", () => {
  const listing = { status: 1, stdout: "", stderr: missingWorker };
  assert.deepEqual(secretsToCreate(listing), {
    create: ["RONDYR_SESSION_SECRET", "RONDYR_SECRETS_KEY"],
  });
});

test("generates only the secrets that the Worker lacks", () => {
  const stdout = JSON.stringify([
    { name: "RONDYR_SECRETS_KEY", type: "secret_text" },
    { name: "RONDYR_SETUP_TOKEN", type: "secret_text" },
  ]);
  assert.deepEqual(secretsToCreate({ status: 0, stdout, stderr: "" }), {
    create: ["RONDYR_SESSION_SECRET"],
  });
});

test("generates nothing when the Worker has both secrets", () => {
  const stdout = JSON.stringify([
    { name: "RONDYR_SESSION_SECRET", type: "secret_text" },
    { name: "RONDYR_SECRETS_KEY", type: "secret_text" },
  ]);
  assert.deepEqual(secretsToCreate({ status: 0, stdout, stderr: "" }), { create: [] });
});

test("skips RONDYR_SESSION_SECRET when legacy BETTER_AUTH_SECRET already exists", () => {
  const stdout = JSON.stringify([
    { name: "BETTER_AUTH_SECRET", type: "secret_text" },
    { name: "RONDYR_SECRETS_KEY", type: "secret_text" },
  ]);
  assert.deepEqual(secretsToCreate({ status: 0, stdout, stderr: "" }), { create: [] });
});

test("stops when the secrets cannot be listed, rather than replace one", () => {
  for (const listing of [
    { status: 1, stdout: "", stderr: "✘ [ERROR] Authentication error [code: 10000]" },
    { status: 1, stdout: "", stderr: "" },
    { status: 0, stdout: "not json", stderr: "" },
  ]) {
    assert.ok("error" in secretsToCreate(listing), JSON.stringify(listing));
  }
});

test("recognizes a database that does not exist yet, and only that failure", () => {
  assert.equal(isMissingDatabase(missingDatabase), true);
  assert.equal(isMissingDatabase("✘ [ERROR] Authentication error [code: 10000]"), false);
});

test("takes the Worker name from Workers Builds when it overrides the configuration", () => {
  assert.equal(workerName({ name: "rondyr" }, {}), "rondyr");
  assert.equal(workerName({ name: "rondyr" }, { WRANGLER_CI_OVERRIDE_NAME: "" }), "rondyr");
  assert.equal(workerName({ name: "rondyr" }, { WRANGLER_CI_OVERRIDE_NAME: "forms" }), "forms");
});

test("generates secrets in the formats that the Worker accepts", () => {
  const sessionSecret = generatedSecrets.RONDYR_SESSION_SECRET();
  assert.match(sessionSecret, /^[0-9a-f]{64}$/u);
  assert.notEqual(sessionSecret, generatedSecrets.RONDYR_SESSION_SECRET());
  // RONDYR_SECRETS_KEY is 32 bytes in base64; any other value counts as missing.
  assert.equal(Buffer.from(generatedSecrets.RONDYR_SECRETS_KEY(), "base64").byteLength, 32);
});
