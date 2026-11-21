import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, workerPackage } from "./deploy-scope.mjs";

const plugin = "@basaltbytes/emdash-plugin-rondyr";

test("skips the deployment when only the plugin package changed", () => {
  const files = ["packages/emdash-plugin/src/plugin.ts"];
  assert.deepEqual(decide({ files, packages: [plugin] }), {
    deploy: false,
    reason: "the Worker package did not change",
  });
});

test("deploys when the Worker package changed", () => {
  const result = decide({ files: ["src/worker.ts"], packages: [workerPackage, plugin] });
  assert.equal(result.deploy, true);
});

test("counts the lockfile, the workspace file and .github as a Worker change", () => {
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/ci.yml"]) {
    assert.equal(decide({ files: [path], packages: [plugin] }).deploy, true, path);
  }
});

test("deploys when the comparison could not be made", () => {
  assert.equal(decide({ files: null, packages: null }).deploy, true);
});
