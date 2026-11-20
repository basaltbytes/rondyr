import { Context, Effect, Schema } from "effect";

import type { SubmissionId } from "../domain/submissions/submission.id.ts";

export class QueueUnavailable extends Schema.TaggedError<
  QueueUnavailable,
  { readonly brand: unique symbol }
>()("QueueUnavailable", {}) {}

export class ClassificationQueue extends Context.Service<
  ClassificationQueue,
  {
    /** Send one message per submission. The queue can deliver a message more than once. */
    readonly send: (
      submissionIds: ReadonlyArray<SubmissionId>,
    ) => Effect.Effect<void, QueueUnavailable>;
  }
>()("rondyr/ports/classification-queue/ClassificationQueue") {}
