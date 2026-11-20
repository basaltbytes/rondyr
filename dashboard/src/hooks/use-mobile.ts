import { useSyncExternalStore } from "react";

// Under 64rem the dashboard shows one pane at a time and the sidebar is a drawer.
const narrow = "(max-width: 63.9375rem)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(narrow);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the screen is narrow, read from the media query, so the first paint is right. */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(narrow).matches);
}
