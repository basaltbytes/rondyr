import { assert, it } from "@effect/vitest";

import { SubmissionId } from "../submissions/submission.id.ts";
import { DeliveryId } from "./delivery.ts";
import { emailContent, testEmailContent } from "./email-message.ts";

const deliveryId = DeliveryId.make("0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11");

// Received on 20 November 2026 at 14:03:00 UTC.
const delivery = {
  deliveryId,
  submission: {
    id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b01"),
    receivedAt: 1_795_183_380_000,
    formPublicId: "classes",
    formName: "Classes",
  },
  fields: { message: "Is there room in the pottery class?" },
};

const test = { testId: deliveryId, formName: "Classes", sentAt: 1_795_183_380_000 };

it("writes the email of a delivery in English", () => {
  const email = emailContent(delivery, "en");

  assert.deepEqual(
    [email.subject, email.text],
    [
      "New message: Classes",
      [
        "New message received through the form “Classes”.",
        "",
        "message:",
        "Is there room in the pottery class?",
        "",
        "-- ",
        "Form: Classes",
        "Received: 20 November 2026 at 14:03:00 UTC",
        "Delivery ID: 0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11",
        "",
        "Rondyr may send the same delivery twice. Two messages with the same delivery ID are duplicates.",
        "",
      ].join("\n"),
    ],
  );
});

it("writes the email of a delivery in French", () => {
  const email = emailContent(delivery, "fr");

  assert.deepEqual(
    [email.subject, email.text],
    [
      "Nouveau message : Classes",
      [
        "Nouveau message reçu par le formulaire « Classes ».",
        "",
        "message :",
        "Is there room in the pottery class?",
        "",
        "-- ",
        "Formulaire : Classes",
        "Reçu le : 20 novembre 2026 à 14:03:00 UTC",
        "Identifiant de livraison : 0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11",
        "",
        "Rondyr peut envoyer deux fois la même livraison. Deux messages qui portent le même identifiant de livraison sont des doublons.",
        "",
      ].join("\n"),
    ],
  );
});

it("marks an empty field with the word of the email's language", () => {
  const email = emailContent({ ...delivery, fields: { phone: "" } }, "fr");

  assert.include(email.text, "phone :\n(vide)");
});

it("writes the test email in English", () => {
  const email = testEmailContent(test, "en");

  assert.deepEqual(
    [email.subject, email.text],
    [
      "Test message: Classes",
      [
        "Test message sent from the Rondyr dashboard for the form “Classes”.",
        "",
        "No visitor sent this message. It checks that the emails of this form reach these recipients.",
        "",
        "-- ",
        "Form: Classes",
        "Sent: 20 November 2026 at 14:03:00 UTC",
        "Test ID: 0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11",
        "",
      ].join("\n"),
    ],
  );
});

it("writes the test email in French", () => {
  const email = testEmailContent(test, "fr");

  assert.deepEqual(
    [email.subject, email.text],
    [
      "Message d’essai : Classes",
      [
        "Message d’essai envoyé depuis le dashboard Rondyr pour le formulaire « Classes ».",
        "",
        "Aucun visiteur n’a envoyé ce message. Il vérifie que les e-mails de ce formulaire arrivent à ces destinataires.",
        "",
        "-- ",
        "Formulaire : Classes",
        "Envoyé le : 20 novembre 2026 à 14:03:00 UTC",
        "Identifiant d’essai : 0f6c1a62-6b8e-4c43-9f5e-2d3a9b7c4e11",
        "",
      ].join("\n"),
    ],
  );
});
