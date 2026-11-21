import { Schema } from "effect";

import { EmailLanguage } from "../deliveries/email.ts";
import { AccountEmail, AccountPassword } from "./account.ts";

/** A password reset link works for one hour. */
export const passwordResetLifetimeMillis = 60 * 60 * 1000;

/**
 * Rondyr emails an account at most this many reset links in 24 hours, so that
 * nobody can use the form to flood a mailbox.
 */
export const passwordResetEmailsPerDay = 3;

/** 32 random bytes in base64url, the secret of a reset link. */
export const PasswordResetToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
);

/**
 * Ask for a reset link. The answer is the same whether an account has the
 * address or not, so the form does not tell who has an account.
 */
export const RequestPasswordReset = Schema.Struct({
  email: AccountEmail,
  /** The language of the email. English when absent. */
  language: Schema.optionalKey(EmailLanguage),
});

/** Choose a new password with the secret of a link, with the rules of every account. */
export const CompletePasswordReset = Schema.Struct({
  token: PasswordResetToken,
  password: AccountPassword,
});

export const PasswordResetRequestError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("reset-invalid") }),
  Schema.Struct({ error: Schema.Literal("email-provider-missing") }),
]);

// The reset email has fixed text and the link only. It names no organization.

const utc = { dateStyle: "long", timeStyle: "short", timeZone: "UTC" } as const;

const copy = {
  en: {
    date: new Intl.DateTimeFormat("en-GB", utc),
    subject: "Reset your Rondyr password",
    intro: "Someone asked to reset the password of the Rondyr account that uses this address.",
    open: (until: string) =>
      `To choose a new password, open this link. It works once, until ${until} UTC, and signs the account out everywhere:`,
    ignore: "If you did not ask for it, ignore this email: your password stays the same.",
  },
  fr: {
    date: new Intl.DateTimeFormat("fr-FR", utc),
    subject: "Réinitialisez votre mot de passe Rondyr",
    intro:
      "Quelqu’un a demandé à réinitialiser le mot de passe du compte Rondyr qui utilise cette adresse.",
    open: (until: string) =>
      `Pour choisir un nouveau mot de passe, ouvrez ce lien. Il sert une fois, jusqu’au ${until} UTC, et déconnecte le compte partout :`,
    ignore: "Si vous n’avez rien demandé, ignorez cet e-mail : votre mot de passe ne change pas.",
  },
} as const;

/** The plain text email that carries a reset link. */
export function passwordResetEmail(link: string, expiresAt: number, language: EmailLanguage) {
  const words = copy[language];
  const text = [words.intro, `${words.open(words.date.format(expiresAt))}\n${link}`, words.ignore];
  return { subject: words.subject, text: `${text.join("\n\n")}\n` };
}
