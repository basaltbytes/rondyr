import { Clock, Effect, Result } from "effect";

import { CronHeartbeat } from "../ports/operations-status.ts";
import { publishPendingDeliveries } from "./delivery-outbox.ts";
import { publishPendingSubmissions } from "./submission-outbox.ts";

export const publishOutboxes = Effect.fn("Cron.publishOutboxes")(
  function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    // One outbox failing does not keep the other from being published.
    const [submissions, deliveries] = yield* Effect.all(
      [publishPendingSubmissions(), publishPendingDeliveries()],
      { concurrency: "unbounded", mode: "result" },
    );
    if (Result.isFailure(submissions)) return yield* submissions.failure;
    if (Result.isFailure(deliveries)) return yield* deliveries.failure;
    const heartbeat = yield* CronHeartbeat;
    yield* heartbeat.recordSuccess;
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("Cron publication finished", {
      status: "success",
      durationMs: finishedAt - startedAt,
    });
  },
  Effect.catchCause(() =>
    Effect.andThen(
      Effect.logError("Cron publication failed", { status: "failed" }),
      Effect.die("Cron publication failed"),
    ),
  ),
);
