import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Option, type Redacted } from "effect";
import wrangler from "./wrangler.json" with { type: "json" };

type AuthBindings = {
  BETTER_AUTH_SECRET?: Redacted.Redacted<string>;
  BETTER_AUTH_URL?: string;
  RONDYR_SETUP_TOKEN?: Redacted.Redacted<string>;
};

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
    const { dev } = yield* Alchemy.AlchemyContext;
    const { stage } = yield* Alchemy.Stack;
    const secret = Config.Redacted("BETTER_AUTH_SECRET");
    const url = Config.String("BETTER_AUTH_URL");
    const authSecret = yield* dev ? Config.option(secret) : secret.pipe(Config.map(Option.some));
    const authUrl = yield* dev ? Config.option(url) : url.pipe(Config.map(Option.some));
    const setupToken = yield* Config.option(Config.Redacted("RONDYR_SETUP_TOKEN"));
    const authBindings: AuthBindings = {};
    if (Option.isSome(authSecret)) authBindings.BETTER_AUTH_SECRET = authSecret.value;
    if (Option.isSome(authUrl)) authBindings.BETTER_AUTH_URL = authUrl.value;
    if (Option.isSome(setupToken)) authBindings.RONDYR_SETUP_TOKEN = setupToken.value;

    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: "./database/migrations",
    });
    const classificationQueue = yield* Cloudflare.Queues.Queue("ClassificationQueue");
    const deliveryQueue = yield* Cloudflare.Queues.Queue("DeliveryQueue");

    const app = yield* Cloudflare.Website.Vite("App", {
      name: `rondyr-${stage}`,
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
        ...authBindings,
      },
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
      classificationQueue: classificationQueue.queueName,
      deliveryQueue: deliveryQueue.queueName,
    };
  }),
);
