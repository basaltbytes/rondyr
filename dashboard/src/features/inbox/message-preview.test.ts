import { assert, it } from "@effect/vitest";

import {
  excerptOf,
  listTime,
  readMessage,
  senderOf,
  splitFields,
  subjectOf,
} from "./message-preview.ts";

it("reads the sender from the usual field names", () => {
  assert.deepEqual(senderOf({ prenom: "Hugo", nom: "Lambert", email: "hugo@example.org" }), {
    name: "Hugo Lambert",
    email: "hugo@example.org",
    label: "Hugo Lambert",
  });
  assert.deepEqual(senderOf({ name: "Ada", courriel: " ada@example.org " }), {
    name: "Ada",
    email: "ada@example.org",
    label: "Ada",
  });
});

it("falls back to the address, then to no sender", () => {
  assert.strictEqual(
    senderOf({ adresse: "ada@example.org", message: "Bonjour" }).label,
    "ada@example.org",
  );
  assert.deepEqual(senderOf({ message: "rappelez-moi" }), { name: null, email: null, label: null });
});

it("separates the body of a message from its other fields", () => {
  const fields = { nom: "Ada", sujet: "Stage", message: "Bonjour,\n\nune question." };
  assert.deepEqual(splitFields(fields), {
    body: ["message", "Bonjour,\n\nune question."],
    details: [
      ["nom", "Ada"],
      ["sujet", "Stage"],
    ],
  });
  assert.strictEqual(subjectOf(fields), "Stage");
  assert.strictEqual(excerptOf(fields), "Bonjour, une question.");
});

it("shows each field of a message once", () => {
  const message = readMessage({
    prenom: "Hugo",
    nom: "Lambert",
    email: "hugo@example.org",
    sujet: "Stage",
    site_web: "http://spam.example",
    message: "Bonjour.",
  });
  assert.strictEqual(message.sender.label, "Hugo Lambert");
  assert.strictEqual(message.subject, "Stage");
  assert.strictEqual(message.body, "Bonjour.");
  // The honeypot field is not part of the heading, so it stays visible.
  assert.deepEqual(message.details, [["site_web", "http://spam.example"]]);
});

it("keeps every field that is not in the heading", () => {
  const message = readMessage({ societe: "Maison Verdier", quantite: "250", couleur: "Blanc" });
  assert.strictEqual(message.sender.label, null);
  assert.strictEqual(message.body, null);
  assert.deepEqual(message.details, [
    ["societe", "Maison Verdier"],
    ["quantite", "250"],
    ["couleur", "Blanc"],
  ]);
});

it("uses the only field as the body", () => {
  assert.deepEqual(splitFields({ note: "rappelez-moi" }), {
    body: ["note", "rappelez-moi"],
    details: [],
  });
});

it("builds an excerpt without the sender when no field is a body", () => {
  const fields = { nom: "Ada", email: "ada@example.org", quantite: "250", couleur: "Blanc" };
  assert.strictEqual(splitFields(fields).body, null);
  assert.strictEqual(excerptOf(fields), "250 · Blanc");
});

it("shows the time today, then the day", () => {
  const now = new Date(2026, 10, 20, 17, 30).getTime();
  assert.strictEqual(listTime(new Date(2026, 10, 20, 9, 5).getTime(), now), "09:05");
  assert.strictEqual(listTime(new Date(2026, 10, 19, 23, 59).getTime(), now), "hier");
  assert.strictEqual(listTime(new Date(2026, 10, 14, 12, 0).getTime(), now), "14 nov.");
});
