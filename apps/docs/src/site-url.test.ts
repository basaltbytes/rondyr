import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultSiteUrl, siteUrl } from "./site-url.ts";

test("uses the preview address when RONDYR_DOCS_URL is unset or empty", () => {
  assert.equal(siteUrl(undefined), defaultSiteUrl);
  assert.equal(siteUrl("  "), defaultSiteUrl);
});

test("keeps the origin of the configured address", () => {
  assert.equal(siteUrl("https://docs.example.com"), "https://docs.example.com");
  assert.equal(siteUrl("https://docs.example.com/"), "https://docs.example.com");
});

test("refuses an address with a path, another scheme or no scheme", () => {
  assert.throws(() => siteUrl("https://example.com/docs/"), /must be an origin/u);
  assert.throws(() => siteUrl("ftp://docs.example.com"), /must use HTTPS/u);
  assert.throws(() => siteUrl("docs.example.com"), /must be a URL/u);
});
