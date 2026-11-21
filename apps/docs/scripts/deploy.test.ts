import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureRepository } from "../src/test-support/fixture-repository.ts";
import { builtFor, deployArguments } from "./deploy.ts";

test("deploys to the custom domain of the address", () => {
  assert.deepEqual(deployArguments("https://docs.example.com"), [
    "deploy",
    "--domain",
    "docs.example.com",
  ]);
});

test("deploys to the workers.dev address of the Worker without a custom domain", () => {
  assert.deepEqual(deployArguments("https://rondyr-docs.team.workers.dev/"), ["deploy"]);
  assert.throws(
    () => deployArguments("https://other.team.workers.dev"),
    /starts with rondyr-docs\./u,
  );
});

test("refuses a missing, plain HTTP or path address", () => {
  assert.throws(() => deployArguments(undefined), /Set RONDYR_DOCS_URL/u);
  assert.throws(() => deployArguments(""), /Set RONDYR_DOCS_URL/u);
  assert.throws(() => deployArguments("http://docs.example.com"), /HTTPS origin/u);
  assert.throws(() => deployArguments("https://example.com/docs"), /HTTPS origin/u);
});

test("checks that the build was made for the address", (t) => {
  const dist = fixtureRepository(
    new Map([
      ["sitemap-0.xml", "<urlset><url><loc>https://docs.example.com/</loc></url></urlset>"],
    ]),
  );
  t.after(dist.remove);
  assert.equal(builtFor(dist.root, "https://docs.example.com"), true);
  assert.equal(builtFor(dist.root, "http://localhost:4321"), false);
  assert.equal(builtFor(new URL("missing/", dist.root), "https://docs.example.com"), false);
});
