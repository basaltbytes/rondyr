import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Option, Schema } from "effect";

import wrangler from "../wrangler.json" with { type: "json" };
import { ClassifierProvider } from "./adapters/ai/classifier.ts";
import { workerImplementation } from "./worker-implementation.ts";

const deployedOrigin = Config.schema(
  Schema.URL.check(
    Schema.makeFilter(
      (url) =>
        (url.protocol === "https:" && url.port === "" && url.href === `${url.origin}/`) ||
        "Expected an HTTPS origin with no path, credentials, or custom port",
    ),
  ),
  "BETTER_AUTH_URL",
);

export const databaseResource = Cloudflare.D1.Database("Database", {
  migrations: "./database/migrations",
});

export const classificationQueue = Cloudflare.Queues.Queue("ClassificationQueue");

export const deliveryQueue = Cloudflare.Queues.Queue("DeliveryQueue");

const deploymentProps = Effect.gen(function* () {
  const { dev } = yield* Alchemy.AlchemyContext;
  const { stage } = yield* Alchemy.Stack;
  const database = yield* databaseResource;
  const classification = yield* classificationQueue;
  const delivery = yield* deliveryQueue;
  const secret = Config.Redacted("BETTER_AUTH_SECRET");
  const authSecret = yield* dev ? Config.option(secret) : secret.pipe(Config.map(Option.some));
  const authUrl = yield* dev
    ? Config.option(Config.URL("BETTER_AUTH_URL"))
    : deployedOrigin.pipe(Config.map(Option.some));
  const setupToken = yield* Config.option(Config.Redacted("RONDYR_SETUP_TOKEN"));
  const classifier = yield* Config.schema(ClassifierProvider, "RONDYR_CLASSIFIER").pipe(
    Config.withDefault("jev"),
  );
  return {
    main: import.meta.url,
    name: `rondyr-${stage}`,
    ...(!dev && stage === "prod" && Option.isSome(authUrl)
      ? { domain: authUrl.value.hostname, workersDev: false }
      : { workersDev: true }),
    compatibility: {
      date: wrangler.compatibility_date,
      flags: ["nodejs_compat", "new_module_registry"],
    },
    assets: {
      directory: "./dist/client",
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: wrangler.assets.run_worker_first,
    },
    crons: wrangler.triggers.crons,
    observability: wrangler.observability,
    env: {
      DB: database,
      CLASSIFICATION_QUEUE: classification,
      DELIVERY_QUEUE: delivery,
      RONDYR_CLASSIFIER: classifier,
      ...(!dev && { AI: Cloudflare.Workers.AI() }),
      ...(Option.isSome(authSecret) && { BETTER_AUTH_SECRET: authSecret.value }),
      ...(Option.isSome(authUrl) && { BETTER_AUTH_URL: authUrl.value.origin }),
      ...(Option.isSome(setupToken) && { RONDYR_SETUP_TOKEN: setupToken.value }),
    },
  };
});

const props =
  globalThis.__ALCHEMY_RUNTIME__ === true
    ? Effect.succeed({ main: import.meta.url })
    : deploymentProps;

export default class RondyrWorker extends Cloudflare.Worker<RondyrWorker>()(
  "App",
  props,
  workerImplementation,
) {}
