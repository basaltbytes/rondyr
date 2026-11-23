import { Effect, Layer, Schema } from "effect";

import { DeliveryId, DeliveryStatus, TargetId } from "../../../domain/deliveries/delivery.ts";
import {
  RecordedOutcome,
  type DeliveryAttempt,
  type DeliveryDestination,
  type DeliveryRecord,
} from "../../../domain/deliveries/history.ts";
import { DeliveryHistory } from "../../ports/delivery-history.ts";
import { DeliveryNotFound, type SubmissionScope } from "../../ports/delivery-store.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";
import { listedTypes, StoredTargetType } from "./target-types.ts";

const SubmissionRow = Schema.Struct({ id: Schema.String });
const DeliveryRow = Schema.Struct({
  id: DeliveryId,
  status: DeliveryStatus,
  next_attempt_at: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
  created_at: Schema.Int,
  target_id: TargetId,
  type: StoredTargetType,
  configuration: Schema.String,
});
const AttemptRow = Schema.Struct({
  delivery_id: DeliveryId,
  attempt: Schema.Int,
  started_at: Schema.Int,
  finished_at: Schema.NullOr(Schema.Int),
  outcome: Schema.NullOr(RecordedOutcome),
  error: Schema.NullOr(Schema.String),
});
// Only the value shown to a person: the secrets of a webhook are not decoded.
const WebhookLabel = Schema.fromJsonString(Schema.Struct({ url: Schema.String }));
const EmailLabel = Schema.fromJsonString(
  Schema.Struct({ recipients: Schema.Array(Schema.String) }),
);

const decodeSubmissions = Schema.decodeUnknownEffect(Schema.Array(SubmissionRow));
const decodeDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const decodeAttempts = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
const decodeWebhookLabel = Schema.decodeUnknownEffect(WebhookLabel);
const decodeEmailLabel = Schema.decodeUnknownEffect(EmailLabel);
const decodeConnectorLabel = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

const unreadable = () => StorageUnavailable.make();

function destinationOf(
  row: typeof DeliveryRow.Type,
): Effect.Effect<typeof DeliveryDestination.Type, StorageUnavailable> {
  const { type } = row;
  if (type === "webhook") {
    return decodeWebhookLabel(row.configuration).pipe(
      Effect.mapBoth({
        onSuccess: ({ url }) => ({ targetId: row.target_id, type, url }),
        onFailure: unreadable,
      }),
    );
  }
  if (type === "email") {
    return decodeEmailLabel(row.configuration).pipe(
      Effect.mapBoth({
        onSuccess: ({ recipients }) => ({ targetId: row.target_id, type, recipients }),
        onFailure: unreadable,
      }),
    );
  }
  return decodeConnectorLabel(row.configuration).pipe(
    Effect.mapBoth({
      onSuccess: ({ name }) => ({ targetId: row.target_id, type, name }),
      onFailure: unreadable,
    }),
  );
}

// The submission is in an organization of the account. Every query of this file uses it.
const scopedSubmission = `
  s.id = ?1 AND s.organization_id = ?2
  AND EXISTS (
    SELECT 1 FROM organization_members m WHERE m.organization_id = s.organization_id AND m.user_id = ?3
  )
`;

const list = Effect.fn("DeliveryHistory.list")(function* (submission: SubmissionScope) {
  const db = yield* database;
  const scope = [submission.submissionId, submission.organizationId, submission.userId] as const;
  const [submissions, deliveries, attempts] = yield* d1(() =>
    db.batch([
      db.prepare(`SELECT s.id FROM submissions s WHERE ${scopedSubmission}`).bind(...scope),
      db
        .prepare(`
      SELECT d.id, d.status, d.next_attempt_at, d.last_error, d.created_at,
        t.id AS target_id, t.type, t.configuration
      FROM deliveries d
        JOIN submissions s ON s.id = d.submission_id
        JOIN notification_targets t ON t.id = d.target_id
      WHERE ${scopedSubmission} AND ${listedTypes}
      ORDER BY d.created_at, t.created_at, d.id
    `)
        .bind(...scope),
      db
        .prepare(`
      SELECT a.delivery_id, a.attempt, a.started_at, a.finished_at, a.outcome, a.error
      FROM delivery_attempts a
        JOIN deliveries d ON d.id = a.delivery_id
        JOIN submissions s ON s.id = d.submission_id
      WHERE ${scopedSubmission}
      ORDER BY a.delivery_id, a.attempt
    `)
        .bind(...scope),
    ]),
  );
  const found = yield* decodeSubmissions(submissions?.results ?? []).pipe(
    Effect.mapError(unreadable),
  );
  if (found.length === 0) return yield* DeliveryNotFound.make();
  const rows = yield* decodeDeliveries(deliveries?.results ?? []).pipe(Effect.mapError(unreadable));
  const attemptRows = yield* decodeAttempts(attempts?.results ?? []).pipe(
    Effect.mapError(unreadable),
  );
  return yield* Effect.forEach(rows, (row) =>
    Effect.map(destinationOf(row), (destination): typeof DeliveryRecord.Type => {
      const recorded = attemptRows
        .filter(({ delivery_id }) => delivery_id === row.id)
        .map((attempt): typeof DeliveryAttempt.Type => ({
          attempt: attempt.attempt,
          startedAt: attempt.started_at,
          finishedAt: attempt.finished_at,
          outcome: attempt.outcome,
          error: attempt.error,
        }));
      return {
        id: row.id,
        destination,
        status: row.status,
        attemptCount: recorded.length,
        nextAttemptAt: row.status === "retrying" ? row.next_attempt_at : null,
        lastError: row.last_error,
        createdAt: row.created_at,
        attempts: recorded,
      };
    }),
  );
});

export const deliveryHistoryLive = Layer.succeed(DeliveryHistory, { list });
