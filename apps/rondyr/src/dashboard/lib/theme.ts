export const themes = ["system", "light", "dark"] as const;

export type Theme = (typeof themes)[number];

/** The theme of the interface: the stored choice, else the theme of the system. */
export function chooseTheme(stored: string | null): Theme {
  return themes.find((theme) => theme === stored) ?? "system";
}
