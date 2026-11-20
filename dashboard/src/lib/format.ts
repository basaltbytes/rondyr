import type { Language } from "./language.ts";

function formatsFor(locale: string) {
  const timestamp = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
  const shortDateTime = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const longDateTime = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" });
  const timeOfDay = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const dayOfYear = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const count = new Intl.NumberFormat(locale);
  const seconds = new Intl.NumberFormat(locale, { style: "unit", unit: "second" });
  const minutes = new Intl.NumberFormat(locale, { style: "unit", unit: "minute" });
  const hours = new Intl.NumberFormat(locale, { style: "unit", unit: "hour" });

  return {
    /** A date and a time to the second, such as "20/11/2026, 17:30:05". */
    timestamp: (at: number) => timestamp.format(at),
    /** A date and a time to the minute, such as "20/11/2026, 17:30". */
    shortDateTime: (at: number) => shortDateTime.format(at),
    /** A date in full and a time, such as "20 November 2026 at 17:30". */
    longDateTime: (at: number) => longDateTime.format(at),
    /** A time of the day, such as "09:05". */
    timeOfDay: (at: number) => timeOfDay.format(at),
    /** A day without its year, such as "18 Nov". */
    dayOfYear: (at: number) => dayOfYear.format(at),
    count: (value: number) => count.format(value),
    /** A duration in whole seconds, minutes or hours: the largest unit that fits. */
    age(millis: number) {
      const elapsed = Math.floor(millis / 1000);
      if (elapsed < 60) return seconds.format(elapsed);
      if (elapsed < 3600) return minutes.format(Math.floor(elapsed / 60));
      return hours.format(Math.floor(elapsed / 3600));
    },
  };
}

/** Dates and numbers follow the language of the interface. English has the British formats. */
export const formats = {
  en: formatsFor("en-GB"),
  fr: formatsFor("fr"),
} satisfies Record<Language, ReturnType<typeof formatsFor>>;
