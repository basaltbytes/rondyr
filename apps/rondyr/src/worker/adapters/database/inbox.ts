import { Effect, Layer, Schema } from "effect";

import { IntakeReason } from "../../../domain/submissions/classification.ts";
import { InboxStore } from "../../../domain/submissions/inbox-store.ts";
import { InboxRow, previewFields, SubmissionStatus } from "../../../domain/submissions/inbox.ts";
import { SubmissionFields } from "../../../domain/submissions/submission-fields.ts";
import {
  InboxUnavailable,
  InvalidInboxCursor,
  SubmissionNotFound,
} from "../../../domain/submissions/submission.rejection.ts";
import { SubmissionId } from "../../../domain/submissions/submission.id.ts";
import {
  type EventActor,
  IntakeVerification,
  SubmissionEventDetail,
  type SubmissionTimelineEvent,
} from "../../../domain/submissions/verification.ts";
import { IntakeTrace } from "../../ports/outbox.ts";
import { d1, database } from "./d1.ts";
import { afterCursor, filterConditions } from "./submission-filter.ts";

const Cursor = Schema.fromJsonString(Schema.Tuple([Schema.Int, SubmissionId]));
const decodeCursor = Schema.decodeUnknownEffect(Cursor);
const encodeCursor = Schema.encodeEffect(Cursor);
const encodeEventDetail = Schema.encodeEffect(Schema.fromJsonString(SubmissionEventDetail));

const StoredListRow = InboxRow.mapFields((fields) => ({
  ...fields,
  fields: Schema.fromJsonString(SubmissionFields),
}));
const StoredDetailRow = StoredListRow.mapFields((fields) => ({
  ...fields,
  intakeChecks: Schema.NullOr(Schema.fromJsonString(IntakeVerification)),
  intakeReason: Schema.NullOr(IntakeReason),
  priorSameSender: Schema.Int,
  priorSameContent: Schema.Int,
  hasOutbox: Schema.Literals([0, 1]),
  publishedAt: Schema.NullOr(Schema.Int),
  handedOffAt: Schema.NullOr(Schema.Int),
  publicationCount: Schema.NullOr(Schema.Int),
  stuckAt: Schema.NullOr(Schema.Int),
  intakeTrace: Schema.NullOr(Schema.fromJsonString(IntakeTrace)),
}));
const StoredEventRow = Schema.Struct({
  seq: Schema.Int,
  occurredAt: Schema.Int,
  traceId: Schema.NullOr(Schema.String),
  payload: Schema.fromJsonString(SubmissionEventDetail),
  reviewerName: Schema.NullOr(Schema.String),
  apiTokenName: Schema.NullOr(Schema.String),
  apiTokenSuffix: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredListRow));
const decodeDetail = Schema.decodeUnknownEffect(StoredDetailRow);
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(StoredEventRow));
const decodeCounts = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ publicId: Schema.String, status: SubmissionStatus, total: Schema.Int }),
  ),
);
const noSubmission = { received: 0, classifying: 0, accepted: 0, quarantined: 0, archived: 0 };

const inboxUnavailable = () => InboxUnavailable.make();

const columns = `
  s.id AS submissionId, s.organization_id AS organizationId, s.form_id AS formId,
  f.public_id AS formPublicId, f.name AS formName, s.received_at AS receivedAt,
  COALESCE(i.status, 'received') AS status, i.reason AS reason, i.label AS label
`;
const tables = `
  FROM submissions s JOIN forms f ON f.id = s.form_id
  LEFT JOIN submission_inbox i ON i.submission_id = s.id
`;

function hydrateActor(
  actor: EventActor | undefined,
  reviewerName: string | null,
  apiTokenName: string | null,
  apiTokenSuffix: string | null,
): EventActor | undefined {
  if (actor === undefined) return undefined;
  if (actor._tag === "Reviewer") {
    return { ...actor, name: reviewerName ?? actor.name };
  }
  return {
    ...actor,
    name: apiTokenName ?? actor.name,
    suffix: apiTokenSuffix ?? actor.suffix,
  };
}

function hydrateEvent(row: typeof StoredEventRow.Type): SubmissionTimelineEvent {
  const { payload } = row;
  let detail: SubmissionEventDetail = payload;
  if (
    payload._tag === "ReclassificationRequested" ||
    payload._tag === "SubmissionDismissed" ||
    (payload._tag === "SubmissionAccepted" && payload.mode === "manual")
  ) {
    const actor = hydrateActor(
      payload.actor,
      row.reviewerName,
      row.apiTokenName,
      row.apiTokenSuffix,
    );
    detail = actor === undefined ? payload : { ...payload, actor };
  }
  return {
    seq: row.seq,
    occurredAt: row.occurredAt,
    traceId: row.traceId,
    detail,
  };
}

