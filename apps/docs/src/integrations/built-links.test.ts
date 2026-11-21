import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixtureRepository } from "../test-support/fixture-repository.ts";
import { findBrokenLinks } from "./built-links.ts";

const page = (body: string): string =>
  `<!doctype html><html><head></head><body>${body}</body></html>`;

test("accepts links to built pages, anchors and files", (t) => {
  const site = fixtureRepository(
    new Map([
      [
        "index.html",
        page(
          '<a href="/api/#tokens">API</a><a href="api/">API</a><img src="/logo.svg"><a href="https://github.com/">GitHub</a><link rel="canonical" href="/elsewhere/">',
        ),
      ],
      [
        "api/index.html",
        page('<h2 id="tokens">Tokens</h2><a href="#tokens">Here</a><a href="../">Home</a>'),
      ],
      ["logo.svg", "<svg/>"],
    ]),
  );
  t.after(site.remove);
  assert.deepEqual(findBrokenLinks(fileURLToPath(site.root), "https://docs.example.com"), []);
});

test("reports a missing page, a missing file and a missing anchor", (t) => {
  const site = fixtureRepository(
    new Map([
      [
        "index.html",
        page(
          '<a href="/missing/">x</a><img src="/missing.svg"><a href="/api/#nope">y</a><a href="https://docs.example.com/gone/">z</a>',
        ),
      ],
      [
        "api/index.html",
        page('<a href="#also-nope">z</a><link rel="stylesheet" href="/_astro/gone.css">'),
      ],
    ]),
  );
  t.after(site.remove);
  assert.deepEqual(
    findBrokenLinks(fileURLToPath(site.root), "https://docs.example.com").toSorted(),
    [
      "/: /api/#nope points to an anchor that /api/ does not have",
      "/: /missing.svg has no page or file",
      "/: /missing/ has no page or file",
      "/: https://docs.example.com/gone/ has no page or file",
      "/api/: #also-nope points to an anchor that /api/ does not have",
      "/api/: /_astro/gone.css has no page or file",
    ],
  );
});
