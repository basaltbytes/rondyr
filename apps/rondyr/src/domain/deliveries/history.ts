import { Schema } from "effect";

import { DeliveryId, DeliveryStatus, TargetId } from "./delivery.ts";

/** What a recorded attempt produced. */
export const RecordedOutcome = Schema.Literals([
  "delivered",
  "retryable-failure",
  "permanent-failure",
  "interrupted",
]);

/** One attempt of a delivery as the admin API returns it. Times are in milliseconds since the epoch. */
export const DeliveryAttempt = Schema.Struct({
  /** Position in the history of the delivery, from 1. A manual retry continues the numbering. */
  attempt: Schema.Int,
  startedAt: Schema.Int,
  /** `null` with `outcome` while the attempt runs. */
  finishedAt: Schema.NullOr(Schema.Int),
  outcome: Schema.NullOr(RecordedOutcome),
  /** The stored summary, which never contains submission fields. */
  error: Schema.NullOr(Schema.String),
});

/** The target of a delivery, with the value that identifies it for a person. */
export const DeliveryDestination = Schema.Union([
  Schema.Struct({ targetId: TargetId, type: Schema.Literal("webhook"), url: Schema.String }),
  Schema.Struct({
    targetId: TargetId,
    type: Schema.Literal("email"),
    recipients: Schema.Array(Schema.String),
  }),
]);

/** A delivery of a submission and its attempts, oldest first. */
export const DeliveryRecord = Schema.Struct({
  id: DeliveryId,
  destination: DeliveryDestination,
  status: DeliveryStatus,
  /** Every recorded attempt, including those before a manual retry. */
  attemptCount: Schema.Int,
  /** When the next attempt may start. Set only while the delivery is `retrying`. */
  nextAttemptAt: Schema.NullOr(Schema.Int),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.Int,
  attempts: Schema.Array(DeliveryAttempt),
});

/** The answer to a test message sent to a target. No delivery or attempt is stored for it. */
export const TargetTestResult = Schema.Union([
  Schema.Struct({ testId: DeliveryId, outcome: Schema.Literal("delivered") }),
  Schema.Struct({
    testId: DeliveryId,
    outcome: Schema.Literals(["retryable-failure", "permanent-failure"]),
    summary: Schema.String,
  }),
]);
