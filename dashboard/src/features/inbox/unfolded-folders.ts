import type { Folder } from "./folder-counts.ts";

const storageKey = "rondyr-unfolded-folders";
const every: readonly Folder[] = ["quarantined", "accepted", "archived", "all"];

/**
 * The folders that show their forms, from the text that the browser stored.
 * Without a stored choice, the messages to review show theirs.
 */
export function unfoldedFrom(stored: string | null): readonly Folder[] {
  if (stored === null) return ["quarantined"];
  const names = stored.split(",");
  return every.filter((folder) => names.includes(folder));
}

// The stored choice is read before the first paint, so the forms never flash open.
export function storedUnfolded() {
  try {
    return unfoldedFrom(window.localStorage.getItem(storageKey));
  } catch {
    return unfoldedFrom(null);
  }
}

export function storeUnfolded(unfolded: readonly Folder[]) {
  try {
    window.localStorage.setItem(storageKey, unfolded.join(","));
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
}
