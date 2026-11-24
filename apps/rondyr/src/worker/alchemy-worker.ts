import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Option, Schema } from "effect";

import wrangler from "../../../../wrangler.json" with { type: "json" };
import { EmailProviderName } from "./adapters/email/email-sender.ts";
import { EmailAddress } from "../domain/deliveries/email.ts";
import {
  ClassifierProvider,
  defaultClassifier,
} from "../domain/submissions/classification-policy.ts";
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

export const classificationDeadLetterQueue = Cloudflare.Queues.Queue(
  "ClassificationDeadLetterQueue",
);

export const deliveryDeadLetterQueue = Cloudflare.Queues.Queue("DeliveryDeadLetterQueue");

// wrangler.json declares the rate limits for local runs and tests; the deployed
// Worker gets the same namespaces and limits: the client limit of the intake,
// then the limit on the test messages of a destination.
const RateLimitConfig = <Name extends string>(name: Name) =>
  Schema.Struct({
    name: Schema.Literal(name),
    namespace_id: Schema.String,
    simple: Schema.Struct({ limit: Schema.Int, period: Schema.Literals([10, 60]) }),
  });
const rateLimits = Schema.decodeUnknownEffect(
  Schema.Tuple([RateLimitConfig("CLIENT_RATE_LIMIT"), RateLimitConfig("TARGET_TEST_RATE_LIMIT")]),
)(wrangler.ratelimits).pipe(
  Effect.map(([client, tests]) =>
    [client, tests].map(({ name, namespace_id: namespaceId, simple }) =>
      Cloudflare.Workers.RateLimit(name, { namespaceId, simple }),
    ),
  ),
  // scripts/doctor.mjs checks the same declarations in CI.
  Effect.orDie,
);

const deploymentProps = Effect.gen(function* () {
  const { dev } = yield* Alchemy.AlchemyContext;
  const { stage } = yield* Alchemy.Stack;
  const database = yield* databaseResource;
  const classification = yield* classificationQueue;
  const delivery = yield* deliveryQueue;
  const classificationDeadLetter = yield* classificationDeadLetterQueue;
  const deliveryDeadLetter = yield* deliveryDeadLetterQueue;
  const secret = Config.Redacted("BETTER_AUTH_SECRET");
  const authSecret = yield* dev ? Config.option(secret) : secret.pipe(Config.map(Option.some));
  const authUrl = yield* dev
    ? Config.option(Config.URL("BETTER_AUTH_URL"))
    : deployedOrigin.pipe(Config.map(Option.some));
  const setupToken = yield* Config.option(Config.Redacted("RONDYR_SETUP_TOKEN"));
  // Without it, webhook targets cannot be created or rotated; everything else works.
  const secretsKey = yield* Config.option(Config.Redacted("RONDYR_SECRETS_KEY"));
  const classifier = yield* Config.schema(ClassifierProvider, "RONDYR_CLASSIFIER").pipe(
    Config.withDefault(defaultClassifier),
  );
  const escalationClassifier = yield* Config.option(
    Config.schema(ClassifierProvider, "RONDYR_ESCALATION_CLASSIFIER"),
  );
  // Email targets require a sender and the selected provider's credentials or binding.
  const emailProvider = yield* Config.schema(EmailProviderName, "RONDYR_EMAIL_PROVIDER").pipe(
    Config.withDefault("resend"),
  );
  const emailFrom = yield* Config.option(Config.schema(EmailAddress, "RONDYR_EMAIL_FROM"));
  const resendKey = yield* emailProvider === "resend"
    ? Config.option(Config.Redacted("RESEND_API_KEY"))
    : Effect.succeedNone;
  const cloudflareEmail = yield* emailProvider === "cloudflare" && Option.isSome(emailFrom)
    ? Effect.asSome(Cloudflare.Email.SendEmail("CLOUDFLARE_EMAIL"))
    : Effect.succeedNone;
  const [clientRateLimit, testRateLimit] = yield* rateLimits;
  return {
    main: import.meta.url,
    name: `rondyr-${stage}`,
    ...(!dev && stage === "prod" && Option.isSome(authUrl)
      ? { domain: authUrl.value.hostname, workersDev: false }
      : { workersDev: true }),
    compatibility: {
      date: wrangler.compatibility_date,
      flags: wrangler.compatibility_flags,
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
      CLIENT_RATE_LIMIT: clientRateLimit,
      TARGET_TEST_RATE_LIMIT: testRateLimit,
      // The queue handler tells the queues apart by name.
      CLASSIFICATION_QUEUE_NAME: classification.queueName,
      DELIVERY_QUEUE_NAME: delivery.queueName,
      CLASSIFICATION_DEAD_LETTER_QUEUE_NAME: classificationDeadLetter.queueName,
      DELIVERY_DEAD_LETTER_QUEUE_NAME: deliveryDeadLetter.queueName,
      RONDYR_CLASSIFIER: classifier,
      ...(Option.isSome(escalationClassifier) && {
        RONDYR_ESCALATION_CLASSIFIER: escalationClassifier.value,
      }),
      RONDYR_EMAIL_PROVIDER: emailProvider,
      ...(!dev && { AI: Cloudflare.Workers.AI() }),
      ...(Option.isSome(authSecret) && { BETTER_AUTH_SECRET: authSecret.value }),
      ...(Option.isSome(authUrl) && { BETTER_AUTH_URL: authUrl.value.origin }),
      ...(Option.isSome(setupToken) && { RONDYR_SETUP_TOKEN: setupToken.value }),
      ...(Option.isSome(secretsKey) && { RONDYR_SECRETS_KEY: secretsKey.value }),
      ...(Option.isSome(emailFrom) && { RONDYR_EMAIL_FROM: emailFrom.value }),
      ...(Option.isSome(resendKey) && { RESEND_API_KEY: resendKey.value }),
      ...(Option.isSome(cloudflareEmail) && { CLOUDFLARE_EMAIL: cloudflareEmail.value }),
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
