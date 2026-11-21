import { Effect, Layer, Schema } from "effect";

import { ExportedSubmission } from "../../domain/submissions/submission-export.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import type { InboxFilter } from "../../domain/submissions/inbox.ts";
import { SubmissionId, type OrganizationId } from "../../domain/submissions/submission.id.ts";
import { SubmissionExports } from "../../ports/submission-exports.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";
import { afterCursor, filterConditions } from "./submission-filter.ts";

const Cursor = Schema.fromJsonString(Schema.Tuple([Schema.Int, SubmissionId]));
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const encodeCursor = Schema.encodeEffect(Cursor);
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    ExportedSubmission.mapFields((fields) => ({
      ...fields,
      fields: Schema.fromJsonString(SubmissionFields),
    })),
  ),
);
const decodeNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String, uses: Schema.Int })),
);
const decodeMore = Schema.decodeUnknownEffect(Schema.Struct({ more: Schema.Literals([0, 1]) }));
const unreadable = () => StorageUnavailable.make();

const tables = `
  FROM submissions s JOIN forms f ON f.id = s.form_id
  LEFT JOIN submission_inbox i ON i.submission_id = s.id
`;

const outline = Effect.fn("SubmissionExports.outline")(function* (
  organizationId: OrganizationId,
  filter: typeof InboxFilter.Type,
  limit: number,
  maxFieldNames: number,
) {
  const db = yield* database;
  const conditions = filterConditions(organizationId, filter);
  // The names that the most messages use come first; one more than the columns
  // tells whether some names get none.
  const [names, more] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        SELECT j.key AS name, count(*) AS uses FROM (
          SELECT s.fields ${tables} WHERE ${conditions.sql}
          ORDER BY s.received_at DESC, s.id DESC LIMIT ?
        ) AS listed, json_each(listed.fields) j
        GROUP BY j.key ORDER BY uses DESC, j.key LIMIT ?
      `)
        .bind(...conditions.bindings, limit, maxFieldNames + 1),
      db
        .prepare(`
        SELECT EXISTS (
          SELECT 1 ${tables} WHERE ${conditions.sql}
          ORDER BY s.received_at DESC, s.id DESC LIMIT 1 OFFSET ?
        ) AS more
      `)
        .bind(...conditions.bindings, limit),
    ]),
  );
  const rows = yield* decodeNames(names?.results).pipe(Effect.mapError(unreadable));
  const { more: truncated } = yield* decodeMore(more?.results[0]).pipe(Effect.mapError(unreadable));
  return {
    fieldNames: rows.slice(0, maxFieldNames).map(({ name }) => name),
    moreFieldNames: rows.length > maxFieldNames,
    truncated: truncated === 1,
  };
});

const page = Effect.fn("SubmissionExports.page")(function* (
  organizationId: OrganizationId,
  filter: typeof InboxFilter.Type,
  after: string | null,
  size: number,
) {
  const db = yield* database;
  const cursor =
    after === null ? null : yield* decodeCursor(after).pipe(Effect.mapError(unreadable));
  const conditions = filterConditions(organizationId, filter);
  const start = afterCursor(cursor);
  const result = yield* d1(() =>
    db
      .prepare(`
      SELECT s.id AS submissionId, s.received_at AS receivedAt, f.public_id AS formPublicId,
        f.name AS formName, COALESCE(i.status, 'received') AS status, i.reason AS reason,
        i.label AS label, s.fields
      ${tables}
      WHERE ${conditions.sql} ${start.sql}
      ORDER BY s.received_at DESC, s.id DESC LIMIT ?
    `)
      .bind(...conditions.bindings, ...start.bindings, size)
      .all(),
  );
  const rows = yield* decodeRows(result.results).pipe(Effect.mapError(unreadable));
  const last = rows.at(-1);
  return {
    rows,
    cursor:
      rows.length === size && last !== undefined
        ? yield* encodeCursor([last.receivedAt, last.submissionId]).pipe(
            Effect.mapError(unreadable),
          )
        : null,
  };
});

export const submissionExportsLive = Layer.succeed(SubmissionExports, { outline, page });
