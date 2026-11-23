import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Lints `source` as a file of `folder`, a folder of `apps/rondyr/src`, in a probe folder
 * inside it, and returns the oxlint process result.
 */
const lint = (folder, source) => {
  const probe = join(
    root,
    "apps/rondyr/src",
    folder,
    `boundary-probe-${process.pid}`,
    "example.ts",
  );
  mkdirSync(dirname(probe), { recursive: true });
  writeFileSync(probe, source);
  try {
    return spawnSync("oxlint", [probe], { cwd: root, encoding: "utf8" });
  } finally {
    rmSync(dirname(probe), { recursive: true });
  }
};

for (const [name, folder, source] of [
  ["the domain importing the Worker", "domain/forms", 'import "../../../worker/http/routes.ts";'],
  [
    "the domain importing the dashboard",
    "domain/forms",
    'import "../../../dashboard/lib/format.ts";',
  ],
  ["the domain importing the dashboard alias", "domain/forms", 'import "~/lib/format";'],
  [
    "the dashboard importing the Worker",
    "dashboard/lib",
    'import "../../../worker/ports/forms.ts";',
  ],
  [
    "the dashboard importing a Worker route",
    "dashboard/lib",
    'import "../../../worker/http/routes.ts";',
  ],
  [
    "the dashboard importing the domain by path",
    "dashboard/lib",
    'import "../../../domain/forms/form.ts";',
  ],
  [
    "the Worker importing the dashboard",
    "worker/adapters",
    'import "../../../dashboard/lib/format.ts";',
  ],
  ["a route importing the dashboard", "worker/http", 'import "../../../dashboard/lib/format.ts";'],
  ["a port importing the dashboard", "worker/ports", 'import "~/lib/format";'],
]) {
  test(`rejects ${name}`, () => {
    const result = lint(folder, source);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /no-restricted-imports/u);
  });
}

for (const [name, folder, source] of [
  ["the Worker importing the domain", "worker/adapters", 'import "../../../domain/forms/form.ts";'],
  [
    "the dashboard importing the domain through its alias",
    "dashboard/lib",
    'import "@rondyr/forms/form";',
  ],
]) {
  test(`allows ${name}`, () => {
    const result = lint(folder, source);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
