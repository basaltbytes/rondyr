import { Schema } from "effect";

/** Stable identifier of one delivery, sent to the recipient on every attempt. */
export const DeliveryId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("DeliveryId"));
export type DeliveryId = typeof DeliveryId.Type;

export const TargetId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).pipe(
  Schema.brand("TargetId"),
);

/** The provider that sends to a target, such as `webhook` or `email`. */
export const TargetType = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** A destination of a form. Its provider decodes `configuration`. */
export const NotificationTarget = Schema.Struct({
  id: TargetId,
  type: TargetType,
  configuration: Schema.Json,
});

export const DeliveryStatus = Schema.Literals([
  "pending",
  "processing",
  "delivered",
  "retrying",
  "failed",
]);

/** What one attempt produced. A summary never contains submission fields. */
export const AttemptOutcome = Schema.Union([
  Schema.TaggedStruct("Delivered", {}),
  Schema.TaggedStruct("RetryableFailure", { summary: Schema.String }),
  Schema.TaggedStruct("PermanentFailure", { summary: Schema.String }),
]);

/** The state of a delivery once an attempt has ended. */
export const DeliveryTransition = Schema.Union([
  Schema.TaggedStruct("Delivered", {}),
  Schema.TaggedStruct("Retrying", { nextAttemptAt: Schema.Int, error: Schema.String }),
  Schema.TaggedStruct("Failed", { error: Schema.String }),
]);

/** Attempts per delivery, including attempts interrupted before their result was recorded. */
export const maxDeliveryAttempts = 6;

/** Wait before attempt `n + 1` after a retryable failure of attempt `n`: 1 min, 5 min, 30 min, 2 h, 6 h. */
export const retryDelays = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;

const summaryLength = 300;

/** Error of a delivery whose last attempt was interrupted when no attempt was left. */
export const interruptedSummary =
  "The last attempt was interrupted before its result was recorded, and no attempt is left.";

export function summarize(summary: string) {
  return summary.length > summaryLength ? `${summary.slice(0, summaryLength - 1)}…` : summary;
}

export function afterAttempt(
  attempt: number,
  outcome: typeof AttemptOutcome.Type,
  finishedAt: number,
): typeof DeliveryTransition.Type {
  if (outcome._tag === "Delivered") return { _tag: "Delivered" };
  const error = summarize(outcome.summary);
  const delay = retryDelays[attempt - 1];
  if (
    outcome._tag === "PermanentFailure" ||
    attempt >= maxDeliveryAttempts ||
    delay === undefined
  ) {
    return { _tag: "Failed", error };
  }
  return { _tag: "Retrying", nextAttemptAt: finishedAt + delay, error };
}
