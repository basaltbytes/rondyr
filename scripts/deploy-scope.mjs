// Decides whether a push deploys the Worker. CI passes the commit to compare with:
// the previous commit on main for a push, the base of a pull request. The Worker
// deploys, and the D1 migrations apply, only when pnpm counts the Worker package
// among the packages changed since that commit. When in doubt, it deploys.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The root package of the workspace, which builds and deploys the Worker. */
export const workerPackage = "rondyr";

/** Files that change the Worker's build or deployment wherever they are. */
const workerFiles = [/^pnpm-lock\.yaml$/u, /^pnpm-workspace\.yaml$/u, /^\.github\//u];

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

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function changesSince(ref) {
  if (ref === undefined || ref === "" || /^0+$/u.test(ref)) return { files: null, packages: null };
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

function main() {
  const ref = process.argv[2];
  const changes = changesSince(ref);
  const { deploy, reason } = decide(changes);
  const packages = changes.packages === null ? "unknown" : changes.packages.join(", ") || "none";
  process.stdout.write(
    [
      `Compared with: ${ref || "nothing"}`,
      `Changed packages: ${packages}`,
      `Deployment ${deploy ? "planned" : "skipped"}: ${reason}.`,
      "",
    ].join("\n"),
  );
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `worker=${deploy}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
