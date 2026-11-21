import assert from "node:assert/strict";
import { test } from "node:test";

import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";

import { remarkDropProductionLine } from "./production-line.ts";

function drop(markdown: string): string {
  const tree = fromMarkdown(markdown);
  remarkDropProductionLine()(tree);
  return toString(tree);
}

test("removes the line of the status block that gives the production address", () => {
  const status = [
    "> **Tagline:** *The gatekeeper for your forms.*",
    "> **Production:** `https://forms.example.com` (stage `prod`).",
    "> **Status:** v0.1 in progress.",
  ].join("\n");
  assert.equal(drop(status), "Tagline: The gatekeeper for your forms.\nStatus: v0.1 in progress.");
});

test("keeps a paragraph that mentions production elsewhere in a line", () => {
  const text = "Deploy to **prod** first.\nThe **Production:** label stays here.";
  assert.equal(drop(text), "Deploy to prod first.\nThe Production: label stays here.");
});
