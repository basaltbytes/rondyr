import { Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { SecretCipher } from "../../ports/secret-cipher.ts";
import {
  TurnstileUnavailable,
  TurnstileVerifier,
  turnstileSecretOwner,
} from "../../ports/turnstile-verifier.ts";

const SiteverifyReply = Schema.Struct({
  success: Schema.Boolean,
  "error-codes": Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeReply = Schema.decodeUnknownEffect(SiteverifyReply);
const unavailable = () => TurnstileUnavailable.make({ source: "siteverify" });
const endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const turnstileVerifierLive = Layer.effect(
  TurnstileVerifier,
  Effect.gen(function* () {
    const cipher = yield* SecretCipher;
    const http = yield* HttpClient.HttpClient;
    const client = HttpClient.filterStatusOk(http);
    const verify = Effect.fn("Turnstile.verify")(function* (
      ...[publicId, sealed, token]: Parameters<TurnstileVerifier["Service"]["verify"]>
    ) {
      const secret = yield* cipher
        .open(sealed, turnstileSecretOwner(publicId))
        .pipe(Effect.mapError(() => TurnstileUnavailable.make({ source: "secret" })));
      const params = new URLSearchParams({
        secret: Redacted.value(secret),
        response: Redacted.value(token),
      });
      const request = HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bodyText(params.toString(), "application/x-www-form-urlencoded"),
      );
      const reply = yield* client.execute(request).pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeReply),
        Effect.timeout("5 seconds"),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(unavailable),
      );
      const errors = reply["error-codes"] ?? [];
      if (errors.includes("internal-error") || errors.includes("invalid-input-secret")) {
        return yield* unavailable();
      }
      return reply.success;
    });
    return { verify };
  }),
);
