import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  extractReleaseNotes,
  planReleases,
  publishRelease,
  writeChangesetsOutput,
} from "./release-github.mjs";

const sampleChangelog = `# rondyr

## 0.2.0

### Minor Changes

- [#105](https://github.com/basaltbytes/rondyr/pull/105) [\`6852ee6\`](https://github.com/basaltbytes/rondyr/commit/6852ee6) Thanks [@alice](https://github.com/alice)! - Add form and organization blocked terms

### Patch Changes

- Fix copy button for the form address

## 0.1.0

### Minor Changes

- Initial release
`;

test("extracts the section matching the requested version", () => {
  assert.equal(
    extractReleaseNotes(sampleChangelog, "0.2.0"),
    [
      "### Minor Changes",
      "",
      "- [#105](https://github.com/basaltbytes/rondyr/pull/105) [`6852ee6`](https://github.com/basaltbytes/rondyr/commit/6852ee6) Thanks [@alice](https://github.com/alice)! - Add form and organization blocked terms",
      "",
      "### Patch Changes",
      "",
      "- Fix copy button for the form address",
    ].join("\n"),
  );
  assert.equal(
    extractReleaseNotes(sampleChangelog, "0.1.0"),
    "### Minor Changes\n\n- Initial release",
  );
});

test("returns null when the changelog does not contain the version", () => {
  assert.equal(extractReleaseNotes(sampleChangelog, "0.3.0"), null);
  assert.equal(extractReleaseNotes(sampleChangelog, "0.2"), null);
});

test("plans independent releases for Rondyr and the EmDash plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "rondyr-release-"));
  try {
    mkdirSync(join(root, "apps/rondyr"), { recursive: true });
    mkdirSync(join(root, "packages/emdash-plugin"), { recursive: true });

    writeFileSync(
      join(root, "apps/rondyr/package.json"),
      JSON.stringify({ name: "rondyr", version: "0.2.0", private: true }),
    );
    writeFileSync(
      join(root, "apps/rondyr/CHANGELOG.md"),
      "# rondyr\n\n## 0.2.0\n\n### Minor Changes\n\n- Add blocked terms\n",
    );

    writeFileSync(
      join(root, "packages/emdash-plugin/package.json"),
      JSON.stringify({ name: "@basaltbytes/emdash-plugin-rondyr", version: "0.1.1" }),
    );
    writeFileSync(
      join(root, "packages/emdash-plugin/CHANGELOG.md"),
      "# @basaltbytes/emdash-plugin-rondyr\n\n## 0.1.1\n\n### Patch Changes\n\n- Retry webhook verification\n",
    );

    assert.deepEqual(planReleases(root), [
      {
        name: "rondyr",
        version: "0.2.0",
        tag: "v0.2.0",
        title: "v0.2.0",
        body: "### Minor Changes\n\n- Add blocked terms",
        prerelease: false,
        makeLatest: true,
      },
      {
        name: "@basaltbytes/emdash-plugin-rondyr",
        version: "0.1.1",
        tag: "@basaltbytes/emdash-plugin-rondyr@0.1.1",
        title: "@basaltbytes/emdash-plugin-rondyr@0.1.1",
        body: "### Patch Changes\n\n- Retry webhook verification",
        prerelease: false,
        makeLatest: false,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips packages without a changelog entry and flags prereleases as non-latest", () => {
  const root = mkdtempSync(join(tmpdir(), "rondyr-release-"));
  try {
    mkdirSync(join(root, "apps/rondyr"), { recursive: true });
    mkdirSync(join(root, "packages/emdash-plugin"), { recursive: true });

    writeFileSync(
      join(root, "apps/rondyr/package.json"),
      JSON.stringify({ name: "rondyr", version: "0.3.0-rc.1", private: true }),
    );
    writeFileSync(
      join(root, "apps/rondyr/CHANGELOG.md"),
      "# rondyr\n\n## 0.3.0-rc.1\n\n### Minor Changes\n\n- Release candidate\n",
    );
    writeFileSync(
      join(root, "packages/emdash-plugin/package.json"),
      JSON.stringify({ name: "@basaltbytes/emdash-plugin-rondyr", version: "0.1.0" }),
    );

    assert.deepEqual(planReleases(root), [
      {
        name: "rondyr",
        version: "0.3.0-rc.1",
        tag: "v0.3.0-rc.1",
        title: "v0.3.0-rc.1",
        body: "### Minor Changes\n\n- Release candidate",
        prerelease: true,
        makeLatest: false,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates missing releases and skips tags that already have a release", async () => {
  const createdPayloads = [];
  const github = {
    async releaseExists(tag) {
      return tag === "v0.1.0";
    },
    async createRelease(payload) {
      createdPayloads.push(payload);
      return { html_url: `https://github.com/basaltbytes/rondyr/releases/tag/${payload.tag_name}` };
    },
  };

  const skipped = await publishRelease(
    github,
    {
      tag: "v0.1.0",
      title: "v0.1.0",
      body: "### Minor Changes\n\n- Initial",
      prerelease: false,
      makeLatest: true,
    },
    "abc123",
  );
  assert.deepEqual(skipped, { status: "skipped", tag: "v0.1.0" });

  const created = await publishRelease(
    github,
    {
      tag: "v0.2.0",
      title: "v0.2.0",
      body: "### Minor Changes\n\n- Add blocked terms",
      prerelease: false,
      makeLatest: true,
    },
    "def456",
  );
  assert.deepEqual(created, {
    status: "created",
    tag: "v0.2.0",
    url: "https://github.com/basaltbytes/rondyr/releases/tag/v0.2.0",
  });
  assert.deepEqual(createdPayloads, [
    {
      tag_name: "v0.2.0",
      target_commitish: "def456",
      name: "v0.2.0",
      body: "### Minor Changes\n\n- Add blocked terms",
      draft: false,
      prerelease: false,
      make_latest: "true",
    },
  ]);
});

test("writes NDJSON git-tag events to CHANGESETS_OUTPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "rondyr-changesets-output-"));
  try {
    const emptyFile = join(dir, "empty.ndjson");
    writeChangesetsOutput(emptyFile, []);
    assert.equal(readFileSync(emptyFile, "utf8"), "");

    const eventsFile = join(dir, "events.ndjson");
    writeChangesetsOutput(eventsFile, [
      { name: "rondyr", tag: "v0.2.0" },
      {
        name: "@basaltbytes/emdash-plugin-rondyr",
        tag: "@basaltbytes/emdash-plugin-rondyr@0.1.1",
      },
    ]);
    const lines = readFileSync(eventsFile, "utf8").trim().split("\n");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line)),
      [
        { type: "git-tag", tag: "v0.2.0", packageName: "rondyr" },
        {
          type: "git-tag",
          tag: "@basaltbytes/emdash-plugin-rondyr@0.1.1",
          packageName: "@basaltbytes/emdash-plugin-rondyr",
        },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
