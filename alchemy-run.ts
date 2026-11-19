import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer } from "effect";
import wrangler from "./wrangler.json" with { type: "json" };

export default Alchemy.Stack(
  "Rondyr",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(Alchemy.AlchemyContext, ({ dev }) =>
        dev ? Alchemy.localState() : Cloudflare.state(),
      ),
    ),
  },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: "./database/migrations",
    });
    const classificationQueue = yield* Cloudflare.Queues.Queue("ClassificationQueue");
    const deliveryQueue = yield* Cloudflare.Queues.Queue("DeliveryQueue");

    const app = yield* Cloudflare.Website.Vite("App", {
      main: wrangler.main,
      compatibility: {
        date: wrangler.compatibility_date,
        flags: ["nodejs_compat", "new_module_registry"],
      },
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: wrangler.assets.run_worker_first,
      },
      observability: wrangler.observability,
      env: {
        DB: database,
        CLASSIFICATION_QUEUE: classificationQueue,
        DELIVERY_QUEUE: deliveryQueue,
        AI: Cloudflare.Workers.AI(),
      },
    });

    const enableGateway = yield* Config.Boolean("RONDYR_AI_GATEWAY").pipe(
      Config.withDefault(false),
    );
    const { dev } = yield* Alchemy.AlchemyContext;
    const gateway =
      enableGateway && !dev
        ? yield* Cloudflare.AI.Gateway("AiGateway", { collectLogs: false })
        : undefined;

    return {
      url: app.url,
      aiGateway: gateway?.gatewayId,
      database: database.databaseName,
      classificationQueue: classificationQueue.queueName,
      deliveryQueue: deliveryQueue.queueName,
    };
  }),
);
