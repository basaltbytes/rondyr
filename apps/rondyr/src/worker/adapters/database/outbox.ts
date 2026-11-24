import { Effect, Layer, Option, Schema } from "effect";

import { IntakeReason } from "../../../domain/submissions/classification.ts";
import { OrganizationId, SubmissionId } from "../../../domain/submissions/submission.id.ts";
import {
  Outbox,
  type OutboxLease,
  type StuckScope,
  StuckSubmissionNotFound,
  SubmissionNotStuck,
} from "../../ports/outbox.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const Claim = Schema.Struct({ submission_id: SubmissionId });
// An intake reason this Worker does not know fails the decoding, and the queue
// message is retried, then dead-lettered, rather than classified.
const Pending = Schema.Struct({
  organization_id: OrganizationId,
  intake_reason: Schema.NullOr(IntakeReason),
});

const decodeClaims = Schema.decodeUnknownEffect(Schema.Array(Claim));
const decodeRetryState = Schema.decodeUnknownEffect(
  Schema.NullOr(Schema.Struct({ stuck: Schema.Literals([0, 1]) })),
);
const decodePending = Schema.decodeUnknownEffect(Schema.NullOr(Pending));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SubmissionId)));

const unreadable = () => StorageUnavailable.make();

// An event is due when nobody handed it off, it is not stuck, its lease expired, and
// it was never published or was published at or before the republication cutoff.
const due = `handed_off_at IS NULL AND stuck_at IS NULL AND lease_until <= ? AND (published_at IS NULL OR published_at <= ?)`;

const idsOf = Effect.fnUntraced(function* (rows: ReadonlyArray<unknown> | undefined) {
  const events = yield* decodeClaims(rows).pipe(Effect.mapError(unreadable));
  return events.map(({ submission_id }) => submission_id);
});

const claimed = Effect.fnUntraced(function* (statement: D1PreparedStatement) {
  const claims = yield* d1(() => statement.all());
  return yield* idsOf(claims.results);
});

const claimDue = Effect.fn("Outbox.claimDue")(function* (
  lease: OutboxLease,
  limit: number,
  maxPublications: number,
) {
  const db = yield* database;
  // One transaction: the claim below no longer sees the events marked stuck first.
  const [stuck, claims] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
    UPDATE outbox_events SET stuck_at = ?
    WHERE ${due} AND publication_count >= ?
    RETURNING submission_id
  `)
        .bind(lease.now, lease.now, lease.republishBefore, maxPublications),
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
    ]),
  );
  return {
    stuck: yield* idsOf(stuck?.results),
    claimed: yield* idsOf(claims?.results),
  };
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
    UPDATE outbox_events
    SET published_at = ?, lease_until = 0, publication_count = publication_count + 1
    WHERE lease_until = ? AND submission_id IN (SELECT value FROM json_each(?))
  `)
      .bind(lease.now, lease.until, ids)
      .run(),
  );
});

const pendingHandoff = Effect.fn("Outbox.pendingHandoff")(function* (submissionId: SubmissionId) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
    SELECT organization_id, intake_reason
    FROM outbox_events JOIN submissions ON submissions.id = outbox_events.submission_id
    WHERE submission_id = ? AND handed_off_at IS NULL
  `)
      .bind(submissionId)
      .first(),
  );
  const pending = yield* decodePending(row).pipe(Effect.mapError(unreadable));
  return Option.map(Option.fromNullOr(pending), (found) => ({
    organizationId: found.organization_id,
    intakeReason: Option.fromNullOr(found.intake_reason),
  }));
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

const retryStuck = Effect.fn("Outbox.retryStuck")(function* ({
  organizationId,
  submissionId,
}: StuckScope) {
  const db = yield* database;
  const inOrganization = `submission_id = ? AND submission_id IN (SELECT id FROM submissions WHERE organization_id = ?)`;
  // The event becomes due at once, as if intake had just stored it.
  const [retried, state] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
    UPDATE outbox_events
    SET stuck_at = NULL, publication_count = 0, published_at = NULL, lease_until = 0
    WHERE ${inOrganization} AND stuck_at IS NOT NULL AND handed_off_at IS NULL
    RETURNING submission_id
  `)
        .bind(submissionId, organizationId),
      db
        .prepare(`
    SELECT stuck_at IS NOT NULL AND handed_off_at IS NULL AS stuck FROM outbox_events
    WHERE ${inOrganization}
  `)
        .bind(submissionId, organizationId),
    ]),
  );
  if ((retried?.results.length ?? 0) > 0) return;
  const pending = yield* decodeRetryState(state?.results[0] ?? null).pipe(
    Effect.mapError(unreadable),
  );
  if (pending === null) return yield* StuckSubmissionNotFound.make();
  return yield* SubmissionNotStuck.make();
});

export const outboxLive = Layer.succeed(Outbox, {
  claimDue,
  claim,
  markPublished,
  pendingHandoff,
  markHandedOff,
  retryStuck,
});
