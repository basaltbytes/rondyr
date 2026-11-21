import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, lastProductionDeployment, workerPackage } from "./deploy-scope.mjs";

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

/** A fake Actions API: runs per workflow, newest first, and the jobs of each run. */
function actions(runs, jobs) {
  const paths = [];
  const github = async (path) => {
    paths.push(path);
    const workflow = /^actions\/workflows\/([\w.-]+)\/runs\?/u.exec(path)?.[1];
    if (workflow !== undefined) return { workflow_runs: runs[workflow] ?? [] };
    const id = Number(/^actions\/runs\/(\d+)\/jobs/u.exec(path)?.[1]);
    return { jobs: jobs[id] ?? [] };
  };
  return { github, paths };
}

const prod = (conclusion, completed = "2026-11-21T10:00:00Z") => ({
  name: "Production / Deploy prod",
  conclusion,
  completed_at: completed,
});

test("compares with the last run that deployed prod, past cancelled and failed ones", async () => {
  const { github } = actions(
    {
      "ci.yml": [
        { id: 3, head_sha: "cancelled" },
        { id: 2, head_sha: "failed" },
        { id: 1, head_sha: "deployed" },
      ],
    },
    {
      3: [prod("cancelled")],
      2: [{ name: "Quality checks and Worker build", conclusion: "success" }, prod("failure")],
      1: [prod("success")],
    },
  );
  assert.equal(await lastProductionDeployment(github), "deployed");
});

test("recognizes the prod job by the names it had before and after the staging gate", async () => {
  const { github } = actions(
    {
      "ci.yml": [
        { id: 2, head_sha: "staging-docs" },
        { id: 1, head_sha: "older" },
      ],
    },
    {
      2: [{ name: "Production / Deploy staging", conclusion: "success" }],
      1: [{ name: "production / Deploy prod", conclusion: "success", completed_at: "x" }],
    },
  );
  assert.equal(await lastProductionDeployment(github), "older");
});

test("counts a plugin-only run as no deployment, so its base is compared again", async () => {
  const { github } = actions(
    {
      "ci.yml": [
        { id: 2, head_sha: "plugin-only" },
        { id: 1, head_sha: "deployed" },
      ],
    },
    { 2: [prod("skipped")], 1: [prod("success")] },
  );
  assert.equal(await lastProductionDeployment(github), "deployed");
});

test("takes a manual prod deployment when it is the most recent", async () => {
  const { github } = actions(
    {
      "ci.yml": [{ id: 1, head_sha: "from-ci" }],
      "deploy.yml": [{ id: 9, head_sha: "by-hand" }],
    },
    {
      1: [prod("success", "2026-11-21T10:00:00Z")],
      9: [{ name: "Deploy prod", conclusion: "success", completed_at: "2026-11-21T11:00:00Z" }],
    },
  );
  assert.equal(await lastProductionDeployment(github), "by-hand");
});

test("finds no deployment when no recent run deployed prod", async () => {
  const { github, paths } = actions({ "ci.yml": [{ id: 1, head_sha: "never" }] }, { 1: [] });
  assert.equal(await lastProductionDeployment(github), null);
  assert.match(paths[0] ?? "", /branch=main&status=completed/u);
  // No base commit counts as everything changed.
  assert.equal(decide({ files: null, packages: null }).deploy, true);
});
