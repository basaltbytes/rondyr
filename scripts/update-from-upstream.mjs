// Brings a copy of Rondyr made by the Deploy to Cloudflare button up to a version of the
// upstream repository. The button copies the repository without a fork relation, so
// GitHub cannot sync it; the "Update Rondyr" workflow runs this script instead.
//
// The script makes the copy's files equal to the upstream ones, except:
// - .github/, which a workflow's token may not change, and which the copy keeps as it is;
// - the names and IDs of the Cloudflare resources in wrangler.json, which the button may
//   have changed or filled in: the update keeps them, so the next deployment uses the same
//   Worker, database, queues and workflow. It keeps the copy's email binding too.
// It then commits on a new branch and pushes it. In a GitHub Actions run, it prints and
// writes to the run's summary the link that opens a pull request from that branch into the
// default branch. Merging the pull request deploys the update.
//
// It stands alone, without the other files of the repository: the workflow runs the
// version of the script that comes with the upstream version it updates to.
//
//   node update-from-upstream.mjs <commit> <label>
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

/** The files that an update leaves as they are in the copy. */
export function isKept(path) {
  return path.startsWith(".github/");
}

/**
 * The files to take from upstream and the files to delete from the copy, so that every
 * file outside .github/ ends up as it is upstream.
 */
export function treeChanges(upstreamFiles, copyFiles) {
  const upstream = new Set(upstreamFiles.filter((path) => !isKept(path)));
  return {
    take: [...upstream],
    remove: copyFiles.filter((path) => !isKept(path) && !upstream.has(path)),
  };
}

function renamed(names, name) {
  return names.get(name) ?? name;
}

/** The copy's names for the resources of one Wrangler environment of the upstream file. */
function keepEnvironmentNames(upstream, copy) {
  const result = structuredClone(upstream);
  const databases = new Map((copy?.d1_databases ?? []).map((entry) => [entry.binding, entry]));
  for (const database of result.d1_databases ?? []) {
    const local = databases.get(database.binding);
    if (local === undefined) continue;
    database.database_name = local.database_name;
    if (local.database_id === undefined) delete database.database_id;
    else database.database_id = local.database_id;
  }

  // A queue is known by the binding of its producer; its dead-letter queue by the
  // consumer of that queue. Each upstream name maps to the name the copy uses.
  const queueNames = new Map();
  const copyProducers = new Map(
    (copy?.queues?.producers ?? []).map((producer) => [producer.binding, producer.queue]),
  );
  for (const producer of upstream.queues?.producers ?? []) {
    const local = copyProducers.get(producer.binding);
    if (local !== undefined) queueNames.set(producer.queue, local);
  }
  const copyConsumers = new Map(
    (copy?.queues?.consumers ?? []).map((consumer) => [consumer.queue, consumer]),
  );
  for (const consumer of upstream.queues?.consumers ?? []) {
    const local = copyConsumers.get(renamed(queueNames, consumer.queue));
    if (consumer.dead_letter_queue !== undefined && local?.dead_letter_queue !== undefined) {
      queueNames.set(consumer.dead_letter_queue, local.dead_letter_queue);
    }
  }
  for (const producer of result.queues?.producers ?? []) {
    producer.queue = renamed(queueNames, producer.queue);
  }
  for (const consumer of result.queues?.consumers ?? []) {
    consumer.queue = renamed(queueNames, consumer.queue);
    if (consumer.dead_letter_queue !== undefined) {
      consumer.dead_letter_queue = renamed(queueNames, consumer.dead_letter_queue);
    }
  }

  const workflows = new Map((copy?.workflows ?? []).map((entry) => [entry.binding, entry.name]));
  for (const workflow of result.workflows ?? []) {
    workflow.name = workflows.get(workflow.binding) ?? workflow.name;
  }
  // The copy adds the binding of Cloudflare Email Sending once its domain is onboarded.
  if (copy?.send_email !== undefined) result.send_email = copy.send_email;
  return result;
}

/** The upstream wrangler.json, with the names and IDs of the copy's resources. */
export function keepResourceNames(upstream, copy) {
  const result = keepEnvironmentNames(upstream, copy);
  result.name = copy.name ?? upstream.name;
  for (const [name, environment] of Object.entries(result.env ?? {})) {
    result.env[name] = keepEnvironmentNames(environment, copy.env?.[name] ?? copy);
  }
  return result;
}

/**
 * The branch that the update goes into: the repository's default branch, from the event of
 * the GitHub Actions run, or else the branch that was checked out when the script started.
 */
export function baseBranch(defaultBranch, checkedOut) {
  return defaultBranch || checkedOut || undefined;
}

/**
 * What the run prints and writes to its summary: the pushed branch and, when the run knows
 * the repository's address, the link that opens a pull request from it.
 */
export function updateSummary({ branch, label, base, serverUrl, repository }) {
  const lines = [`Branch \`${branch}\` has Rondyr ${label}.`, ""];
  if (serverUrl && repository && base) {
    const compare = `${serverUrl}/${repository}/compare/${base}...${branch}?expand=1`;
    lines.push(
      `Open the pull request, check it and merge it: ${compare}`,
      "",
      "Workers Builds then applies the database migrations and deploys the new version.",
    );
  } else {
    lines.push(
      `Open a pull request from it, check it and merge it: Workers Builds then applies the`,
      `database migrations and deploys the new version.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** The repository's default branch, from the event file of a GitHub Actions run. */
function readDefaultBranch(eventPath) {
  if (!eventPath) return undefined;
  const branch = JSON.parse(readFileSync(eventPath, "utf8")).repository?.default_branch;
  return branch ? String(branch) : undefined;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const files = (ref) => git("ls-tree", "-r", "-z", "--name-only", ref).split("\0").filter(Boolean);

function main() {
  const [commit, label = commit] = process.argv.slice(2);
  if (commit === undefined) throw new Error("Usage: update-from-upstream.mjs <commit> <label>");
  const base = baseBranch(
    readDefaultBranch(process.env.GITHUB_EVENT_PATH),
    git("branch", "--show-current").trim(),
  );
  const copyConfig = JSON.parse(readFileSync("wrangler.json", "utf8"));
  const { take, remove } = treeChanges(files(commit), files("HEAD"));
  if (remove.length > 0) git("rm", "-q", "--", ...remove);
  // In batches, so that no command line gets too long.
  for (let start = 0; start < take.length; start += 500) {
    git("checkout", commit, "--", ...take.slice(start, start + 500));
  }
  const upstreamConfig = JSON.parse(readFileSync("wrangler.json", "utf8"));
  const config = keepResourceNames(upstreamConfig, copyConfig);
  // Unchanged, the file keeps the upstream layout.
  if (!isDeepStrictEqual(config, upstreamConfig)) {
    writeFileSync("wrangler.json", `${JSON.stringify(config, null, 2)}\n`);
  }
  git("add", "--all", "--", ".", ":!.github");

  if (git("status", "--porcelain").trim() === "") {
    process.stdout.write(`Already up to date with Rondyr ${label}.\n`);
    return;
  }
  const branch = `update-rondyr/${label.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}`;
  git("switch", "-c", branch);
  git("commit", "-q", "-m", `Update Rondyr to ${label}`);
  git("push", "--force", "origin", branch);
  const summary = updateSummary({
    branch,
    label,
    base,
    serverUrl: process.env.GITHUB_SERVER_URL,
    repository: process.env.GITHUB_REPOSITORY,
  });
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
