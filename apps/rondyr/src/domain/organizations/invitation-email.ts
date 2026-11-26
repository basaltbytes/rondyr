import {
  emailParagraph,
  renderEmailLayout,
  type RenderedEmail,
} from "../deliveries/email-layout.ts";
import type { EmailLanguage } from "../deliveries/email.ts";

// The invitation email has fixed text and the link only: no organization name, no
// inviter, nothing that a member typed. A compromised account cannot use it to
// carry its own words to an address.

const utc = { dateStyle: "long", timeStyle: "short", timeZone: "UTC" } as const;

const copy = {
  en: {
    date: new Intl.DateTimeFormat("en-GB", utc),
    subject: "Invitation to Rondyr",
    title: "Invitation to Rondyr",
    greeting: "Hello,",
    intro:
      "Someone invited you to join an organization on Rondyr, where the messages of its website forms are reviewed.",
    open: (until: string) =>
      `Open this link to see the organization and accept. It works once, until ${until} UTC:`,
    action: "View invitation",
    ignore:
      "If you did not expect this invitation, ignore this email: nothing happens without you.",
    reason: "You are receiving this email because an administrator invited this address to Rondyr.",
  },
  fr: {
    date: new Intl.DateTimeFormat("fr-FR", utc),
    subject: "Invitation à Rondyr",
    title: "Invitation à Rondyr",
    greeting: "Bonjour,",
    intro:
      "Quelqu’un vous invite à rejoindre une organisation sur Rondyr, où sont relus les messages des formulaires de son site.",
    open: (until: string) =>
      `Ouvrez ce lien pour voir l’organisation et accepter. Il sert une fois, jusqu’au ${until} UTC :`,
    action: "Voir l’invitation",
    ignore:
      "Si vous n’attendiez pas cette invitation, ignorez cet e-mail : rien ne se passe sans vous.",
    reason: "Vous recevez cet e-mail parce qu’un administrateur a invité cette adresse sur Rondyr.",
  },
} as const;

/** The HTML and plain text email that carries an invitation link. */
export function invitationEmail(
  link: string,
  expiresAt: number,
  language: EmailLanguage,
): RenderedEmail {
  const words = copy[language];
  const open = words.open(words.date.format(expiresAt));
  const text = [words.greeting, words.intro, `${open}\n${link}`, words.ignore];
  const html = renderEmailLayout({
    language,
    title: words.title,
    bodyHtml: [
      emailParagraph(words.greeting),
      emailParagraph(words.intro),
      emailParagraph(open),
      emailParagraph(words.ignore),
    ],
    action: { label: words.action, url: link },
    reason: words.reason,
  });
  return { subject: words.subject, html, text: `${text.join("\n\n")}\n` };
}
