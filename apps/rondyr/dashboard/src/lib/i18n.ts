import { createInstance } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";

import en from "~/locales/en/translation.json";
import fr from "~/locales/fr/translation.json";

import { formats } from "./format.ts";
import { chooseLanguage } from "./language.ts";
import type { Language } from "./language.ts";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}

// Each file is typed against the other, so a missing or an extra key fails the type check.
const english: typeof fr = en;
const french: typeof en = fr;

const storageKey = "rondyr-language";

function storedLanguage() {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

// The resources are in the bundle, the choice is read before the first paint and
// the instance starts without a timer, so the page never shows the other language first.
const initial = chooseLanguage(storedLanguage(), window.navigator.languages);
const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: initial,
  fallbackLng: "en",
  resources: { en: { translation: english }, fr: { translation: french } },
  initAsync: false,
  // React escapes the values that it renders.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
document.documentElement.lang = initial;
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

/** Shows the interface in a language at once, and remembers the choice. */
export function setLanguage(language: Language) {
  try {
    window.localStorage.setItem(storageKey, language);
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
  void i18n.changeLanguage(language);
}

/** The language that the interface shows. */
export function useLanguage(): Language {
  const { i18n: current } = useTranslation();
  return chooseLanguage(current.language, []);
}

/** The formats of dates and numbers for the language that the interface shows. */
export function useFormats() {
  return formats[useLanguage()];
}
