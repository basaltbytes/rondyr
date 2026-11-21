import type { InboxFilter } from "../../domain/submissions/inbox.ts";
import type { OrganizationId } from "../../domain/submissions/submission.id.ts";

/**
 * A LIKE pattern that finds `text` anywhere, with `%`, `_` and `\` as ordinary
 * characters under `ESCAPE '\'`. SQLite's LIKE ignores the case of ASCII letters.
 */
export function containing(text: string) {
  return `%${text.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

/**
 * The conditions of a list of submissions, for `submissions s`, `forms f` and
 * `submission_inbox i`, with their bindings in order: the organization, the
 * status, the form, then the search in the values of the fields.
 */
export function filterConditions(
  organizationId: OrganizationId,
  { status, formPublicId, search }: typeof InboxFilter.Type,
) {
  const pattern = search === undefined ? null : containing(search);
  return {
    sql: `
      s.organization_id = ?
      AND (? IS NULL OR COALESCE(i.status, 'received') = ?)
      AND (? IS NULL OR f.public_id = ?)
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM json_each(s.fields) j WHERE j.value LIKE ? ESCAPE '\\'
      ))
    `,
    bindings: [
      organizationId,
      status ?? null,
      status ?? null,
      formPublicId ?? null,
      formPublicId ?? null,
      pattern,
      pattern,
    ],
  };
}

/**
 * The condition that starts a page after `cursor`, the reception time and ID of
 * the last message of the previous page. Without the `? IS NULL OR` form, SQLite
 * starts its read of the index at the cursor instead of at the newest message.
 */
export function afterCursor(cursor: readonly [number, string] | null) {
  return cursor === null
    ? { sql: "", bindings: [] }
    : { sql: "AND (s.received_at, s.id) < (?, ?)", bindings: [cursor[0], cursor[1]] };
}
