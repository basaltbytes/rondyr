import { assert, it } from "@effect/vitest";

import { chooseLanguage } from "./language.ts";

it("shows the stored choice, whatever the languages of the browser", () => {
  assert.strictEqual(chooseLanguage("fr", ["en-GB", "en"]), "fr");
});

it("shows French in a browser that prefers French", () => {
  assert.strictEqual(chooseLanguage(null, ["fr", "en"]), "fr");
});

it("shows English in a browser that prefers English", () => {
  assert.strictEqual(chooseLanguage(null, ["en", "fr"]), "en");
});

it("shows French for a regional tag of French", () => {
  assert.strictEqual(chooseLanguage(null, ["fr-CA"]), "fr");
});

it("skips a language that the interface does not have", () => {
  assert.strictEqual(chooseLanguage(null, ["de-DE", "fr-FR", "en"]), "fr");
});

it("shows English when the interface has none of the languages of the browser", () => {
  assert.strictEqual(chooseLanguage(null, ["de-DE", "es"]), "en");
});

it("ignores a stored value that is not a language of the interface", () => {
  assert.strictEqual(chooseLanguage("de", ["fr-FR"]), "fr");
});
