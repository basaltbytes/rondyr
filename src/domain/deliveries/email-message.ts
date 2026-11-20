import { Option, Schema } from "effect";

import type { SubmissionFields } from "../submissions/submission-fields.ts";
import type { DeliveredSubmission, DeliveryId } from "./delivery.ts";
import { EmailAddress } from "./email.ts";

// The text of the email sent for an accepted submission. It is in French for
// now; a change of language only changes this file.

export interface EmailContent {
  /** Built from the form name only, never from the submission fields. */
  readonly subject: string;
  readonly text: string;
  /** The `email` field of the submission, when it is a single valid address. */
  readonly replyTo: Option.Option<EmailAddress>;
}

export interface DeliveredEmail {
  readonly deliveryId: DeliveryId;
  readonly submission: typeof DeliveredSubmission.Type;
  readonly fields: typeof SubmissionFields.Type;
}

const maxSubjectLength = 150;

const received = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "long",
  timeZone: "UTC",
});

const isAddress = Schema.is(EmailAddress);

// Control characters and Unicode line and paragraph separators.
const lineBreaks = /[\p{Cc}\u2028\u2029]+/gu;
const spaces = /\s+/gu;
// Line breaks in a value are kept as \n. Other control characters are removed.
const valueLineBreaks = /\r\n?|[\u2028\u2029]/gu;
const valueControls = /[^\P{Cc}\n\t]/gu;

/** One line of text: line breaks and control characters become single spaces. */
function oneLine(text: string) {
  return text.replace(lineBreaks, " ").replace(spaces, " ").trim();
}

function multiline(text: string) {
  return text.replace(valueLineBreaks, "\n").replace(valueControls, "");
}

function subjectFor(prefix: string, formName: string) {
  const name = oneLine(formName);
  const subject = name === "" ? prefix : `${prefix} : ${name}`;
  return subject.length > maxSubjectLength ? `${subject.slice(0, maxSubjectLength - 1)}…` : subject;
}

function fieldBlock([name, value]: readonly [string, string]) {
  const text = multiline(value);
  return `${oneLine(name)} :\n${text === "" ? "(vide)" : text}`;
}

/** The subject, the plain text body and the reply address of the email for one delivery. */
export function emailContent(delivery: DeliveredEmail): EmailContent {
  const { submission } = delivery;
  const formName = oneLine(submission.formName);
  const email = delivery.fields["email"];
  const text = [
    `Nouveau message reçu par le formulaire « ${formName} ».`,
    ...Object.entries(delivery.fields).map(fieldBlock),
    [
      "-- ",
      `Formulaire : ${formName}`,
      `Reçu le : ${received.format(submission.receivedAt)}`,
      `Identifiant de livraison : ${delivery.deliveryId}`,
    ].join("\n"),
    "Rondyr peut envoyer deux fois la même livraison. Deux messages qui portent le même identifiant de livraison sont des doublons.",
  ].join("\n\n");
  return {
    subject: subjectFor("Nouveau message", submission.formName),
    text: `${text}\n`,
    replyTo: email !== undefined && isAddress(email) ? Option.some(email) : Option.none(),
  };
}

export interface TestEmail {
  readonly testId: DeliveryId;
  readonly formName: string;
  /** Milliseconds since the epoch. */
  readonly sentAt: number;
}

/** The email that tests a target from the dashboard. Its subject and body say it is a test. */
export function testEmailContent(test: TestEmail): EmailContent {
  const formName = oneLine(test.formName);
  const text = [
    `Message d’essai envoyé depuis le dashboard Rondyr pour le formulaire « ${formName} ».`,
    "Aucun visiteur n’a envoyé ce message. Il vérifie que les e-mails de ce formulaire arrivent à ces destinataires.",
    [
      "-- ",
      `Formulaire : ${formName}`,
      `Envoyé le : ${received.format(test.sentAt)}`,
      `Identifiant d’essai : ${test.testId}`,
    ].join("\n"),
  ].join("\n\n");
  return {
    subject: subjectFor("Message d’essai", test.formName),
    text: `${text}\n`,
    replyTo: Option.none(),
  };
}
