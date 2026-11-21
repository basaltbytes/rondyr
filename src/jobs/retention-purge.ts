import { Clock, Effect } from "effect";

import { SubmissionRetention } from "../ports/submission-retention.ts";

/** A batch is one D1 transaction. */
export const purgeBatchSize = 500;

/** A run stops after this many full batches; the next run goes on. */
const batchesPerRun = 20;

/**
 * Delete the messages whose retention period has ended, the oldest first, in
 * batches of 500. Each batch logs and deletes its messages in one transaction,
 * so a run that stops in the middle leaves whole batches behind it, and the
 * next run selects what is still expired.
 */
export const purgeExpiredSubmissions = Effect.fn("Retention.purge")(function* () {
  const retention = yield* SubmissionRetention;
  let deleted = 0;
  for (let batch = 0; batch < batchesPerRun; batch += 1) {
    const now = yield* Clock.currentTimeMillis;
    const count = yield* retention.purgeExpired(now, purgeBatchSize);
    deleted += count;
    if (count < purgeBatchSize) break;
  }
  if (deleted > 0) yield* Effect.logInfo("Retention purge deleted messages", { count: deleted });
  return deleted;
});

/**
 * The purge of the Cron, which runs every minute: once an hour, in the first
 * minute of the hour. Selecting the expired messages reads every older message
 * of an organization with a retention period, so it does not run every minute.
 * A failure is logged and does not fail the Cron.
 */
export const purgeOnTheHour = Effect.fn("Retention.purgeOnTheHour")(function* () {
  const now = yield* Clock.currentTimeMillis;
  if (Math.floor(now / 60_000) % 60 !== 0) return;
  yield* purgeExpiredSubmissions().pipe(
    Effect.catchCause(() => Effect.logError("Retention purge failed", { status: "failed" })),
  );
});
