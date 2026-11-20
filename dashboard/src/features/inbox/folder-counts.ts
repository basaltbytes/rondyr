import type { Counts, Status } from "~/lib/inbox-client";

/** A folder of the sidebar: the messages of one status, or all of them. */
export type Folder = "quarantined" | "accepted" | "archived" | "all";

/** How many messages a folder has. */
export function totalOf(counts: Counts, folder: Folder) {
  if (folder !== "all") return counts[folder];
  return (
    counts.received + counts.classifying + counts.accepted + counts.quarantined + counts.archived
  );
}

/**
 * The counts once a message has gone from one status to another, so a decision
 * does not ask the API to count every message again. A count never goes below zero.
 */
export function countsAfterMove(counts: Counts, from: Status, to: Status): Counts {
  if (from === to) return counts;
  return { ...counts, [from]: Math.max(0, counts[from] - 1), [to]: counts[to] + 1 };
}
