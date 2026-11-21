import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { EmailAddress } from "../../domain/deliveries/email.ts";
import { EmailProviderMissing, EmailSender } from "../../ports/email-sender.ts";
import { cloudflareTransport } from "./cloudflare.ts";
import { resendTransport } from "./resend.ts";

/** `RONDYR_EMAIL_PROVIDER`: the email service of a stage. */
export const EmailProviderName = Schema.Literals(["resend", "cloudflare"]);

const EmailSettings = Schema.Struct({
  RONDYR_EMAIL_PROVIDER: Schema.optionalKey(EmailProviderName),
  RONDYR_EMAIL_FROM: Schema.optionalKey(EmailAddress),
  RESEND_API_KEY: Schema.optionalKey(Schema.RedactedFromValue(Schema.NonEmptyString)),
});
export type EmailEnvironment = typeof EmailSettings.Type & {
  readonly CLOUDFLARE_EMAIL?: SendEmail;
};

const decodeSettings = Schema.decodeUnknownEffect(EmailSettings);

/** The settings from the Worker environment. Invalid settings count as missing. */
const emailEnvironmentFromWorker = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.flatMap(({ env }) => {
    const { CLOUDFLARE_EMAIL } = env;
    return decodeSettings(env).pipe(
      Effect.map((settings): EmailEnvironment =>
        CLOUDFLARE_EMAIL === undefined ? settings : { ...settings, CLOUDFLARE_EMAIL },
      ),
    );
  }),
  Effect.tapError(() =>
    Effect.logWarning("Email settings are invalid; email targets are unavailable"),
  ),
  Effect.orElseSucceed((): EmailEnvironment => ({})),
);

const providers = {
  resend: (environment: EmailEnvironment) =>
    Option.match(Option.fromUndefinedOr(environment.RESEND_API_KEY), {
      onNone: () => Effect.succeedNone,
      onSome: (apiKey) => Effect.asSome(resendTransport(apiKey)),
    }),
  cloudflare: (environment: EmailEnvironment) =>
    Effect.succeed(
      Option.map(Option.fromUndefinedOr(environment.CLOUDFLARE_EMAIL), cloudflareTransport),
    ),
};

/** The stage's provider, with the sender address of `RONDYR_EMAIL_FROM`, read on each call. */
export function emailSenderLayer(readEnvironment: Effect.Effect<EmailEnvironment>) {
  const configured = Effect.gen(function* () {
    const environment = yield* readEnvironment;
    const provider = providers[environment.RONDYR_EMAIL_PROVIDER ?? "resend"];
    const transport = yield* provider(environment);
    const from = environment.RONDYR_EMAIL_FROM;
    if (Option.isNone(transport) || from === undefined) return yield* EmailProviderMissing.make();
    return { from, send: transport.value };
  });
  return Layer.effect(
    EmailSender,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const withClient = Effect.provideService(HttpClient.HttpClient, client);
      return {
        sender: withClient(Effect.map(configured, ({ from }) => from)),
        send: (message) => withClient(Effect.flatMap(configured, ({ send }) => send(message))),
      } satisfies EmailSender["Service"];
    }),
  );
}

export const emailSenderLive = emailSenderLayer(emailEnvironmentFromWorker).pipe(
  Layer.provide(FetchHttpClient.layer),
);
