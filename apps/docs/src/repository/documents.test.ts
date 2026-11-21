import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureRepository } from "../test-support/fixture-repository.ts";
import { documentId, listDocuments, pageRoute, parseDocument } from "./documents.ts";

test("takes the title from the first heading and the description from the first paragraph", () => {
  const source =
    "# Webhooks\n\nRondyr sends each accepted message.\nIt signs it.\n\n## Setup\n\nText.\n";
  assert.deepEqual(parseDocument("docs/webhooks.md", source), {
    title: "Webhooks",
    description: "Rondyr sends each accepted message. It signs it.",
    body: "Rondyr sends each accepted message.\nIt signs it.\n\n## Setup\n\nText.\n",
  });
});

test("reads the description as plain text and keeps whole sentences of a long paragraph", () => {
  const long = "word ".repeat(40).trim();
  const source = `# API tokens\n\nAn admin opens **Settings** and gets \`403\`. ${long}. Last sentence.\n`;
  const { description } = parseDocument("docs/api.md", source);
  assert.equal(description, "An admin opens Settings and gets 403.");
});

test("takes the first paragraph after a block quote or a heading", () => {
  const source = "# Operations\n\n> Status block\n\n## Queue backlog\n\nOpen **Status**.\n";
  assert.equal(parseDocument("docs/operations.md", source).description, "Open Status.");
});

test("refuses a page without a first-level heading", () => {
  assert.throws(
    () => parseDocument("docs/notes.md", "## Notes\n\nText.\n"),
    /docs\/notes\.md has no first-level heading/u,
  );
});

test("serves docs/*.md and architecture.md at their name, and no other file", () => {
  assert.equal(documentId("docs/email.md"), "email");
  assert.equal(documentId("docs/guides/forms.md"), "guides/forms");
  assert.equal(documentId("architecture.md"), "architecture");
  assert.equal(documentId("README.md"), null);
  assert.equal(documentId("docs/examples/verify-webhook.ts"), null);
  assert.equal(pageRoute("email"), "/email/");
});

test("lists every Markdown file under docs/ with architecture.md", (t) => {
  const repository = fixtureRepository(
    new Map([
      ["architecture.md", "# Architecture\n"],
      ["README.md", "# Readme\n"],
      ["docs/api.md", "# API\n"],
      ["docs/guides/forms.md", "# Forms\n"],
      ["docs/examples/verify.ts", "export {};\n"],
    ]),
  );
  t.after(repository.remove);
  assert.deepEqual(listDocuments(repository.root), [
    { path: "architecture.md", id: "architecture" },
    { path: "docs/api.md", id: "api" },
    { path: "docs/guides/forms.md", id: "guides/forms" },
  ]);
});

test("refuses two files served at the same address", (t) => {
  const repository = fixtureRepository(
    new Map([
      ["architecture.md", "# Architecture\n"],
      ["docs/architecture.md", "# Another architecture\n"],
    ]),
  );
  t.after(repository.remove);
  assert.throws(() => listDocuments(repository.root), /would both be served at \/architecture\//u);
});
