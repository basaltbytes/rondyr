// Decides whether a push to main deploys the Worker. A push compares HEAD with the
// commit of the last successful production deployment, which the GitHub Actions API
// gives; a pull request compares with its base, for the log only. The Worker deploys,
// and the D1 migrations apply, when pnpm counts the Worker package among the packages
// changed since that commit, when a file that builds or deploys it changed, or when a
// changed file belongs neither to another package nor to the documentation. When in
// doubt, it deploys.
//
//   node scripts/deploy-scope.mjs --last-deployment   (push to main)
//   node scripts/deploy-scope.mjs <commit>            (pull request)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The package in apps/rondyr, which builds and deploys the Worker. */
export const workerPackage = "rondyr";

/**
 * Changes to the app, shared dashboard artwork, Wrangler configuration, lockfile,
 * workspace catalog, root manifest, Node version, dependency patches or workflows
 * affect the Worker's build or deployment.
 */
const workerFiles = [
  /^apps\/rondyr\//u,
  /^docs\/brand\/rondyr(?:-mark|-favicon)?\.svg$/u,
  /^wrangler\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /^package\.json$/u,
  /^\.nvmrc$/u,
  /^patches\//u,
  /^\.github\//u,
];

/** Documentation, changesets, and agent instructions that do not require a Worker deploy. */
const documentationFiles = [
  /^README\.md$/u,
  /^AGENTS\.md$/u,
  /^CONTRIBUTING\.md$/u,
  /^docs\//u,
  /^\.agents\//u,
  /^\.claude\//u,
  /^\.changeset\//u,
  /^skills-lock\.json$/u,
];

/**
 * The runs that deploy prod: `ci.yml` after a push, `deploy.yml` by hand. A pull request
 * from a fork can have a head branch named main and a job named `Deploy prod`, so only
 * these events count, and only runs of this repository's own commits.
 */
const deployments = [
  { workflow: "ci.yml", event: "push" },
  { workflow: "deploy.yml", event: "workflow_dispatch" },
];

/**
 * The prod deployment job, `Deploy prod` in `deploy.yml`. Called from `ci.yml`,
 * its name has the calling job's name in front, such as `Production / Deploy prod`.
 */
const deployJob = /^(?:[^/]+ \/ )?Deploy prod$/u;

/** How many completed runs of each workflow to look through for the last deployment. */
const runsToScan = 30;

/**
 * @param {{
 *   files: readonly string[] | null,
 *   packages: readonly { name: string, directory: string }[] | null,
 * }} changes
 *   The changed files and the changed packages with their directory relative to the
 *   repository root ("" for the root package), or null when the comparison could not be made.
 * @returns {{ deploy: boolean, reason: string }}
 */
export function decide(changes) {
  if (changes.files === null || changes.packages === null) {
    return {
      deploy: true,
      reason: "the comparison could not be made, so everything counts as changed",
    };
  }
  const workerFile = changes.files.find((path) =>
    workerFiles.some((pattern) => pattern.test(path)),
  );
  if (workerFile !== undefined) {
    return {
      deploy: true,
      reason: `${workerFile} changed, which counts as a change to the Worker`,
    };
  }
  if (changes.packages.some(({ name }) => name === workerPackage)) {
    return { deploy: true, reason: "the Worker package changed" };
  }
  // pnpm already counts the Worker as changed when a package it depends on changed, so a
  // file of another changed package leaves the Worker as it is.
  const packageDirectories = changes.packages
    .map(({ directory }) => directory)
    .filter((directory) => directory !== "");
  const unknownFile = changes.files.find(
    (path) =>
      !packageDirectories.some((directory) => path.startsWith(`${directory}/`)) &&
      !documentationFiles.some((pattern) => pattern.test(path)),
  );
  if (unknownFile !== undefined) {
    return {
      deploy: true,
      reason: `${unknownFile} changed, outside the other packages and the documentation, which counts as a change to the Worker`,
    };
  }
  return { deploy: false, reason: "the Worker package did not change" };
}

/**
 * The commit of the last successful production deployment from main, or null
 * when none of the recent runs deployed prod. A run whose prod job failed, was
 * cancelled or was skipped does not count, so its changes are compared again.
 *
 * @param {(path: string) => Promise<any>} github A GET on the repository's REST API.
 * @param {string} repository The repository, as `owner/name`.
 * @returns {Promise<string | null>}
 */
export async function lastProductionDeployment(github, repository) {
  /** @type {{ sha: string, at: string } | null} */
  let latest = null;
  for (const { workflow, event } of deployments) {
    const { workflow_runs: runs } = await github(
      `actions/workflows/${workflow}/runs?branch=main&event=${event}&status=completed&per_page=${runsToScan}`,
    );
    for (const workflowRun of runs) {
      if (workflowRun.event !== event) continue;
      if (workflowRun.head_repository?.full_name !== repository) continue;
      const { jobs } = await github(`actions/runs/${workflowRun.id}/jobs?per_page=100`);
      const deployed = jobs.find(
        (candidate) => deployJob.test(candidate.name) && candidate.conclusion === "success",
      );
      if (deployed === undefined) continue;
      if (latest === null || deployed.completed_at > latest.at) {
        latest = { sha: workflowRun.head_sha, at: deployed.completed_at };
      }
      break;
    }
  }
  return latest?.sha ?? null;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function changesSince(ref) {
  if (ref === null || ref === "" || /^0+$/u.test(ref)) return { files: null, packages: null };
  try {
    run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const root = run("git", ["rev-parse", "--show-toplevel"]).trim();
    const files = run("git", ["diff", "--name-only", ref, "HEAD"]).split("\n").filter(Boolean);
    const listed = JSON.parse(
      run("pnpm", ["--filter", `...[${ref}]`, "list", "--depth", "-1", "--json"]),
    );
    const packages = listed.map((project) => ({
      name: project.name,
      directory: relative(root, project.path).split(sep).join("/"),
    }));
    return { files, packages };
  } catch {
    return { files: null, packages: null };
  }
}

/** A GET on this repository's REST API, with the workflow's token. */
function githubApi() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  return async (path) => {
    const response = await fetch(`${api}/repos/${repository}/${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
    return response.json();
  };
}

async function baseCommit(argument) {
  if (argument !== "--last-deployment") return { ref: argument ?? null, label: "the base" };
  try {
    const ref = await lastProductionDeployment(githubApi(), process.env.GITHUB_REPOSITORY);
    return { ref, label: "the last production deployment" };
  } catch (error) {
    process.stdout.write(`The last production deployment could not be read: ${error.message}\n`);
    return { ref: null, label: "the last production deployment" };
  }
}

async function main() {
  const { ref, label } = await baseCommit(process.argv[2]);
  const changes = changesSince(ref);
  const { deploy, reason } = decide(changes);
  const packages =
    changes.packages === null
      ? "unknown"
      : changes.packages.map(({ name }) => name).join(", ") || "none";
  const decision = `Deployment ${deploy ? "planned" : "skipped"}: ${reason}.`;
  process.stdout.write(
    [
      `Compared with ${label}: ${ref ?? "none found"}`,
      `Changed packages: ${packages}`,
      decision,
      `::notice title=Deployment scope::${decision}`,
      "",
    ].join("\n"),
  );
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `worker=${deploy}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
