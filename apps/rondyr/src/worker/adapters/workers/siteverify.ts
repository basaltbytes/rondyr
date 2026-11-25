import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { SecretCipher } from "../../ports/secret-cipher.ts";
import {
  TurnstileSecretRefused,
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

// Cloudflare's dummy token. Production secret keys reject it and test secret keys accept it:
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const dummyToken = "XXXX.DUMMY.TOKEN.XXXX";
// Siteverify judges the token only once it has recognized the secret key.
const tokenErrors: ReadonlySet<string> = new Set([
  "invalid-input-response",
  "timeout-or-duplicate",
]);

const siteverify = (
  client: HttpClient.HttpClient,
  secret: string,
  token: string,
  visitorIp = Option.none<string>(),
) => {
  const params = new URLSearchParams({ secret, response: token });
  if (Option.isSome(visitorIp)) params.set("remoteip", visitorIp.value);
  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bodyText(params.toString(), "application/x-www-form-urlencoded"),
  );
  return client.execute(request).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeReply),
    Effect.timeout("5 seconds"),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.mapError(unavailable),
  );
};

export const turnstileVerifierLive = Layer.effect(
  TurnstileVerifier,
  Effect.gen(function* () {
    const cipher = yield* SecretCipher;
    const http = yield* HttpClient.HttpClient;
    // Siteverify answers an unknown secret key with HTTP 400 and `invalid-input-secret`, and
    // does not document the status of other refusals, so the decision comes from the body.
    const client = HttpClient.filterStatus(http, (status) => status === 200 || status === 400);
    const verify = Effect.fn("Turnstile.verify")(function* (
      ...[publicId, sealed, token, visitorIp]: Parameters<TurnstileVerifier["Service"]["verify"]>
    ) {
      yield* Effect.annotateCurrentSpan({ formPublicId: publicId });
      const secret = yield* cipher.open(sealed, turnstileSecretOwner(publicId)).pipe(
        Effect.tapError(() =>
          Effect.annotateCurrentSpan({
            "turnstile.outcome": "unavailable",
            "turnstile.unavailableSource": "secret",
          }),
        ),
        Effect.mapError(() => TurnstileUnavailable.make({ source: "secret" })),
      );
      const reply = yield* siteverify(
        client,
        Redacted.value(secret),
        Redacted.value(token),
        visitorIp,
      ).pipe(
        Effect.tapError(() =>
          Effect.annotateCurrentSpan({
            "turnstile.outcome": "unavailable",
            "turnstile.unavailableSource": "siteverify",
          }),
        ),
      );
      const errors = reply["error-codes"] ?? [];
      if (errors.includes("internal-error") || errors.includes("invalid-input-secret")) {
        yield* Effect.annotateCurrentSpan({
          "turnstile.outcome": "unavailable",
          "turnstile.unavailableSource": "siteverify",
          "turnstile.errorCodes": errors.join(","),
        });
        return yield* unavailable();
      }
      if (reply.success) {
        yield* Effect.annotateCurrentSpan({ "turnstile.outcome": "passed" });
        return { passed: true } as const;
      }
      yield* Effect.annotateCurrentSpan({
        "turnstile.outcome": "rejected",
        ...(errors.length > 0 && { "turnstile.errorCodes": errors.join(",") }),
      });
      return { passed: false, errorCodes: errors } as const;
    });
    const checkSecret = Effect.fn("Turnstile.checkSecret")(function* (
      secret: Redacted.Redacted<string>,
    ) {
      const reply = yield* siteverify(client, Redacted.value(secret), dummyToken);
      const errors = reply["error-codes"] ?? [];
      if (errors.includes("internal-error")) return yield* unavailable();
      const known =
        reply.success || (errors.length > 0 && errors.every((code) => tokenErrors.has(code)));
      if (!known) return yield* TurnstileSecretRefused.make();
    });
    return { verify, checkSecret };
  }),
);