export const inboxStoreLive = Layer.succeed(InboxStore, {
  project: Effect.fn("Inbox.project")(function* ({
    submissionId,
    version,
    status,
    reason,
    label,
    event,
  }) {
    const db = yield* database;
    const upsertInbox = db
      .prepare(`
      INSERT INTO submission_inbox (submission_id, version, status, reason, label)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)
      ON CONFLICT (submission_id) DO UPDATE SET version = excluded.version,
        status = excluded.status, reason = excluded.reason, label = excluded.label
      WHERE excluded.version > submission_inbox.version
    `)
      .bind(submissionId, version, status, reason, label);
    if (event === undefined) {
      yield* d1(() => upsertInbox.run());
      return;
    }
    const payload = yield* encodeEventDetail(event.detail).pipe(Effect.orDie);
    const insertEvent = db
      .prepare(`
      INSERT INTO submission_events (submission_id, seq, event_type, occurred_at, trace_id, payload)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)
      ON CONFLICT (submission_id, seq) DO NOTHING
    `)
      .bind(submissionId, version, event.eventType, event.occurredAt, event.traceId, payload);
    yield* d1(() => db.batch([upsertInbox, insertEvent]));
  }, Effect.mapError(inboxUnavailable)),
  list: Effect.fn("Inbox.list")(
    function* (organizationId, filter, take, after) {
      const db = yield* database;
      const cursor =
        after === undefined
          ? null
          : yield* decodeCursor(after).pipe(Effect.mapError(() => InvalidInboxCursor.make()));
      const conditions = filterConditions(organizationId, filter);
      const start = afterCursor(cursor);
      const rows = yield* d1(() =>
        db
          .prepare(`
      SELECT ${columns}, s.fields ${tables}
      WHERE ${conditions.sql} ${start.sql}
      ORDER BY s.received_at DESC, s.id DESC LIMIT ?
    `)
          .bind(...conditions.bindings, ...start.bindings, take + 1)
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
      SELECT f.public_id AS publicId, COALESCE(i.status, 'received') AS status, COUNT(*) AS total
      FROM submissions s JOIN forms f ON f.id = s.form_id
      LEFT JOIN submission_inbox i ON i.submission_id = s.id
      WHERE s.organization_id = ? GROUP BY 1, 2 ORDER BY 1
    `)
        .bind(organizationId)
        .all(),
    );
    const organization = { ...noSubmission };
    const forms = new Map<string, typeof noSubmission>();
    for (const { publicId, status, total } of yield* decodeCounts(rows.results)) {
      const form = forms.get(publicId) ?? { ...noSubmission };
      form[status] = total;
      forms.set(publicId, form);
      organization[status] += total;
    }
    return {
      ...organization,
      forms: Array.from(forms, ([publicId, counts]) => ({ publicId, counts })),
    };
  }, Effect.mapError(inboxUnavailable)),
  detail: Effect.fn("Inbox.detail")(function* (organizationId, submissionId) {
    const db = yield* database;
    const [detailResult, eventsResult] = yield* d1(() =>
      db.batch([
        db
          .prepare(`
        SELECT ${columns}, s.fields,
          s.intake_checks AS intakeChecks,
          s.intake_reason AS intakeReason,
          s.prior_same_sender AS priorSameSender,
          s.prior_same_content AS priorSameContent,
          e.submission_id IS NOT NULL AS hasOutbox,
          e.published_at AS publishedAt,
          e.handed_off_at AS handedOffAt,
          e.publication_count AS publicationCount,
          e.stuck_at AS stuckAt,
          e.intake_trace AS intakeTrace
        ${tables}
        LEFT JOIN outbox_events e ON e.submission_id = s.id
        WHERE s.organization_id = ? AND s.id = ?
      `)
          .bind(organizationId, submissionId),
        db
          .prepare(`
        SELECT se.seq, se.occurred_at AS occurredAt, se.trace_id AS traceId, se.payload,
          COALESCE(NULLIF(trim(u.name), ''), u.email) AS reviewerName,
          t.name AS apiTokenName,
          t.token_suffix AS apiTokenSuffix
        FROM submission_events se
        LEFT JOIN auth_users u ON u.id = json_extract(se.payload, '$.actor.userId')
        LEFT JOIN api_tokens t ON t.id = json_extract(se.payload, '$.actor.apiTokenId')
        WHERE se.submission_id = ?
          AND EXISTS (SELECT 1 FROM submissions s WHERE s.id = se.submission_id AND s.organization_id = ?)
        ORDER BY se.seq ASC
      `)
          .bind(submissionId, organizationId),
      ]),
    ).pipe(Effect.mapError(inboxUnavailable));
    const row = detailResult?.results[0] ?? null;
    if (row === null) return yield* SubmissionNotFound.make();
    const decoded = yield* decodeDetail(row).pipe(Effect.mapError(inboxUnavailable));
    const eventRows = yield* decodeEvents(eventsResult?.results ?? []).pipe(
      Effect.mapError(inboxUnavailable),
    );
    const {
      intakeChecks,
      intakeReason,
      priorSameSender,
      priorSameContent,
      hasOutbox,
      publishedAt,
      handedOffAt,
      publicationCount,
      stuckAt,
      intakeTrace,
      ...base
    } = decoded;
    return {
      ...base,
      verification: {
        intake: intakeChecks,
        intakeReason,
        priorSameSender,
        priorSameContent,
        intakeTraceId: intakeTrace?.traceId ?? null,
        outbox:
          hasOutbox === 1
            ? {
                publishedAt,
                handedOffAt,
                publicationCount: publicationCount ?? 0,
                stuckAt,
              }
            : null,
        events: eventRows.map(hydrateEvent),
      },
    };
  }),
});
