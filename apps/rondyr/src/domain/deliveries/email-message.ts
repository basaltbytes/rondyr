import { Option, Schema } from "effect";

import type { SubmissionFields } from "../submissions/submission-fields.ts";
import type { DeliveredSubmission, DeliveryId } from "./delivery.ts";
import { emailFields, emailMeta, emailParagraph, renderEmailLayout } from "./email-layout.ts";
import { EmailAddress, type EmailLanguage } from "./email.ts";

// The HTML and plain text email sent for an accepted submission, in the language of
// its destination. A new language only adds an entry to `copy`.

export interface EmailContent {
  /** Built from the form name only, never from the submission fields. */
  readonly subject: string;
  readonly html: string;
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

const utc = { dateStyle: "long", timeStyle: "long", timeZone: "UTC" } as const;

// French puts a space before a colon, English does not.
const copy = {
  en: {
    date: new Intl.DateTimeFormat("en-GB", utc),
    colon: ":",
    empty: "(empty)",
    subject: "New message",
    intro: (form: string) => `New message received through the form “${form}”.`,
    form: "Form",
    received: "Received",
    deliveryId: "Delivery ID",
    duplicates:
      "Rondyr may send the same delivery twice. Two messages with the same delivery ID are duplicates.",
    testSubject: "Test message",
    testIntro: (form: string) =>
      `Test message sent from the Rondyr dashboard for the form “${form}”.`,
    testNote:
      "No visitor sent this message. It checks that the emails of this form reach these recipients.",
    sent: "Sent",
    testId: "Test ID",
  },
  fr: {
    date: new Intl.DateTimeFormat("fr-FR", utc),
    colon: " :",
    empty: "(vide)",
    subject: "Nouveau message",
    intro: (form: string) => `Nouveau message reçu par le formulaire « ${form} ».`,
    form: "Formulaire",
    received: "Reçu le",
    deliveryId: "Identifiant de livraison",
    duplicates:
      "Rondyr peut envoyer deux fois la même livraison. Deux messages qui portent le même identifiant de livraison sont des doublons.",
    testSubject: "Message d’essai",
    testIntro: (form: string) =>
      `Message d’essai envoyé depuis le dashboard Rondyr pour le formulaire « ${form} ».`,
    testNote:
      "Aucun visiteur n’a envoyé ce message. Il vérifie que les e-mails de ce formulaire arrivent à ces destinataires.",
    sent: "Envoyé le",
    testId: "Identifiant d’essai",
  },
} as const;

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

function subjectFor(prefix: string, colon: string, formName: string) {
  const name = oneLine(formName);
  const subject = name === "" ? prefix : `${prefix}${colon} ${name}`;
  return subject.length > maxSubjectLength ? `${subject.slice(0, maxSubjectLength - 1)}…` : subject;
}

/**
 * The subject, the plain text body and the reply address of the email for one
 * delivery, written in `language`.
 */
export function emailContent(delivery: DeliveredEmail, language: EmailLanguage): EmailContent {
  const { submission } = delivery;
  const words = copy[language];
  const formName = oneLine(submission.formName);
  const email = delivery.fields["email"];
  const received = words.date.format(submission.receivedAt);
  const subject = subjectFor(words.subject, words.colon, submission.formName);
  const entries = Object.entries(delivery.fields).map(([name, value]) => {
    const lines = multiline(value);
    const empty = lines === "";
    return { label: oneLine(name), value: empty ? words.empty : lines, empty };
  });
  const text = [
    words.intro(formName),
    ...entries.map(({ label, value }) => `${label}${words.colon}\n${value}`),
    [
      "-- ",
      `${words.form}${words.colon} ${formName}`,
      `${words.received}${words.colon} ${received}`,
      `${words.deliveryId}${words.colon} ${delivery.deliveryId}`,
    ].join("\n"),
    words.duplicates,
  ].join("\n\n");
  const html = renderEmailLayout({
    language,
    title: subject,
    maxWidth: 580,
    bodyHtml: [
      emailParagraph(words.intro(formName)),
      emailFields(entries),
      emailMeta([
        { label: `${words.form}${words.colon}`, value: formName },
        { label: `${words.received}${words.colon}`, value: received },
        { label: `${words.deliveryId}${words.colon}`, value: delivery.deliveryId },
      ]),
    ],
    reason: words.duplicates,
  });
  return {
    subject,
    html,
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
export function testEmailContent(test: TestEmail, language: EmailLanguage): EmailContent {
  const words = copy[language];
  const formName = oneLine(test.formName);
  const sent = words.date.format(test.sentAt);
  const subject = subjectFor(words.testSubject, words.colon, test.formName);
  const text = [
    words.testIntro(formName),
    words.testNote,
    [
      "-- ",
      `${words.form}${words.colon} ${formName}`,
      `${words.sent}${words.colon} ${sent}`,
      `${words.testId}${words.colon} ${test.testId}`,
    ].join("\n"),
  ].join("\n\n");
  const html = renderEmailLayout({
    language,
    title: subject,
    maxWidth: 580,
    bodyHtml: [
      emailParagraph(words.testIntro(formName)),
      emailParagraph(words.testNote),
      emailMeta([
        { label: `${words.form}${words.colon}`, value: formName },
        { label: `${words.sent}${words.colon}`, value: sent },
        { label: `${words.testId}${words.colon}`, value: test.testId },
      ]),
    ],
    reason: words.testNote,
  });
  return {
    subject,
    html,
    text: `${text}\n`,
    replyTo: Option.none(),
  };
}
