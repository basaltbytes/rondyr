import assert from "node:assert/strict";
import { test } from "node:test";

import { listDocuments } from "./repository/documents.ts";
import { sidebar, sidebarProblems } from "./sidebar.ts";

test("lists every page of the repository once", () => {
  assert.deepEqual(sidebarProblems(listDocuments()), []);
});

test("names the line to add for a page missing from the navigation", () => {
  const documents = [...listDocuments(), { path: "docs/glossary.md", id: "glossary" }];
  assert.deepEqual(sidebarProblems(documents), [
    'docs/glossary.md is not in the navigation: add { slug: "glossary" } to a group in apps/docs/src/sidebar.ts.',
  ]);
});

test("reports a navigation line without a page", () => {
  const documents = listDocuments().filter(({ id }) => id !== "email");
  assert.deepEqual(sidebarProblems(documents), [
    'apps/docs/src/sidebar.ts lists "email", which is not a page.',
  ]);
});

test("starts with deployment and ends with contributing", () => {
  const slugs = sidebar.flatMap(({ items }) => items.map(({ slug }) => slug));
  assert.equal(slugs[0], "deployment");
  assert.equal(slugs.at(-1), "contributing");
});
