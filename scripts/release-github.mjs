// Creates git tags and GitHub Releases from the versions and CHANGELOG.md files that
// Changesets updates. Intended to run as the publish-script of changesets/action on
// pushes to main: it is idempotent, skips packages whose current version has no
// changelog entry or is already released, and never publishes to npm.
//
//   node scripts/release-github.mjs            (create missing GitHub Releases)
//   node scripts/release-github.mjs --dry-run  (print planned releases without calling GitHub)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Workspace packages that receive GitHub Releases, with their tag and latest-badge rules. */
export const releasePackages = [
  {
    name: "rondyr",
    directory: "apps/rondyr",
    tag: (version) => `v${version}`,
    title: (version) => `v${version}`,
    makeLatest: true,
  },
  {
    name: "@basaltbytes/emdash-plugin-rondyr",
    directory: "packages/emdash-plugin",
    tag: (version) => `@basaltbytes/emdash-plugin-rondyr@${version}`,
    title: (version) => `@basaltbytes/emdash-plugin-rondyr@${version}`,
    makeLatest: false,
  },
];

/**
 * Extracts the markdown body of a single `## <version>` section from a Changesets
 * CHANGELOG.md, or returns null when that version has no entry.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function extractReleaseNotes(changelog, version) {
  const heading = `## ${version}`;
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;

  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) break;
    section.push(line);
  }

  return section.join("\n").trim();
}

/**
 * Reads each releasable package's manifest and CHANGELOG.md under `rootDir` and returns
 * the releases whose current version has a matching changelog section.
 *
 * @param {string} rootDir
 */
export function planReleases(rootDir) {
  const planned = [];
  for (const pkg of releasePackages) {
    const packageDir = join(rootDir, pkg.directory);
    const manifestPath = join(packageDir, "package.json");
    const changelogPath = join(packageDir, "CHANGELOG.md");
    if (!existsSync(manifestPath) || !existsSync(changelogPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const version = manifest.version ?? "";
    if (version === "") continue;

    const changelog = readFileSync(changelogPath, "utf8");
    const notes = extractReleaseNotes(changelog, version);
    if (notes === null) continue;

    const prerelease = version.includes("-");
    planned.push({
      name: pkg.name,
      version,
      tag: pkg.tag(version),
      title: pkg.title(version),
      body: notes,
      prerelease,
      makeLatest: pkg.makeLatest && !prerelease,
    });
  }
  return planned;
}

/**
 * Publishes one GitHub Release when its tag does not have a release yet.
 *
 * @param {{
 *   releaseExists: (tag: string) => Promise<boolean>,
 *   createRelease: (payload: Record<string, unknown>) => Promise<{ html_url: string }>,
 * }} github
 * @param {{
 *   tag: string,
 *   title: string,
 *   body: string,
 *   prerelease: boolean,
 *   makeLatest: boolean,
 * }} release
 * @param {string} targetCommitish
 */
export async function publishRelease(github, release, targetCommitish) {
  if (await github.releaseExists(release.tag)) {
    return { status: "skipped", tag: release.tag };
  }
  const created = await github.createRelease({
    tag_name: release.tag,
    target_commitish: targetCommitish,
    name: release.title,
    body: release.body,
    draft: false,
    prerelease: release.prerelease,
    make_latest: release.makeLatest ? "true" : "false",
  });
  return { status: "created", tag: release.tag, url: created.html_url };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function githubApi() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set to publish GitHub Releases.");
  }

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };

  return {
    async releaseExists(tag) {
      const response = await fetch(
        `${api}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        { headers },
      );
      if (response.status === 200) return true;
      if (response.status === 404) return false;
      const detail = await response.text();
      throw new Error(`GitHub answered ${response.status} checking tag ${tag}: ${detail}`);
    },
    async createRelease(payload) {
      const response = await fetch(`${api}/repos/${repository}/releases`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `GitHub answered ${response.status} creating release ${payload.tag_name}: ${detail}`,
        );
      }
      return response.json();
    },
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rootDir = git(["rev-parse", "--show-toplevel"]);
  const planned = planReleases(rootDir);

  if (planned.length === 0) {
    process.stdout.write("No releasable changelog entries found.\n");
    return;
  }

  if (dryRun) {
    for (const release of planned) {
      process.stdout.write(
        `[dry-run] ${release.tag} (${release.name}@${release.version}, latest=${release.makeLatest}, prerelease=${release.prerelease})\n`,
      );
    }
    return;
  }

  const targetCommitish = process.env.GITHUB_SHA || git(["rev-parse", "HEAD"]);
  const github = githubApi();

  for (const release of planned) {
    const result = await publishRelease(github, release, targetCommitish);
    if (result.status === "skipped") {
      process.stdout.write(`Already released: ${result.tag}\n`);
    } else {
      process.stdout.write(`Created GitHub Release: ${result.tag} (${result.url})\n`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
