import { useSyncExternalStore } from "react";

import { chooseTheme } from "./theme.ts";
import type { Theme } from "./theme.ts";

// public/theme.js reads the same key before the first paint.
const storageKey = "rondyr-theme";

function storedTheme() {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** The class on the root element picks the palette. Without one, the system does. */
function apply(theme: Theme) {
  const { classList } = document.documentElement;
  classList.toggle("light", theme === "light");
  classList.toggle("dark", theme === "dark");
}

let current = chooseTheme(storedTheme());
const listeners = new Set<() => void>();
apply(current);

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Shows the interface in a theme at once, and remembers the choice. */
export function setTheme(theme: Theme) {
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
  current = theme;
  apply(theme);
  for (const listener of listeners) listener();
}

/** The theme that the user chose, or the system's. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current);
}
