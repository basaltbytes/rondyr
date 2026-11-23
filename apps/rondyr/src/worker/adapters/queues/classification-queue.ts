import { Effect, Layer } from "effect";

import type { SubmissionId } from "../../../domain/submissions/submission.id.ts";
import { ClassificationQueue, QueueUnavailable } from "../../ports/classification-queue.ts";

const send = Effect.fn("ClassificationQueue.send")(function* (
  submissionIds: ReadonlyArray<SubmissionId>,
) {
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  yield* Effect.tryPromise({
    try: () =>
      env.CLASSIFICATION_QUEUE.sendBatch(
        submissionIds.map((submissionId) => ({ body: { submissionId } })),
      ),
    catch: () => QueueUnavailable.make(),
  });
});

export const classificationQueueLive = Layer.succeed(ClassificationQueue, { send });
