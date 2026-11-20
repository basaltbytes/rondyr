export const languages = ["en", "fr"] as const;

export type Language = (typeof languages)[number];

function languageOf(tag: string) {
  const primary = tag.toLowerCase().split("-")[0];
  return languages.find((language) => language === primary);
}

/**
 * The language of the interface: the stored choice, else the first language of
 * the browser that the interface has, else English.
 */
export function chooseLanguage(
  stored: string | null,
  browserLanguages: readonly string[],
): Language {
  const choice = languages.find((language) => language === stored);
  if (choice !== undefined) return choice;
  for (const tag of browserLanguages) {
    const language = languageOf(tag);
    if (language !== undefined) return language;
  }
  return "en";
}
