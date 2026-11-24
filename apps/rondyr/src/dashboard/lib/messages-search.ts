import { Effect, Schema } from "effect";

import { minSearchLength, SearchText } from "@rondyr/contracts/inbox";

/** A folder of the sidebar: the messages of one status, or all of them. */
export type Folder = "quarantined" | "accepted" | "archived" | "all";

export const Folder = Schema.Literals([
  "quarantined",
  "accepted",
  "archived",
  "all",
] satisfies ReadonlyArray<Folder>);

const defaultFolder: Folder = "quarantined";

/** The public ID of a form, as the list of the API accepts it. */
const FormPublicId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

/**
 * The search params of an address of the messages: the folder, the form that the list
 * is narrowed to, and the text it is narrowed to. A value that its schema refuses gives
 * way to the default, so an edited address opens the list instead of an error.
 */
export const MessagesSearch = Schema.Struct({
  folder: Folder.pipe(
    Schema.catchDecoding(() => Effect.succeedSome(defaultFolder)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultFolder)),
  ),
  // The router keeps the params of the address that a schema leaves out, so a refused
  // value becomes undefined instead.
  form: Schema.optionalKey(
    Schema.UndefinedOr(FormPublicId).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
    ),
  ),
  q: Schema.optionalKey(
    Schema.UndefinedOr(SearchText).pipe(Schema.catchDecoding(() => Effect.succeedSome(undefined))),
  ),
});

export type MessagesSearch = typeof MessagesSearch.Type;

/** The search params of a list: a folder, and the form and the text when there are some. */
export function messagesSearch(
  folder: Folder,
  form: string | null,
  search: string | null,
): MessagesSearch {
  return {
    folder,
    ...(form !== null && { form }),
    ...(search !== null && { q: search }),
  };
}

export type SearchTransition =
  | { readonly action: "unchanged" }
  | { readonly action: "clear" }
  | { readonly action: "too-short"; readonly clearActive: boolean }
  | { readonly action: "search"; readonly query: string };

/** Decides what an input value does relative to the currently active search text. */
export function searchTransition(input: string, activeSearch: string | null): SearchTransition {
  const trimmed = input.trim();
  if (trimmed === "") {
    return activeSearch === null ? { action: "unchanged" } : { action: "clear" };
  }
  if (trimmed.length < minSearchLength) {
    return { action: "too-short", clearActive: activeSearch !== null };
  }
  if (trimmed === activeSearch) return { action: "unchanged" };
  return { action: "search", query: trimmed };
}
