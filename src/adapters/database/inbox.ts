import { Effect, Layer, Schema } from "effect";

import { InboxStore } from "../../domain/submissions/inbox-store.ts";
import {
  previewFields,
  SubmissionDetail,
  SubmissionStatus,
} from "../../domain/submissions/inbox.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import {
  InboxUnavailable,
  InvalidInboxCursor,
  SubmissionNotFound,
} from "../../domain/submissions/submission.rejection.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import { d1, database } from "./d1.ts";

const Cursor = Schema.fromJsonString(Schema.Tuple([Schema.Int, SubmissionId]));
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const encodeCursor = Schema.encodeEffect(Cursor);
// D1 stores the fields of a submission as JSON text.
const StoredDetail = SubmissionDetail.mapFields((fields) => ({
  ...fields,
  fields: Schema.fromJsonString(SubmissionFields),
}));
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredDetail));
const decodeDetail = Schema.decodeUnknownEffect(StoredDetail);
const decodeCounts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ status: SubmissionStatus, total: Schema.Int })),
);

const inboxUnavailable = () => InboxUnavailable.make();

const columns = `
  s.id AS submissionId, s.organization_id AS organizationId, s.form_id AS formId,
  f.name AS formName, s.received_at AS receivedAt,
  COALESCE(i.status, 'received') AS status, i.reason AS reason, i.label AS label
`;
const tables = `
  FROM submissions s JOIN forms f ON f.id = s.form_id
  LEFT JOIN submission_inbox i ON i.submission_id = s.id
`;

export const inboxStoreLive = Layer.succeed(InboxStore, {
  project: Effect.fn("Inbox.project")(function* ({ submissionId, version, status, reason, label }) {
    const db = yield* database;
    yield* d1(() =>
      db
        .prepare(`
      INSERT INTO submission_inbox (submission_id, version, status, reason, label) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (submission_id) DO UPDATE SET version = excluded.version,
        status = excluded.status, reason = excluded.reason, label = excluded.label
      WHERE excluded.version > submission_inbox.version
    `)
        .bind(submissionId, version, status, reason, label)
        .run(),
    );
  }, Effect.mapError(inboxUnavailable)),
  list: Effect.fn("Inbox.list")(
    function* (organizationId, status, take, after) {
      const db = yield* database;
      const cursor =
        after === undefined
          ? null
          : yield* decodeCursor(after).pipe(Effect.mapError(() => InvalidInboxCursor.make()));
      const rows = yield* d1(() =>
        db
          .prepare(`
      SELECT ${columns}, s.fields ${tables}
      WHERE s.organization_id = ?
        AND (? IS NULL OR COALESCE(i.status, 'received') = ?)
        AND (? IS NULL OR (s.received_at, s.id) < (?, ?))
      ORDER BY s.received_at DESC, s.id DESC LIMIT ?
    `)
          .bind(
            organizationId,
            status ?? null,
            status ?? null,
            cursor?.[0] ?? null,
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
            take + 1,
          )
          .all(),
      );
      const decoded = yield* decodeRows(rows.results);
      const entries = decoded
        .slice(0, take)
        .map(({ fields, ...row }) => ({ ...row, preview: previewFields(fields) }));
      const last = entries.at(-1);
      return {
        entries,
        cursor:
          decoded.length > take && last !== undefined
            ? yield* encodeCursor([last.receivedAt, last.submissionId])
            : null,
      };
    },
    Effect.catchTags({
      SchemaError: () => Effect.fail(inboxUnavailable()),
      StorageUnavailable: () => Effect.fail(inboxUnavailable()),
    }),
  ),
  counts: Effect.fn("Inbox.counts")(function* (organizationId) {
    const db = yield* database;
    const rows = yield* d1(() =>
      db
        .prepare(`
      SELECT COALESCE(i.status, 'received') AS status, COUNT(*) AS total
      FROM submissions s LEFT JOIN submission_inbox i ON i.submission_id = s.id
      WHERE s.organization_id = ? GROUP BY 1
    `)
        .bind(organizationId)
        .all(),
    );
    const counts = { received: 0, classifying: 0, accepted: 0, quarantined: 0, archived: 0 };
    for (const { status, total } of yield* decodeCounts(rows.results)) counts[status] = total;
    return counts;
  }, Effect.mapError(inboxUnavailable)),
  detail: Effect.fn("Inbox.detail")(function* (organizationId, submissionId) {
    const db = yield* database;
    const row = yield* d1(() =>
      db
        .prepare(`
      SELECT ${columns}, s.fields ${tables} WHERE s.organization_id = ? AND s.id = ?
    `)
        .bind(organizationId, submissionId)
        .first(),
    ).pipe(Effect.mapError(inboxUnavailable));
    if (row === null) return yield* SubmissionNotFound.make();
    return yield* decodeDetail(row).pipe(Effect.mapError(inboxUnavailable));
  }),
});
