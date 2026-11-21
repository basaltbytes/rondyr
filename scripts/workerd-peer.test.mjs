// pnpm-workspace.yaml gives @cloudflare/vite-plugin the workerd version of wrangler (see the
// comment on packageExtensions there). This test fails when a wrangler update changes the
// workerd that wrangler installs without the same change to that line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const workspace = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
const lockfile = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");

/** The workerd versions that the snapshots of `name` in the lockfile depend on. */
function workerdOf(name) {
  const snapshots = lockfile.slice(lockfile.indexOf("\nsnapshots:\n"));
  const blocks = snapshots.split(/\n(?=  \S)/u).filter((block) => block.startsWith(`  ${name}@`));
  return new Set(
    blocks.flatMap((block) =>
      [...block.matchAll(/^ {6}workerd: (\S+)$/gmu)].map(([, version]) => version),
    ),
  );
}

test("@cloudflare/vite-plugin gets the workerd version that wrangler installs", () => {
  const extension =
    /packageExtensions:\n {2}"@cloudflare\/vite-plugin":\n {4}dependencies:\n {6}workerd: (\S+)/u.exec(
      workspace,
    )?.[1];
  assert.ok(
    extension !== undefined,
    "pnpm-workspace.yaml has no workerd extension for @cloudflare/vite-plugin",
  );
  assert.deepEqual([...workerdOf("wrangler")], [extension]);
  assert.deepEqual([...workerdOf("'@cloudflare/vite-plugin")], [extension]);
});
