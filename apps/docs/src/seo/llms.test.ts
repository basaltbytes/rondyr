import assert from "node:assert/strict";
import { test } from "node:test";

import { listDocuments } from "../repository/documents.ts";
import {
  markdownRoute,
  renderDocumentMarkdown,
  renderLandingMarkdown,
  renderLlmsFullTxt,
  renderLlmsTxt,
} from "./llms.ts";

test("lists every documentation page Markdown endpoint in llms.txt with at-a-glance facts", () => {
  const index = renderLlmsTxt("https://rondyr.com");
  assert.match(index, /^# Rondyr\n/u);
  assert.ok(index.includes("## At a glance"));
  assert.ok(index.includes("https://rondyr.com/index.md"));
  assert.ok(index.includes("https://rondyr.com/llms-full.txt"));
  for (const document of listDocuments()) {
    assert.ok(index.includes(`https://rondyr.com${markdownRoute(document.id)}`), document.path);
  }
});

test("renders per-page Markdown with canonical URL and rewritten links", () => {
  const webhooks = renderDocumentMarkdown("https://rondyr.com", "webhooks");
  assert.match(webhooks, /^# Send messages to a webhook\n/u);
  assert.ok(webhooks.includes("Canonical URL: https://rondyr.com/webhooks/"));
  assert.ok(webhooks.includes("https://rondyr.com/deployment/#encryption-key"));
  assert.ok(
    webhooks.includes(
      "https://github.com/basaltbytes/rondyr/blob/main/docs/examples/verify-webhook.ts",
    ),
  );
  assert.equal(webhooks.includes("./screenshots/"), false);
});

test("renders landing Markdown with comparison table and FAQ", () => {
  const landing = renderLandingMarkdown("https://rondyr.com");
  assert.ok(landing.includes("## Message lifecycle"));
  assert.ok(landing.includes("1. **Create a form and describe your business.**"));
  // A step that depends on the message has one item for each message.
  assert.ok(
    landing.includes("3. **A visitor sends a message.**\n   - A sales pitch: This one is from Sam"),
  );
  assert.ok(landing.includes("   - A customer's question: This one is from Ruth"));
  assert.ok(landing.includes("6. One of 2 outcomes.\n   - A sales pitch: **To review.** "));
  assert.ok(landing.includes("   - A customer's question: **Accepted and delivered.** "));
  assert.ok(landing.includes("## Rondyr vs. hosted form backends"));
  assert.ok(landing.includes("## Frequently asked questions"));
  assert.ok(landing.includes("https://rondyr.com/deployment.md"));
});

test("concatenates landing and all documentation pages into llms-full.txt", () => {
  const full = renderLlmsFullTxt("https://rondyr.com");
  assert.match(full, /^# Rondyr Documentation\n/u);
  assert.ok(full.includes("## Rondyr vs. hosted form backends"));
  assert.ok(full.includes("https://rondyr.com/deployment/#encryption-key"));
  assert.equal(full.includes("./screenshots/"), false);
});
