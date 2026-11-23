import type { MessagesSearch } from "~/lib/messages-search";

// The list of messages last shown in each organization, where the settings go back to.
const shown = new Map<string, MessagesSearch>();

export function rememberMessages(organizationId: string, search: MessagesSearch) {
  shown.set(organizationId, search);
}

export function lastMessages(organizationId: string): MessagesSearch {
  return shown.get(organizationId) ?? { folder: "quarantined" };
}
