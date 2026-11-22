import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { logoVariant } from "./brand.ts";
import { repositoryPath } from "./repository/documents.ts";

const wordmark = readFileSync(repositoryPath("docs/brand/rondyr.svg"), "utf8");

test("the light copy of the wordmark has only its own colors", () => {
  const light = logoVariant(wordmark, "light");
  assert.doesNotMatch(light, /<style>|prefers-color-scheme/u);
  assert.match(light, /class="rondyr-ink" color="#202626"/u);
});

test("the dark copy applies the dark colors without the media query", () => {
  const dark = logoVariant(wordmark, "dark");
  assert.doesNotMatch(dark, /prefers-color-scheme/u);
  assert.match(dark, /<style>\s*\.rondyr-ink \{ color: #f2f0e9; \}\s*<\/style>/u);
});

test("refuses a logo without a dark color block", () => {
  assert.throws(
    () => logoVariant("<svg/>", "dark"),
    /no `@media \(prefers-color-scheme: dark\)` style block/u,
  );
});
