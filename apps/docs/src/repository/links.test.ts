import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

import { fixtureRepository } from "../test-support/fixture-repository.ts";
import { remarkRepositoryLinks, resolveLink } from "./links.ts";

const repository = fixtureRepository(
  new Map([
    ["architecture.md", "# Rondyr: technical architecture\n\n## 5. Intelligent classification\n"],
    ["README.md", "# Rondyr\n\n## Quick start\n"],
    ["LICENSE", "AGPL\n"],
    ["docs/deployment.md", "# Deployment\n\n## Fresh account checklist\n"],
    ["docs/webhooks.md", "# Webhooks\n\n## Signature\n"],
    ["docs/examples/verify-webhook.ts", "export {};\n"],
    ["docs/brand/rondyr.svg", "<svg/>\n"],
    ["apps/rondyr/.env.example", "A=1\n"],
  ]),
);
test.after(repository.remove);
const { root } = repository;
const github = "https://github.com/basaltbytes/rondyr";

test("sends a link to another page to its route, with the anchor", () => {
  assert.deepEqual(resolveLink("./webhooks.md#signature", "docs/deployment.md", false, root), {
    kind: "rewritten",
    url: "/webhooks/#signature",
    title: "Webhooks",
  });
  assert.deepEqual(resolveLink("webhooks.md", "docs/deployment.md", false, root), {
    kind: "rewritten",
    url: "/webhooks/",
    title: "Webhooks",
  });
});

test("sends a link to another file of the repository to GitHub", () => {
  assert.deepEqual(
    resolveLink("../architecture.md#5-intelligent-classification", "docs/webhooks.md", false, root),
    {
      kind: "rewritten",
      url: `${github}/blob/main/architecture.md#5-intelligent-classification`,
    },
  );
  assert.deepEqual(resolveLink("./examples/verify-webhook.ts", "docs/webhooks.md", false, root), {
    kind: "rewritten",
    url: `${github}/blob/main/docs/examples/verify-webhook.ts`,
  });
  assert.deepEqual(resolveLink("../LICENSE", "docs/webhooks.md", false, root), {
    kind: "rewritten",
    url: `${github}/blob/main/LICENSE`,
  });
  assert.deepEqual(resolveLink("../apps/rondyr/.env.example", "docs/deployment.md", false, root), {
    kind: "rewritten",
    url: `${github}/blob/main/apps/rondyr/.env.example`,
  });
  assert.deepEqual(resolveLink("../README.md#quick-start", "docs/deployment.md", false, root), {
    kind: "rewritten",
    url: `${github}/blob/main/README.md#quick-start`,
  });
  assert.deepEqual(resolveLink("./examples/", "docs/webhooks.md", false, root), {
    kind: "rewritten",
    url: `${github}/tree/main/docs/examples`,
  });
  assert.deepEqual(resolveLink("..", "docs/webhooks.md", false, root), {
    kind: "rewritten",
    url: `${github}/tree/main`,
  });
});

test("leaves absolute URLs, site paths, anchors and images as they are", () => {
  for (const url of ["https://alchemy.run", "mailto:a@example.com", "/api/", "#signature", ""]) {
    assert.deepEqual(resolveLink(url, "docs/webhooks.md", false, root), { kind: "unchanged" }, url);
  }
  assert.deepEqual(resolveLink("./brand/rondyr.svg", "docs/webhooks.md", true, root), {
    kind: "unchanged",
  });
});

test("reports a missing file, a missing heading and a path outside the repository", () => {
  assert.deepEqual(resolveLink("./emails.md", "docs/webhooks.md", false, root), {
    kind: "broken",
    reason: "./emails.md points to docs/emails.md, which does not exist",
  });
  assert.deepEqual(resolveLink("./brand/missing.svg", "docs/webhooks.md", true, root), {
    kind: "broken",
    reason: "./brand/missing.svg points to docs/brand/missing.svg, which does not exist",
  });
  assert.deepEqual(resolveLink("../README.md#rate-limits", "docs/webhooks.md", false, root), {
    kind: "broken",
    reason: "../README.md#rate-limits points to a heading that README.md does not have",
  });
  assert.deepEqual(resolveLink("../../outside.md", "docs/webhooks.md", false, root), {
    kind: "broken",
    reason: "../../outside.md points outside the repository",
  });
});

function render(path: string, markdown: string) {
  const tree = fromMarkdown(markdown);
  remarkRepositoryLinks(root)()(tree, new VFile({ path: fileURLToPath(new URL(path, root)) }));
  const links: string[] = [];
  visit(tree, "link", (link) => {
    links.push(`${toString(link)} -> ${link.url}`);
  });
  return links;
}

test("rewrites the links of a page and shows page titles instead of file names", () => {
  const links = render(
    "docs/webhooks.md",
    [
      "[deployment.md](./deployment.md#fresh-account-checklist) explains it.",
      "See [`docs/deployment.md`](./deployment.md) and [the checklist](deployment.md).",
      "[verify-webhook.ts](./examples/verify-webhook.ts)",
      "[ref][deploy]",
      "",
      "[deploy]: ../architecture.md",
    ].join("\n"),
  );
  assert.deepEqual(links, [
    "Deployment -> /deployment/#fresh-account-checklist",
    "Deployment -> /deployment/",
    "the checklist -> /deployment/",
    `verify-webhook.ts -> ${github}/blob/main/docs/examples/verify-webhook.ts`,
  ]);
});

test("fails with every broken link of a page and its line", () => {
  assert.throws(
    () => render("docs/webhooks.md", "[a](./a.md)\n\n[b](../README.md#nope)\n"),
    (error: Error) => {
      assert.match(error.message, /docs\/webhooks\.md:1: \.\/a\.md points to docs\/a\.md/u);
      assert.match(
        error.message,
        /docs\/webhooks\.md:3: \.\.\/README\.md#nope points to a heading/u,
      );
      return true;
    },
  );
});

test("leaves files that are not pages alone", () => {
  assert.deepEqual(render("README.md", "[a](./missing.md)\n"), ["a -> ./missing.md"]);
});
