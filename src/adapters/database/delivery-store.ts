import { Effect, Layer, Match, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  DeliveryId,
  DeliveryStatus,
  interruptedSummary,
  NotificationTarget,
  summarize,
  TargetId,
  TargetType,
  type AttemptOutcome,
  type DeliveryTransition,
} from "../../domain/deliveries/delivery.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import {
  DeliveryNotFound,
  DeliveryNotRetryable,
  DeliveryStore,
  type AcceptedSubmission,
  type AttemptLease,
  type DeliveryScope,
  type StartedAttempt,
} from "../../ports/delivery-store.ts";
import type { OutboxLease } from "../../ports/outbox.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const Target = Schema.Struct({ id: TargetId });
const Claim = Schema.Struct({ id: DeliveryId });
const Started = Schema.Struct({ attempt_count: Schema.Int });
const Recorded = Schema.Struct({ attempt: Schema.Int });
const Status = Schema.Struct({ status: DeliveryStatus });
const Context = Schema.Struct({
  target_id: TargetId,
  type: TargetType,
  configuration: Schema.fromJsonString(NotificationTarget.fields.configuration),
  submission_id: SubmissionId,
  received_at: Schema.Int,
  form_public_id: Schema.String,
  form_name: Schema.String,
  fields: Schema.fromJsonString(SubmissionFields),
});

const decodeTargets = Schema.decodeUnknownEffect(Schema.Array(Target));
const decodeClaims = Schema.decodeUnknownEffect(Schema.Array(Claim));
const decodeStarted = Schema.decodeUnknownEffect(Schema.Array(Started));
const decodeRecorded = Schema.decodeUnknownEffect(Schema.Array(Recorded));
const decodeStatus = Schema.decodeUnknownEffect(Schema.Array(Status));
const decodeContext = Schema.decodeUnknownEffect(Context);
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(DeliveryId)));

const unreadable = () => StorageUnavailable.make();

// A delivery is due when an attempt may start (a pending delivery, a retry whose
// delay is over, or an attempt whose lease expired), nobody holds its
// publication lease, and it was not published since then, or was published at
// or before the republication cutoff.
const due = `
  (status = 'pending' OR (status IN ('retrying', 'processing') AND next_attempt_at <= ?1))
  AND lease_until <= ?1
  AND (published_at IS NULL OR published_at < next_attempt_at OR published_at <= ?2)
`;

const claimed = Effect.fnUntraced(function* (statement: D1PreparedStatement) {
  const claims = yield* d1(() => statement.all());
  const rows = yield* decodeClaims(claims.results).pipe(Effect.mapError(unreadable));
  return rows.map(({ id }) => id);
});

