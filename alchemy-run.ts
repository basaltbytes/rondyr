import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import { Effect, Layer } from "effect";

import RondyrWorker, {
  classificationDeadLetterQueue,
  classificationQueue,
  databaseResource,
  deliveryDeadLetterQueue,
  deliveryQueue,
} from "./src/alchemy-worker.ts";

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
      settings: { batchSize: 10, maxRetries: 3 },
    });

    yield* Cloudflare.Queues.Consumer("DeliveryConsumer", {
      queueId: delivery.queueId,
      scriptName: app.workerName,
      deadLetterQueue: deliveryDeadLetter.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    // D1 keeps the state; each dead-letter consumer logs the IDs and acknowledges.
    yield* Cloudflare.Queues.Consumer("ClassificationDeadLetterConsumer", {
      queueId: deadLetter.queueId,
      scriptName: app.workerName,
      settings: { batchSize: 10 },
    });

    yield* Cloudflare.Queues.Consumer("DeliveryDeadLetterConsumer", {
      queueId: deliveryDeadLetter.queueId,
      scriptName: app.workerName,
      settings: { batchSize: 10 },
    });

    return {
      url: app.url,
      database: database.databaseName,
      classificationQueue: classification.queueName,
      deliveryQueue: delivery.queueName,
    };
  }),
);
