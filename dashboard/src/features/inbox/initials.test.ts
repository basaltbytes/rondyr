import { assert, it } from "@effect/vitest";

import { initialsOf } from "./initials.ts";

it("takes the first letter of each of two words", () => {
  assert.strictEqual(initialsOf("Maison Verdier"), "MV");
});

it("takes the first two words of a longer name", () => {
  assert.strictEqual(initialsOf("Atelier Terre Feu"), "AT");
});

it("takes one letter from a name of one word", () => {
  assert.strictEqual(initialsOf("Rondyr"), "R");
});

it("skips the punctuation between two words", () => {
  assert.strictEqual(initialsOf("Terre & Feu"), "TF");
});

it("keeps the accent of a first letter", () => {
  assert.strictEqual(initialsOf("École Élan"), "ÉÉ");
});

it("writes the initials of a lower-case name in capitals", () => {
  assert.strictEqual(initialsOf("maison verdier"), "MV");
});

it("gives a question mark for an empty name", () => {
  assert.strictEqual(initialsOf(""), "?");
});

it("gives a question mark for a name made of symbols only", () => {
  assert.strictEqual(initialsOf("& / !"), "?");
});