const create = Effect.fn("DeliveryStore.create")(function* (
  accepted: AcceptedSubmission,
  now: number,
) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
    SELECT t.id FROM notification_targets t
      JOIN submissions s ON s.form_id = t.form_id AND s.organization_id = t.organization_id
    WHERE s.id = ? AND s.organization_id = ? AND t.active = 1 AND t.created_at <= ?
    ORDER BY t.id
  `)
      .bind(accepted.submissionId, accepted.organizationId, accepted.acceptedAt)
      .all(),
  );
  const targets = yield* decodeTargets(rows.results).pipe(Effect.mapError(unreadable));
  if (targets.length === 0) return 0;
  yield* d1(() =>
    db.batch(
      targets.map(({ id }) =>
        db
          .prepare(`
      INSERT INTO deliveries (id, submission_id, target_id, next_attempt_at, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?4, ?4)
      ON CONFLICT (submission_id, target_id) DO NOTHING
    `)
          .bind(SecureRandom.uuidV4Unsafe(), accepted.submissionId, id, now),
      ),
    ),
  );
  return targets.length;
});

const claimDue = Effect.fn("DeliveryStore.claimDue")(function* (lease: OutboxLease, limit: number) {
  const db = yield* database;
  return yield* claimed(
    db
      .prepare(`
    UPDATE deliveries SET lease_until = ?3
    WHERE id IN (SELECT id FROM deliveries WHERE ${due} ORDER BY next_attempt_at, id LIMIT ?4)
    RETURNING id
  `)
      .bind(lease.now, lease.republishBefore, lease.until, limit),
  );
});

const claimSubmission = Effect.fn("DeliveryStore.claimSubmission")(function* (
  lease: OutboxLease,
  submissionId: SubmissionId,
) {
  const db = yield* database;
  return yield* claimed(
    db
      .prepare(`
    UPDATE deliveries SET lease_until = ?3 WHERE submission_id = ?4 AND ${due} RETURNING id
  `)
      .bind(lease.now, lease.republishBefore, lease.until, submissionId),
  );
});

const markPublished = Effect.fn("DeliveryStore.markPublished")(function* (
  lease: OutboxLease,
  deliveryIds: ReadonlyArray<DeliveryId>,
) {
  const db = yield* database;
  const ids = yield* encodeIds(deliveryIds).pipe(Effect.orDie);
  yield* d1(() =>
    db
      .prepare(`
    UPDATE deliveries SET published_at = ?, lease_until = 0
    WHERE lease_until = ? AND id IN (SELECT value FROM json_each(?))
  `)
      .bind(lease.now, lease.until, ids)
      .run(),
  );
});

const start = Effect.fn("DeliveryStore.start")(function* (
  deliveryId: DeliveryId,
  lease: AttemptLease,
) {
  const db = yield* database;
  const expired = `status = 'processing' AND next_attempt_at <= ?2`;
  const [, , begun, recorded, context] = yield* d1(() =>
    db.batch([
      // An expired attempt never recorded its result.
      db
        .prepare(`
      UPDATE delivery_attempts SET outcome = 'interrupted', finished_at = ?2
      WHERE delivery_id = ?1 AND outcome IS NULL
        AND EXISTS (SELECT 1 FROM deliveries WHERE id = ?1 AND ${expired})
    `)
        .bind(deliveryId, lease.now),
      db
        .prepare(`
      UPDATE deliveries SET status = 'failed', last_error = ?4, updated_at = ?2
      WHERE id = ?1 AND ${expired} AND attempt_count >= ?3
    `)
        .bind(deliveryId, lease.now, lease.maxAttempts, interruptedSummary),
      db
        .prepare(`
      UPDATE deliveries
      SET status = 'processing', attempt_count = attempt_count + 1, next_attempt_at = ?3,
        updated_at = ?2
      WHERE id = ?1 AND attempt_count < ?4
        AND (status = 'pending' OR (status IN ('retrying', 'processing') AND next_attempt_at <= ?2))
      RETURNING attempt_count
    `)
        .bind(deliveryId, lease.now, lease.until, lease.maxAttempts),
      // Attempts are numbered across series. After the update above, an attempt
      // without an outcome is one that another caller started at the same time.
      db
        .prepare(`
      INSERT INTO delivery_attempts (delivery_id, attempt, started_at)
      SELECT id, (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_id = ?1) + 1, ?2
      FROM deliveries
      WHERE id = ?1 AND status = 'processing' AND next_attempt_at = ?3
        AND NOT EXISTS (SELECT 1 FROM delivery_attempts WHERE delivery_id = ?1 AND outcome IS NULL)
      RETURNING attempt
    `)
        .bind(deliveryId, lease.now, lease.until),
      db
        .prepare(`
      SELECT t.id AS target_id, t.type, t.configuration, s.id AS submission_id, s.received_at,
        f.public_id AS form_public_id, f.name AS form_name, s.fields
      FROM deliveries d
        JOIN notification_targets t ON t.id = d.target_id
        JOIN submissions s ON s.id = d.submission_id
        JOIN forms f ON f.id = s.form_id
      WHERE d.id = ?
    `)
        .bind(deliveryId),
    ]),
  );
  const [series] = yield* decodeStarted(begun?.results ?? []).pipe(Effect.mapError(unreadable));
  if (series === undefined) return Option.none<StartedAttempt>();
  const [attempt] = yield* decodeRecorded(recorded?.results ?? []).pipe(
    Effect.mapError(unreadable),
  );
  if (attempt === undefined) return yield* StorageUnavailable.make();
  const row = yield* decodeContext(context?.results[0]).pipe(Effect.mapError(unreadable));
  return Option.some<StartedAttempt>({
    deliveryId,
    attempt: attempt.attempt,
    seriesAttempt: series.attempt_count,
    target: { id: row.target_id, type: row.type, configuration: row.configuration },
    submission: {
      id: row.submission_id,
      receivedAt: row.received_at,
      formPublicId: row.form_public_id,
      formName: row.form_name,
    },
    fields: row.fields,
  });
});

const recordedOutcome = Match.type<typeof AttemptOutcome.Type>().pipe(
  Match.tagsExhaustive({
    Delivered: () => ({ outcome: "delivered", error: null }),
    RetryableFailure: ({ summary }) => ({
      outcome: "retryable-failure",
      error: summarize(summary),
    }),
    PermanentFailure: ({ summary }) => ({
      outcome: "permanent-failure",
      error: summarize(summary),
    }),
  }),
);

const recordedState = Match.type<typeof DeliveryTransition.Type>().pipe(
  Match.tagsExhaustive({
    Delivered: () => ({ status: "delivered", error: null, nextAttemptAt: null }),
    Retrying: ({ error, nextAttemptAt }) => ({ status: "retrying", error, nextAttemptAt }),
    Failed: ({ error }) => ({ status: "failed", error, nextAttemptAt: null }),
  }),
);

const finish = Effect.fn("DeliveryStore.finish")(function* (
  attempt: StartedAttempt,
  outcome: typeof AttemptOutcome.Type,
  transition: typeof DeliveryTransition.Type,
  finishedAt: number,
) {
  const db = yield* database;
  const recorded = recordedOutcome(outcome);
  const state = recordedState(transition);
  yield* d1(() =>
    db.batch([
      db
        .prepare(`
      UPDATE delivery_attempts SET outcome = ?3, error = ?4, finished_at = ?5
      WHERE delivery_id = ?1 AND attempt = ?2
    `)
        .bind(attempt.deliveryId, attempt.attempt, recorded.outcome, recorded.error, finishedAt),
      // A later attempt owns the delivery once this attempt's lease has expired.
      db
        .prepare(`
      UPDATE deliveries SET status = ?3, last_error = ?4,
        next_attempt_at = COALESCE(?5, next_attempt_at), updated_at = ?6
      WHERE id = ?1 AND status = 'processing' AND attempt_count = ?2
    `)
        .bind(
          attempt.deliveryId,
          attempt.seriesAttempt,
          state.status,
          state.error,
          state.nextAttemptAt,
          finishedAt,
        ),
    ]),
  );
});

// The delivery belongs to the submission, in an organization of the account.
const scopedDelivery = `
  d.id = ?1 AND d.submission_id = ?2
  AND EXISTS (
    SELECT 1 FROM submissions s JOIN organization_members m ON m.organization_id = s.organization_id
    WHERE s.id = d.submission_id AND s.organization_id = ?3 AND m.user_id = ?4
  )
`;

const retry = Effect.fn("DeliveryStore.retry")(function* (delivery: DeliveryScope, now: number) {
  const db = yield* database;
  const scope = [
    delivery.deliveryId,
    delivery.submissionId,
    delivery.organizationId,
    delivery.userId,
  ] as const;
  // The new series is due at once, through the same publication as any attempt.
  const [reset, current] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      UPDATE deliveries AS d
      SET status = 'pending', attempt_count = 0, last_error = NULL, next_attempt_at = ?5,
        lease_until = 0, published_at = NULL, updated_at = ?5
      WHERE ${scopedDelivery} AND d.status = 'failed'
      RETURNING id
    `)
        .bind(...scope, now),
      db.prepare(`SELECT d.status FROM deliveries d WHERE ${scopedDelivery}`).bind(...scope),
    ]),
  );
  const retried = yield* decodeClaims(reset?.results ?? []).pipe(Effect.mapError(unreadable));
  if (retried.length > 0) return;
  const [found] = yield* decodeStatus(current?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found === undefined) return yield* DeliveryNotFound.make();
  return yield* DeliveryNotRetryable.make({ status: found.status });
});

export const deliveryStoreLive = Layer.succeed(DeliveryStore, {
  create,
  claimDue,
  claimSubmission,
  markPublished,
  start,
  retry,
  finish,
});
