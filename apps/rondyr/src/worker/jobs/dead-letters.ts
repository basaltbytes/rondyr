import { Effect, Option, Schema } from "effect";

import { DeliveryId } from "../../domain/deliveries/delivery.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";

/**
 * What a dead-lettered message refers to. D1 keeps the state of each submission
 * and delivery, so the message only signals a failure and nothing replays it.
 */
const DeadLetter = Schema.Union([
  Schema.Struct({ submissionId: SubmissionId }),
  Schema.Struct({ deliveryId: DeliveryId }),
]);

const decodeDeadLetter = Schema.decodeUnknownOption(DeadLetter);

/**
 * Consume a dead-letter queue: log the IDs of each message and acknowledge it.
 * A message that does not decode is logged with its queue message ID only.
 */
export const consumeDeadLetters = Effect.fn("DeadLetters.consume")(function* (
  queue: "classification" | "delivery",
  batch: MessageBatch,
) {
  for (const message of batch.messages) {
    const ids = Option.getOrElse(decodeDeadLetter(message.body), () => ({}));
    yield* Effect.logError("Queue message dead-lettered", {
      queue,
      messageId: message.id,
      attempts: message.attempts,
      ...ids,
    });
    message.ack();
  }
});
