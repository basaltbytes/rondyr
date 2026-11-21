import { assert, it } from "@effect/vitest";

import {
  excerptOf,
  listDay,
  readMessage,
  senderOf,
  splitFields,
  subjectOf,
} from "./message-preview.ts";

// Local time, in the Europe/Paris zone of dashboard/vitest.config.ts.
const at = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).getTime();

it("names the sender with the first name and the name", () => {
  const sender = senderOf({ prenom: "Hugo", nom: "Lambert" });

  assert.strictEqual(sender.name, "Hugo Lambert");
});

it("names the sender with the only name field", () => {
  const sender = senderOf({ name: "Ada Lovelace" });

  assert.strictEqual(sender.name, "Ada Lovelace");
});

it("finds the address of the sender by its value, under any field name", () => {
  const sender = senderOf({ courriel: "ada@example.org" });

  assert.strictEqual(sender.email, "ada@example.org");
});

it("removes the spaces around the address of the sender", () => {
  const sender = senderOf({ email: " ada@example.org " });

  assert.strictEqual(sender.email, "ada@example.org");
});

it("labels the sender with the name when there is a name and an address", () => {
  const sender = senderOf({ nom: "Ada", email: "ada@example.org" });

  assert.strictEqual(sender.label, "Ada");
});

it("labels the sender with the address when there is no name", () => {
  const sender = senderOf({ email: "ada@example.org", message: "Bonjour" });

  assert.strictEqual(sender.label, "ada@example.org");
});

it("has no label for a sender without a name or an address", () => {
  const sender = senderOf({ message: "rappelez-moi" });

  assert.strictEqual(sender.label, null);
});

it("takes the message field as the body and keeps the other fields in order", () => {
  const split = splitFields({ nom: "Ada", message: "Bonjour.", telephone: "06 12 34 56 78" });

  assert.deepEqual(split, {
    body: ["message", "Bonjour."],
    details: [
      ["nom", "Ada"],
      ["telephone", "06 12 34 56 78"],
    ],
  });
});

it("takes the only field as the body, whatever its name", () => {
  const split = splitFields({ note: "rappelez-moi" });

  assert.deepEqual(split.body, ["note", "rappelez-moi"]);
});

it("has no body when several fields have no message name", () => {
  const split = splitFields({ quantite: "250", couleur: "Blanc" });

  assert.strictEqual(split.body, null);
});

it("reads the subject from the subject field", () => {
  assert.strictEqual(
    subjectOf({ sujet: "Stage de juillet", message: "Bonjour." }),
    "Stage de juillet",
  );
});

it("has no subject without a subject field", () => {
  assert.strictEqual(subjectOf({ message: "Bonjour." }), null);
});

it("puts the body on one line for the excerpt", () => {
  const excerpt = excerptOf({ message: "Bonjour,\n\nune   question." });

  assert.strictEqual(excerpt, "Bonjour, une question.");
});

it("builds the excerpt from the other fields, without the sender, when there is no body", () => {
  const excerpt = excerptOf({
    nom: "Ada",
    email: "ada@example.org",
    quantite: "250",
    couleur: "Blanc",
  });

  assert.strictEqual(excerpt, "250 · Blanc");
});

it("leaves out of the details the fields that the heading and the body show", () => {
  const message = readMessage({
    prenom: "Hugo",
    nom: "Lambert",
    email: "hugo@example.org",
    sujet: "Stage",
    site_web: "http://spam.example",
    message: "Bonjour.",
  });

  // A filled honeypot field is in neither, so the reviewer still sees it.
  assert.deepEqual(message.details, [["site_web", "http://spam.example"]]);
});

it("keeps every field as a detail when none is a sender, a subject or a body", () => {
  const message = readMessage({ societe: "Maison Verdier", quantite: "250" });

  assert.deepEqual(message.details, [
    ["societe", "Maison Verdier"],
    ["quantite", "250"],
  ]);
});

it("counts a message received today as today", () => {
  assert.strictEqual(listDay(at(2026, 11, 20, 9, 5), at(2026, 11, 20, 17, 30)), "today");
});

it("counts a message received at midnight today as today", () => {
  assert.strictEqual(listDay(at(2026, 11, 20, 0, 0), at(2026, 11, 20, 17, 30)), "today");
});

it("counts a message received in the last minute of yesterday as yesterday", () => {
  assert.strictEqual(listDay(at(2026, 11, 19, 23, 59), at(2026, 11, 20, 17, 30)), "yesterday");
});

it("counts a message received at midnight yesterday as yesterday", () => {
  assert.strictEqual(listDay(at(2026, 11, 19, 0, 0), at(2026, 11, 20, 17, 30)), "yesterday");
});

it("counts a message received in the last minute of the day before yesterday as earlier", () => {
  assert.strictEqual(listDay(at(2026, 11, 18, 23, 59), at(2026, 11, 20, 17, 30)), "earlier");
});

it("counts a message from two days ago as earlier when yesterday had 23 hours", () => {
  // Clocks went forward on 29 March 2026, so that day was an hour short.
  assert.strictEqual(listDay(at(2026, 3, 28, 23, 30), at(2026, 3, 30, 10, 0)), "earlier");
});

it("counts a message at midnight yesterday as yesterday when yesterday had 25 hours", () => {
  // Clocks went back on 25 October 2026, so that day was an hour long.
  assert.strictEqual(listDay(at(2026, 10, 25, 0, 0), at(2026, 10, 26, 10, 0)), "yesterday");
});
