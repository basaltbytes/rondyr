import { Schema } from "effect";

import type { EmailLanguage } from "./email.ts";

/** A confirmation link stays valid for seven days. */
export const confirmationLifetimeMillis = 7 * 24 * 60 * 60 * 1000;

/**
 * Rondyr sends an address at most this many confirmation emails per UTC day,
 * across every organization, so that nobody can use it to flood a mailbox.
 */
export const confirmationEmailsPerDay = 3;

/** The address whose confirmation email to send again. */
export const ResendConfirmation = Schema.Struct({
  address: Schema.String.check(Schema.isMaxLength(512)),
});

/** 32 random bytes in base64url, the secret of a confirmation link. */
export const ConfirmationToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
);

export const ConfirmRecipient = Schema.Struct({ token: ConfirmationToken });

export const ConfirmationRequestError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("confirmation-invalid") }),
  Schema.Struct({ error: Schema.Literal("recipient-confirmed") }),
  Schema.Struct({ error: Schema.Literal("confirmation-limit") }),
  Schema.Struct({ error: Schema.Literal("email-provider-missing") }),
]);

// The confirmation email has fixed text and the link only: no organization, no
// form, nothing that a member typed, so nobody can use it to carry a message.

const utc = { dateStyle: "long", timeStyle: "short", timeZone: "UTC" } as const;

const copy = {
  en: {
    date: new Intl.DateTimeFormat("en-GB", utc),
    subject: "Confirm your email address for Rondyr",
    intro:
      "Someone added this address as a recipient of the messages of a website form handled by Rondyr. You will get them only after you confirm.",
    open: (until: string) =>
      `To confirm, open this link and press the button. It works once, until ${until} UTC:`,
    ignore: "If you do not want these messages, ignore this email: nothing will be sent to you.",
  },
  fr: {
    date: new Intl.DateTimeFormat("fr-FR", utc),
    subject: "Confirmez votre adresse e-mail pour Rondyr",
    intro:
      "Quelqu’un a ajouté cette adresse aux destinataires des messages d’un formulaire de site web géré par Rondyr. Vous ne les recevrez qu’après avoir confirmé.",
    open: (until: string) =>
      `Pour confirmer, ouvrez ce lien et appuyez sur le bouton. Il sert une fois, jusqu’au ${until} UTC :`,
    ignore: "Si vous ne voulez pas de ces messages, ignorez cet e-mail : rien ne vous sera envoyé.",
  },
} as const;

/** The plain text email that asks the owner of an address to confirm it. */
export function confirmationEmail(link: string, expiresAt: number, language: EmailLanguage) {
  const words = copy[language];
  const text = [words.intro, `${words.open(words.date.format(expiresAt))}\n${link}`, words.ignore];
  return { subject: words.subject, text: `${text.join("\n\n")}\n` };
}
