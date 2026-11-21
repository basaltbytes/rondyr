import { Effect } from "effect";

import { SubmissionRetention, type RetentionLane } from "../ports/submission-retention.ts";

/** A batch is one D1 transaction. */
export const purgeBatchSize = 500;

/** A run stops after this many batches; the next run goes on. */
const batchesPerRun = 20;

const hourMillis = 3_600_000;

/**
 * Delete the messages whose retention period has ended at `now`, in batches of
 * 500. Each organization's period for accepted messages, and for quarantined
 * and archived ones, is a lane; each batch reads only the messages of its lane
 * received before the end of the period, the oldest first. The lanes take turns,
 * one batch each, so an organization with a large backlog delays the others by
 * one batch at most, and a run does at most 20 batches. Each run starts at
 * another lane, so every lane gets a turn when there are more lanes than
 * batches. A batch logs and deletes its messages in one transaction, so a run
 * that stops in the middle leaves whole batches behind it, and the next run
 * selects what is still expired.
 */
export const purgeExpiredSubmissions = Effect.fn("Retention.purge")(function* (now: number) {
  const retention = yield* SubmissionRetention;
  const lanes = yield* retention.retentionLanes(now);
  const start = lanes.length === 0 ? 0 : Math.floor(now / hourMillis) % lanes.length;
  let turn: ReadonlyArray<RetentionLane> = [...lanes.slice(start), ...lanes.slice(0, start)];
  let batches = 0;
  let deleted = 0;
  while (turn.length > 0 && batches < batchesPerRun) {
    const unfinished: Array<RetentionLane> = [];
    for (const lane of turn.slice(0, batchesPerRun - batches)) {
      batches += 1;
      const count = yield* retention.purgeLane(lane, now, purgeBatchSize);
      deleted += count;
      if (count === purgeBatchSize) unfinished.push(lane);
    }
    turn = unfinished;
  }
  if (deleted > 0) yield* Effect.logInfo("Retention purge deleted messages", { count: deleted });
  return deleted;
});

/**
 * The purge of the Cron, which runs every minute: once an hour, in the run
 * scheduled for the first minute of the hour. A batch reads the messages of its
 * organization older than the end of the period, kept ones included, so the
 * purge does not run every minute. A failure is logged and does not fail the Cron.
 */
export const purgeOnTheHour = Effect.fn("Retention.purgeOnTheHour")(function* (
  scheduledTime: number,
) {
  if (Math.floor(scheduledTime / 60_000) % 60 !== 0) return;
  yield* purgeExpiredSubmissions(scheduledTime).pipe(
    Effect.catchCause(() => Effect.logError("Retention purge failed", { status: "failed" })),
  );
});
