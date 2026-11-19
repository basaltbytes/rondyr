import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer } from "effect";

import RondyrWorker, {
  classificationQueue,
  databaseResource,
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
    const { dev } = yield* Alchemy.AlchemyContext;
    const database = yield* databaseResource;
    const classification = yield* classificationQueue;
    const delivery = yield* deliveryQueue;
    const deadLetter = yield* Cloudflare.Queues.Queue("ClassificationDeadLetterQueue");
    const app = yield* RondyrWorker;

    yield* Cloudflare.Queues.Consumer("ClassificationConsumer", {
      queueId: classification.queueId,
      scriptName: app.workerName,
      deadLetterQueue: deadLetter.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    const enableGateway = yield* Config.Boolean("RONDYR_AI_GATEWAY").pipe(
      Config.withDefault(false),
    );
    const gateway =
      enableGateway && !dev
        ? yield* Cloudflare.AI.Gateway("AiGateway", { collectLogs: false })
        : undefined;

    return {
      url: app.url,
      aiGateway: gateway?.gatewayId,
      database: database.databaseName,
      classificationQueue: classification.queueName,
      deliveryQueue: delivery.queueName,
    };
  }),
);
