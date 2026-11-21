import type { Counts, Inbox, Status, StatusCounts } from "~/lib/inbox-client";

/** A folder of the sidebar: the messages of one status, or all of them. */
export type Folder = "quarantined" | "accepted" | "archived" | "all";

type Form = Inbox["forms"][number];

const noMessage: StatusCounts = {
  received: 0,
  classifying: 0,
  accepted: 0,
  quarantined: 0,
  archived: 0,
};

/** How many messages a folder has. */
export function totalOf(counts: StatusCounts, folder: Folder) {
  if (folder !== "all") return counts[folder];
  return (
    counts.received + counts.classifying + counts.accepted + counts.quarantined + counts.archived
  );
}

/** The counts of one form. A form without a message has none. */
export function countsOfForm(counts: Counts, form: Form["publicId"]): StatusCounts {
  return counts.forms.find(({ publicId }) => publicId === form)?.counts ?? noMessage;
}

function afterMove(counts: StatusCounts, from: Status, to: Status): StatusCounts {
  return { ...counts, [from]: Math.max(0, counts[from] - 1), [to]: counts[to] + 1 };
}

/**
 * The counts once a message of a form has gone from one status to another, so
 * a decision does not ask the API to count every message again. A count never
 * goes below zero.
 */
export function countsAfterMove(
  counts: Counts,
  form: Form["publicId"],
  from: Status,
  to: Status,
): Counts {
  if (from === to) return counts;
  const others = counts.forms.filter(({ publicId }) => publicId !== form);
  const moved = { publicId: form, counts: afterMove(countsOfForm(counts, form), from, to) };
  return { ...afterMove(counts, from, to), forms: [...others, moved] };
}

/** The counts once a message of a form is deleted for good. A count never goes below zero. */
export function countsAfterRemoval(counts: Counts, form: Form["publicId"], status: Status): Counts {
  const removed = (known: StatusCounts) => ({ ...known, [status]: Math.max(0, known[status] - 1) });
  const others = counts.forms.filter(({ publicId }) => publicId !== form);
  const own = { publicId: form, counts: removed(countsOfForm(counts, form)) };
  return { ...removed(counts), forms: [...others, own] };
}

export interface FolderForm {
  readonly form: Form;
  /** How many messages of the folder the form has. */
  readonly total: number;
}

/**
 * The forms that a folder unfolds into: those that have a message in it, and
 * the open form even without one. A folder whose messages all come from one
 * form has nothing to tell apart, so it does not unfold, unless that form is
 * the open one and the list is already narrowed to it.
 */
export function formsOfFolder(
  forms: readonly Form[],
  counts: Counts,
  folder: Folder,
  open: Form["publicId"] | null,
): readonly FolderForm[] {
  const rows = forms
    .map((form) => ({ form, total: totalOf(countsOfForm(counts, form.publicId), folder) }))
    .filter(({ form, total }) => total > 0 || form.publicId === open);
  const narrowed = rows.some(({ form }) => form.publicId === open);
  return rows.length > 1 || narrowed ? rows : [];
}
