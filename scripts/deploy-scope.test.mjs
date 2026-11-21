import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, lastProductionDeployment, workerPackage } from "./deploy-scope.mjs";

const root = { name: "rondyr-workspace", directory: "" };
const worker = { name: workerPackage, directory: "apps/rondyr" };
const plugin = { name: "@basaltbytes/emdash-plugin-rondyr", directory: "packages/emdash-plugin" };
const docsSite = { name: "@rondyr/docs", directory: "apps/docs" };
const lintRules = { name: "@rondyr/oxlint", directory: "tooling/oxlint" };

test("skips the deployment when only the plugin package changed", () => {
  const files = ["packages/emdash-plugin/src/plugin.ts"];
  assert.deepEqual(decide({ files, packages: [plugin] }), {
    deploy: false,
    reason: "the Worker package did not change",
  });
});

test("skips the deployment when only the documentation changed", () => {
  for (const path of [
    "README.md",
    "architecture.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/deployment.md",
    "docs/examples/verify-webhook.ts",
    ".agents/skills/effect-ts/SKILL.md",
  ]) {
    assert.equal(decide({ files: [path], packages: [root] }).deploy, false, path);
  }
});

test("skips the deployment when only the documentation site changed", () => {
  const files = ["apps/docs/src/content/docs/index.mdx", "docs/api.md"];
  assert.equal(decide({ files, packages: [root, docsSite] }).deploy, false);
});

test("skips the deployment when only the lint rules changed", () => {
  const files = ["tooling/oxlint/rules/no-reflect-get.ts"];
  assert.equal(decide({ files, packages: [lintRules] }).deploy, false);
});

test("deploys when the Worker package changed", () => {
  const files = ["apps/rondyr/src/worker.ts", "packages/emdash-plugin/src/plugin.ts"];
  assert.equal(decide({ files, packages: [worker, plugin] }).deploy, true);
});

test("deploys when a package the Worker depends on changed", () => {
  // pnpm lists the Worker package among the dependents of the shared TypeScript settings.
  const files = ["tooling/tsconfig/base.json"];
  const settings = { name: "@rondyr/tsconfig", directory: "tooling/tsconfig" };
  assert.deepEqual(decide({ files, packages: [settings, worker] }), {
    deploy: true,
    reason: "the Worker package changed",
  });
});

test("counts the app, the lockfile, the workspace file, the root manifest, the Node version, the patches and .github as a Worker change", () => {
  for (const path of [
    "apps/rondyr/wrangler.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    ".nvmrc",
    "patches/@alchemy.run__domain@2.0.0-beta.87.patch",
    ".github/workflows/ci.yml",
  ]) {
    const result = decide({ files: [path, "docs/api.md"], packages: [root, plugin] });
    assert.equal(result.deploy, true, path);
    assert.match(result.reason, new RegExp(`^${path.replaceAll(".", "\\.")} changed`, "u"), path);
  }
});

test("deploys when a changed file is neither documentation nor part of another package", () => {
  for (const path of ["scripts/deploy-scope.mjs", "knip.json", "LICENSE", "apps/README.md"]) {
    assert.equal(decide({ files: [path], packages: [root] }).deploy, true, path);
  }
  // A file pnpm did not attribute to a changed package counts as a doubt too.
  const files = ["packages/emdash-plugin/src/plugin.ts"];
  assert.equal(decide({ files, packages: [root] }).deploy, true);
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

const repository = "basaltbytes/rondyr";

/** A run of this repository's own commit, after a push or started by hand. */
const run = (id, sha, event = "push") => ({
  id,
  head_sha: sha,
  event,
  head_repository: { full_name: repository },
});

const prod = (conclusion, completed = "2026-11-21T10:00:00Z") => ({
  name: "Production / Deploy prod",
  conclusion,
  completed_at: completed,
});

test("compares with the last run that deployed prod, past cancelled and failed ones", async () => {
  const { github } = actions(
    {
      "ci.yml": [run(3, "cancelled"), run(2, "failed"), run(1, "deployed")],
    },
    {
      3: [prod("cancelled")],
      2: [{ name: "Quality checks and Worker build", conclusion: "success" }, prod("failure")],
      1: [prod("success")],
    },
  );
  assert.equal(await lastProductionDeployment(github, repository), "deployed");
});

test("recognizes the prod job by the names it had before and after the staging gate", async () => {
  const { github } = actions(
    {
      "ci.yml": [run(2, "staging-docs"), run(1, "older")],
    },
    {
      2: [{ name: "Production / Deploy staging", conclusion: "success" }],
      1: [{ name: "production / Deploy prod", conclusion: "success", completed_at: "x" }],
    },
  );
  assert.equal(await lastProductionDeployment(github, repository), "older");
});

test("counts a plugin-only run as no deployment, so its base is compared again", async () => {
  const { github } = actions(
    {
      "ci.yml": [run(2, "plugin-only"), run(1, "deployed")],
    },
    { 2: [prod("skipped")], 1: [prod("success")] },
  );
  assert.equal(await lastProductionDeployment(github, repository), "deployed");
});

test("takes a manual prod deployment when it is the most recent", async () => {
  const { github } = actions(
    {
      "ci.yml": [run(1, "from-ci")],
      "deploy.yml": [run(9, "by-hand", "workflow_dispatch")],
    },
    {
      1: [prod("success", "2026-11-21T10:00:00Z")],
      9: [{ name: "Deploy prod", conclusion: "success", completed_at: "2026-11-21T11:00:00Z" }],
    },
  );
  assert.equal(await lastProductionDeployment(github, repository), "by-hand");
});

test("finds no deployment when no recent run deployed prod", async () => {
  const { github, paths } = actions({ "ci.yml": [run(1, "never")] }, { 1: [] });
  assert.equal(await lastProductionDeployment(github, repository), null);
  assert.match(
    paths[0] ?? "",
    /^actions\/workflows\/ci\.yml\/runs\?branch=main&event=push&status=completed/u,
  );
  assert.match(
    paths.at(-1) ?? "",
    /^actions\/workflows\/deploy\.yml\/runs\?branch=main&event=workflow_dispatch&status=completed/u,
  );
  // No base commit counts as everything changed.
  assert.equal(decide({ files: null, packages: null }).deploy, true);
});

test("ignores a fork's pull request whose head branch is main and whose job is named Deploy prod", async () => {
  const fork = { ...run(2, "from-a-fork"), head_repository: { full_name: "someone/rondyr" } };
  const { github } = actions(
    { "ci.yml": [fork, run(1, "deployed")] },
    { 2: [prod("success", "2026-11-21T12:00:00Z")], 1: [prod("success")] },
  );
  assert.equal(await lastProductionDeployment(github, repository), "deployed");
});

test("counts only pushes for ci.yml and manual runs for deploy.yml", async () => {
  const { github } = actions(
    {
      "ci.yml": [run(3, "pull-request", "pull_request"), run(1, "pushed")],
      "deploy.yml": [
        run(9, "called", "workflow_call"),
        run(8, "older-by-hand", "workflow_dispatch"),
      ],
    },
    {
      3: [prod("success", "2026-11-21T12:00:00Z")],
      1: [prod("success", "2026-11-21T10:00:00Z")],
      9: [{ name: "Deploy prod", conclusion: "success", completed_at: "2026-11-21T13:00:00Z" }],
      8: [{ name: "Deploy prod", conclusion: "success", completed_at: "2026-11-21T09:00:00Z" }],
    },
  );
  assert.equal(await lastProductionDeployment(github, repository), "pushed");
});
