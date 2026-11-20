import { Clock, Effect, Option, Schema } from "effect";

import { RequestClassification } from "../domain/submissions/request-classification.command.ts";
import { Submission } from "../domain/submissions/submission.aggregate.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";
import { ClassificationQueue } from "../ports/classification-queue.ts";
import { Outbox } from "../ports/outbox.ts";

const Message = Schema.Struct({ submissionId: SubmissionId });

const decodeMessage = Schema.decodeUnknownEffect(Message);

export const publishPendingSubmissions = Effect.fn("Outbox.publish")(function* () {
  const outbox = yield* Outbox;
  const queue = yield* ClassificationQueue;
  const now = yield* Clock.currentTimeMillis;
  const lease = { now, until: now + 60_000, republishBefore: now - 300_000 };
  const events = yield* outbox.claimDue(lease, 100);
  if (events.length === 0) return;

  yield* queue.send(events);
  yield* outbox.markPublished(lease, events);
});

export const consumeSubmissions = Effect.fn("Outbox.consume")(function* (batch: MessageBatch) {
  const submissions = yield* Submission;
  const outbox = yield* Outbox;
  for (const message of batch.messages) {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const { submissionId } = yield* decodeMessage(message.body);
        const pending = yield* outbox.pendingOrganization(submissionId);
        if (Option.isNone(pending)) return;

        yield* submissions.send(
          submissionId,
          RequestClassification.make({ organizationId: pending.value }),
          { commandId: `submission-received:${submissionId}` },
        );
        const now = yield* Clock.currentTimeMillis;
        yield* outbox.markHandedOff(submissionId, now);
      }),
    );
    if (result._tag === "Success") {
      message.ack();
    } else {
      yield* Effect.logWarning("Classification queue message requires retry", {
        tag: result.failure._tag,
      });
      message.retry();
    }
  }
});
