import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { keepResourceNames, treeChanges } from "./update-from-upstream.mjs";

const upstream = {
  name: "rondyr",
  d1_databases: [{ binding: "DB", database_name: "rondyr", migrations_dir: "./new" }],
  queues: {
    producers: [{ binding: "CLASSIFICATION_QUEUE", queue: "rondyr-classification" }],
    consumers: [
      {
        queue: "rondyr-classification",
        dead_letter_queue: "rondyr-classification-dead-letter",
        max_retries: 5,
      },
      { queue: "rondyr-classification-dead-letter", max_batch_size: 10 },
    ],
  },
  workflows: [{ name: "rondyr-backfill", binding: "Backfill", class_name: "Backfill" }],
  ai: { binding: "AI" },
};

test("takes every upstream file except .github, and deletes the copy's other files", () => {
  const changes = treeChanges(
    ["wrangler.json", "apps/rondyr/src/worker.ts", ".github/workflows/ci.yml"],
    ["wrangler.json", "apps/rondyr/src/old.ts", ".github/workflows/ci.yml", ".github/own.yml"],
  );
  assert.deepEqual(changes, {
    take: ["wrangler.json", "apps/rondyr/src/worker.ts"],
    remove: ["apps/rondyr/src/old.ts"],
  });
});

test("keeps the upstream configuration when the copy uses the same names", () => {
  assert.deepEqual(keepResourceNames(upstream, structuredClone(upstream)), upstream);
});

test("keeps the names and IDs that the copy gave its resources, with the upstream settings", () => {
  const copy = {
    name: "forms",
    d1_databases: [
      { binding: "DB", database_name: "forms-db", database_id: "1234", migrations_dir: "./old" },
    ],
    queues: {
      producers: [{ binding: "CLASSIFICATION_QUEUE", queue: "forms-classification" }],
      consumers: [
        {
          queue: "forms-classification",
          dead_letter_queue: "forms-classification-dlq",
          max_retries: 3,
        },
        { queue: "forms-classification-dlq", max_batch_size: 10 },
      ],
    },
    workflows: [{ name: "forms-backfill", binding: "Backfill", class_name: "Backfill" }],
  };
  const result = keepResourceNames(upstream, copy);
  assert.equal(result.name, "forms");
  assert.deepEqual(result.d1_databases, [
    { binding: "DB", database_name: "forms-db", database_id: "1234", migrations_dir: "./new" },
  ]);
  assert.deepEqual(result.queues, {
    producers: [{ binding: "CLASSIFICATION_QUEUE", queue: "forms-classification" }],
    consumers: [
      {
        queue: "forms-classification",
        dead_letter_queue: "forms-classification-dlq",
        max_retries: 5,
      },
      { queue: "forms-classification-dlq", max_batch_size: 10 },
    ],
  });
  assert.deepEqual(result.workflows, [
    { name: "forms-backfill", binding: "Backfill", class_name: "Backfill" },
  ]);
  assert.deepEqual(result.ai, { binding: "AI" });
});

test("keeps the email binding that the copy added for Cloudflare Email Sending", () => {
  const copy = { ...structuredClone(upstream), send_email: [{ name: "CLOUDFLARE_EMAIL" }] };
  assert.deepEqual(keepResourceNames(upstream, copy).send_email, [{ name: "CLOUDFLARE_EMAIL" }]);
  assert.equal(keepResourceNames(upstream, structuredClone(upstream)).send_email, undefined);
});

test("keeps the names of each Wrangler environment too", () => {
  const withEnvironment = { ...upstream, env: { email: structuredClone(upstream) } };
  const copy = {
    name: "rondyr",
    d1_databases: [{ binding: "DB", database_name: "rondyr", database_id: "1234" }],
    env: { email: { d1_databases: [{ binding: "DB", database_name: "email-db" }] } },
  };
  const result = keepResourceNames(withEnvironment, copy);
  assert.equal(result.d1_databases[0].database_id, "1234");
  assert.equal(result.env.email.d1_databases[0].database_name, "email-db");
  assert.equal(result.env.email.d1_databases[0].database_id, undefined);
});

function run(directory, command, ...args) {
  return execFileSync(command, args, { cwd: directory, encoding: "utf8" });
}

test("updates a copy on a new branch, without touching .github or the copy's names", () => {
  const root = mkdtempSync(join(tmpdir(), "rondyr-update-"));
  try {
    const remote = join(root, "remote.git");
    const copy = join(root, "copy");
    run(root, "git", "init", "-q", "--bare", remote);
    run(root, "git", "init", "-q", "-b", "main", copy);
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.test"],
    ]) {
      run(copy, "git", "config", key, value);
    }
    mkdirSync(join(copy, ".github"));
    writeFileSync(join(copy, ".github/own.yml"), "copy\n");
    writeFileSync(join(copy, "old.txt"), "removed upstream\n");
    writeFileSync(
      join(copy, "wrangler.json"),
      JSON.stringify({ ...upstream, d1_databases: [{ binding: "DB", database_name: "forms" }] }),
    );
    run(copy, "git", "add", ".");
    run(copy, "git", "commit", "-q", "-m", "Copy");
    run(copy, "git", "remote", "add", "origin", remote);

    // The upstream version: another tree, with its own .github. An orphan branch starts
    // without the files of main.
    run(copy, "git", "switch", "-q", "--orphan", "upstream");
    mkdirSync(join(copy, ".github"), { recursive: true });
    writeFileSync(join(copy, ".github/own.yml"), "upstream\n");
    writeFileSync(join(copy, "new.txt"), "added upstream\n");
    writeFileSync(join(copy, "wrangler.json"), JSON.stringify(upstream));
    run(copy, "git", "add", ".");
    run(copy, "git", "commit", "-q", "-m", "Upstream");
    const commit = run(copy, "git", "rev-parse", "HEAD").trim();
    run(copy, "git", "switch", "-q", "-f", "main");

    const script = fileURLToPath(new URL("update-from-upstream.mjs", import.meta.url));
    const output = run(copy, process.execPath, script, commit, "v1.2.0");
    assert.match(output, /update-rondyr\/v1\.2\.0/u);

    assert.equal(run(copy, "git", "branch", "--show-current").trim(), "update-rondyr/v1.2.0");
    assert.equal(readFileSync(join(copy, "new.txt"), "utf8"), "added upstream\n");
    assert.equal(readFileSync(join(copy, ".github/own.yml"), "utf8"), "copy\n");
    assert.throws(() => readFileSync(join(copy, "old.txt")));
    const config = JSON.parse(readFileSync(join(copy, "wrangler.json"), "utf8"));
    assert.equal(config.d1_databases[0].database_name, "forms");
    assert.equal(config.d1_databases[0].migrations_dir, "./new");
    assert.equal(run(copy, "git", "status", "--porcelain").trim(), "");
    // The branch is pushed; main is untouched.
    assert.match(run(remote, "git", "branch", "--list"), /update-rondyr\/v1\.2\.0/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
