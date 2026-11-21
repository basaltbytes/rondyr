// Decides whether a push to main deploys the Worker. A push compares HEAD with the
// commit of the last successful production deployment, which the GitHub Actions API
// gives; a pull request compares with its base, for the log only. The Worker deploys,
// and the D1 migrations apply, only when pnpm counts the Worker package among the
// packages changed since that commit. When in doubt, it deploys.
//
//   node scripts/deploy-scope.mjs --last-deployment   (push to main)
//   node scripts/deploy-scope.mjs <commit>            (pull request)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The root package of the workspace, which builds and deploys the Worker. */
export const workerPackage = "rondyr";

/** Files that change the Worker's build or deployment wherever they are. */
const workerFiles = [/^pnpm-lock\.yaml$/u, /^pnpm-workspace\.yaml$/u, /^\.github\//u];

/** The workflows that deploy prod, and the name of their prod deployment job. */
const deployments = [
  { workflow: "ci.yml", job: "production / Deploy prod" },
  { workflow: "deploy.yml", job: "Deploy prod" },
];

/** How many completed runs of each workflow to look through for the last deployment. */
const runsToScan = 30;

/**
 * @param {{ files: readonly string[] | null, packages: readonly string[] | null }} changes
 *   The changed files and packages, or null when the comparison could not be made.
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
  if (changes.packages.includes(workerPackage)) {
    return { deploy: true, reason: "the Worker package changed" };
  }
  return { deploy: false, reason: "the Worker package did not change" };
}

/**
 * The commit of the last successful production deployment from main, or null
 * when none of the recent runs deployed prod. A run whose prod job failed, was
 * cancelled or was skipped does not count, so its changes are compared again.
 *
 * @param {(path: string) => Promise<any>} github A GET on the repository's REST API.
 * @returns {Promise<string | null>}
 */
export async function lastProductionDeployment(github) {
  /** @type {{ sha: string, at: string } | null} */
  let latest = null;
  for (const { workflow, job } of deployments) {
    const { workflow_runs: runs } = await github(
      `actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=${runsToScan}`,
    );
    for (const workflowRun of runs) {
      const { jobs } = await github(`actions/runs/${workflowRun.id}/jobs?per_page=100`);
      const deployed = jobs.find(
        (candidate) => candidate.name === job && candidate.conclusion === "success",
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
    const files = run("git", ["diff", "--name-only", ref, "HEAD"]).split("\n").filter(Boolean);
    const listed = JSON.parse(
      run("pnpm", ["--filter", `...[${ref}]`, "list", "--depth", "-1", "--json"]),
    );
    const packages = listed.map((project) => project.name);
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
    const ref = await lastProductionDeployment(githubApi());
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
  const packages = changes.packages === null ? "unknown" : changes.packages.join(", ") || "none";
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
