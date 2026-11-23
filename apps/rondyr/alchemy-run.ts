import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import { Effect, Layer, Schema } from "effect";

import wrangler from "../../wrangler.json" with { type: "json" };
import RondyrWorker, {
  classificationDeadLetterQueue,
  classificationQueue,
  databaseResource,
  deliveryDeadLetterQueue,
  deliveryQueue,
} from "./src/worker/alchemy-worker.ts";

// The root wrangler.json declares the consumers of the queues; each Alchemy consumer gets
// the same settings. The logical IDs below name existing resources of the prod stage:
// renaming one would replace that consumer.
const ConsumerConfig = Schema.Struct({
  queue: Schema.String,
  dead_letter_queue: Schema.optionalKey(Schema.String),
  max_batch_size: Schema.Int,
  max_batch_timeout: Schema.Finite,
  max_retries: Schema.optionalKey(Schema.Int),
});
const QueueConfig = Schema.Struct({
  producers: Schema.Array(Schema.Struct({ binding: Schema.String, queue: Schema.String })),
  consumers: Schema.Array(ConsumerConfig),
});

/** The consumer settings of a producer's queue, or of its dead-letter queue. */
const consumerSettings = Effect.fn("consumerSettings")(function* (
  binding: string,
  queue: "queue" | "dead-letter",
) {
  const { producers, consumers } = yield* Schema.decodeEffect(QueueConfig)(wrangler.queues).pipe(
    Effect.orDie,
  );
  const producer = producers.find((candidate) => candidate.binding === binding);
  const consumer = consumers.find((candidate) => candidate.queue === producer?.queue);
  const name = queue === "queue" ? consumer?.queue : consumer?.dead_letter_queue;
  const settings = consumers.find((candidate) => candidate.queue === name);
  if (settings === undefined) {
    // scripts/doctor.mjs checks the same declarations in CI.
    return yield* Effect.die(`wrangler.json declares no ${queue} consumer for ${binding}`);
  }
  return {
    batchSize: settings.max_batch_size,
    maxWaitTimeMs: settings.max_batch_timeout * 1000,
    ...(settings.max_retries !== undefined && { maxRetries: settings.max_retries }),
  };
});

export default Alchemy.Stack(
  "Rondyr",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    state: Layer.unwrap(
      Effect.map(Alchemy.AlchemyContext, ({ dev }) =>
        dev ? Alchemy.localState() : Cloudflare.state(),
      ),
    ),
  },
  Effect.gen(function* () {
    const database = yield* databaseResource;
    const classification = yield* classificationQueue;
    const delivery = yield* deliveryQueue;
    const deadLetter = yield* classificationDeadLetterQueue;
    const deliveryDeadLetter = yield* deliveryDeadLetterQueue;
    // The Worker adds the email binding only for a stage configured for Cloudflare Email Sending.
    const app = yield* RondyrWorker;

    yield* Cloudflare.Queues.Consumer("ClassificationConsumer", {
      queueId: classification.queueId,
      scriptName: app.workerName,
      deadLetterQueue: deadLetter.queueName,
      settings: yield* consumerSettings("CLASSIFICATION_QUEUE", "queue"),
    });

    yield* Cloudflare.Queues.Consumer("DeliveryConsumer", {
      queueId: delivery.queueId,
      scriptName: app.workerName,
      deadLetterQueue: deliveryDeadLetter.queueName,
      settings: yield* consumerSettings("DELIVERY_QUEUE", "queue"),
    });

    // D1 keeps the state; each dead-letter consumer logs the IDs and acknowledges.
    yield* Cloudflare.Queues.Consumer("ClassificationDeadLetterConsumer", {
      queueId: deadLetter.queueId,
      scriptName: app.workerName,
      settings: yield* consumerSettings("CLASSIFICATION_QUEUE", "dead-letter"),
    });

    yield* Cloudflare.Queues.Consumer("DeliveryDeadLetterConsumer", {
      queueId: deliveryDeadLetter.queueId,
      scriptName: app.workerName,
      settings: yield* consumerSettings("DELIVERY_QUEUE", "dead-letter"),
    });

    return {
      url: app.url,
      database: database.databaseName,
      classificationQueue: classification.queueName,
      deliveryQueue: delivery.queueName,
    };
  }),
);
