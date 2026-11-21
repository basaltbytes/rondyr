/**
 * The text of the page that Rondyr shows after an HTML form post, when the form
 * has no success URL. The visitor reads it, so it follows the visitor's language.
 */
export const confirmationPages = {
  en: { title: "Message received", body: "Your message has been recorded." },
  fr: { title: "Message reçu", body: "Votre message a été enregistré." },
} as const;

export type ConfirmationLanguage = keyof typeof confirmationPages;

function isSupported(language: string): language is ConfirmationLanguage {
  return Object.hasOwn(confirmationPages, language);
}

/**
 * The language of the confirmation page for an `Accept-Language` header: the
 * supported language that the visitor prefers, or English. A language with
 * `q=0` is refused, and the first of two equal preferences wins.
 */
export function confirmationLanguage(acceptLanguage: string | undefined): ConfirmationLanguage {
  const preferences = (acceptLanguage ?? "")
    .split(",")
    .map((range) => {
      const [tag = "", ...parameters] = range.split(";").map((part) => part.trim());
      const quality = parameters.find((parameter) => parameter.startsWith("q="))?.slice(2);
      const weight = quality === undefined ? 1 : Number(quality);
      return { language: tag.split("-", 1)[0]?.toLowerCase() ?? "", weight };
    })
    .filter(({ weight }) => weight > 0)
    // Array.prototype.sort is stable, so equal weights keep the order of the header.
    .toSorted((a, b) => b.weight - a.weight);
  const preferred = preferences.map(({ language }) => language).find(isSupported);
  return preferred ?? "en";
}
