import { assert, it } from "@effect/vitest";

import { confirmationLanguage } from "./confirmation-page.ts";

it("answers in English without an Accept-Language header", () => {
  assert.strictEqual(confirmationLanguage(undefined), "en");
});

it("answers in French to a browser that prefers French", () => {
  assert.strictEqual(confirmationLanguage("fr-FR,fr;q=0.9,en;q=0.8"), "fr");
});

it("answers in English to a browser that prefers English over French", () => {
  assert.strictEqual(confirmationLanguage("en-GB,fr;q=0.5"), "en");
});

it("answers in the best supported language when the first choice is not supported", () => {
  assert.strictEqual(confirmationLanguage("de-DE,fr;q=0.7,en;q=0.3"), "fr");
});

it("answers in English when no language of the header is supported", () => {
  assert.strictEqual(confirmationLanguage("de-DE,es;q=0.8"), "en");
});

it("does not answer in a language that the browser refuses with q=0", () => {
  assert.strictEqual(confirmationLanguage("fr;q=0,de"), "en");
});

it("keeps the order of the header for two languages of equal preference", () => {
  assert.strictEqual(confirmationLanguage("fr,en"), "fr");
});

it("ignores a quality that is not a number", () => {
  assert.strictEqual(confirmationLanguage("fr;q=high,en;q=0.5"), "en");
});
