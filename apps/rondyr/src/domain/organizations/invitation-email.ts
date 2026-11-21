import type { EmailLanguage } from "../deliveries/email.ts";

// The invitation email has fixed text and the link only: no organization name, no
// inviter, nothing that a member typed. A compromised account cannot use it to
// carry its own words to an address.

const utc = { dateStyle: "long", timeStyle: "short", timeZone: "UTC" } as const;

const copy = {
  en: {
    date: new Intl.DateTimeFormat("en-GB", utc),
    subject: "Invitation to Rondyr",
    intro:
      "Someone invited you to join an organization on Rondyr, where the messages of its website forms are reviewed.",
    open: (until: string) =>
      `Open this link to see the organization and accept. It works once, until ${until} UTC:`,
    ignore:
      "If you did not expect this invitation, ignore this email: nothing happens without you.",
  },
  fr: {
    date: new Intl.DateTimeFormat("fr-FR", utc),
    subject: "Invitation à Rondyr",
    intro:
      "Quelqu’un vous invite à rejoindre une organisation sur Rondyr, où sont relus les messages des formulaires de son site.",
    open: (until: string) =>
      `Ouvrez ce lien pour voir l’organisation et accepter. Il sert une fois, jusqu’au ${until} UTC :`,
    ignore:
      "Si vous n’attendiez pas cette invitation, ignorez cet e-mail : rien ne se passe sans vous.",
  },
} as const;

/** The plain text email that carries an invitation link. */
export function invitationEmail(link: string, expiresAt: number, language: EmailLanguage) {
  const words = copy[language];
  const text = [words.intro, `${words.open(words.date.format(expiresAt))}\n${link}`, words.ignore];
  return { subject: words.subject, text: `${text.join("\n\n")}\n` };
}
