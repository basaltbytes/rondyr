import { Effect, Layer, Option, Schema } from "effect";

import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { Outbox, type OutboxLease } from "../../ports/outbox.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const Claim = Schema.Struct({ submission_id: SubmissionId });
const Pending = Schema.Struct({ organization_id: OrganizationId });

const decodeClaims = Schema.decodeUnknownEffect(Schema.Array(Claim));
const decodePending = Schema.decodeUnknownEffect(Schema.NullOr(Pending));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SubmissionId)));

const unreadable = () => StorageUnavailable.make();

// An event is due when nobody handed it off, its lease expired, and it was never
// published or was published at or before the republication cutoff.
const due = `handed_off_at IS NULL AND lease_until <= ? AND (published_at IS NULL OR published_at <= ?)`;

const claimed = Effect.fnUntraced(function* (statement: D1PreparedStatement) {
  const claims = yield* d1(() => statement.all());
  const events = yield* decodeClaims(claims.results).pipe(Effect.mapError(unreadable));
  return events.map(({ submission_id }) => submission_id);
});

const claimDue = Effect.fn("Outbox.claimDue")(function* (lease: OutboxLease, limit: number) {
  const db = yield* database;
  return yield* claimed(
    db
      .prepare(`
    UPDATE outbox_events SET lease_until = ?
    WHERE submission_id IN (
      SELECT submission_id FROM outbox_events WHERE ${due}
      ORDER BY lease_until, submission_id LIMIT ?
    )
    RETURNING submission_id
  `)
      .bind(lease.until, lease.now, lease.republishBefore, limit),
  );
});

const claim = Effect.fn("Outbox.claim")(function* (lease: OutboxLease, submissionId: SubmissionId) {
  const db = yield* database;
  return yield* claimed(
    db
      .prepare(`
    UPDATE outbox_events SET lease_until = ?
    WHERE submission_id = ? AND ${due}
    RETURNING submission_id
  `)
      .bind(lease.until, submissionId, lease.now, lease.republishBefore),
  );
});

const markPublished = Effect.fn("Outbox.markPublished")(function* (
  lease: OutboxLease,
  submissionIds: ReadonlyArray<SubmissionId>,
) {
  const db = yield* database;
  const ids = yield* encodeIds(submissionIds).pipe(Effect.orDie);
  yield* d1(() =>
    db
      .prepare(`
    UPDATE outbox_events SET published_at = ?, lease_until = 0
    WHERE lease_until = ? AND submission_id IN (SELECT value FROM json_each(?))
  `)
      .bind(lease.now, lease.until, ids)
      .run(),
  );
});

const pendingOrganization = Effect.fn("Outbox.pendingOrganization")(function* (
  submissionId: SubmissionId,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
    SELECT organization_id FROM outbox_events JOIN submissions ON submissions.id = outbox_events.submission_id
    WHERE submission_id = ? AND handed_off_at IS NULL
  `)
      .bind(submissionId)
      .first(),
  );
  const pending = yield* decodePending(row).pipe(Effect.mapError(unreadable));
  return Option.map(Option.fromNullOr(pending), ({ organization_id }) => organization_id);
});

const markHandedOff = Effect.fn("Outbox.markHandedOff")(function* (
  submissionId: SubmissionId,
  handedOffAt: number,
) {
  const db = yield* database;
  yield* d1(() =>
    db
      .prepare(`
    UPDATE outbox_events SET handed_off_at = ?
    WHERE submission_id = ? AND handed_off_at IS NULL
  `)
      .bind(handedOffAt, submissionId)
      .run(),
  );
});

export const outboxLive = Layer.succeed(Outbox, {
  claimDue,
  claim,
  markPublished,
  pendingOrganization,
  markHandedOff,
});
