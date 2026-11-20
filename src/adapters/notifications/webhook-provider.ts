import { Clock, DateTime, Effect, Option, Redacted, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { parseWebhookUrl } from "../../domain/deliveries/webhook-destination.ts";
import { WebhookPayload, webhookHeaders } from "../../domain/deliveries/webhook.ts";
import {
  NotificationFailed,
  type Notification,
  type NotificationProvider,
} from "../../ports/notification-provider.ts";
import { SecretCipher } from "../../ports/secret-cipher.ts";
import { WebhookConfiguration } from "./webhook-configuration.ts";

/** Larger bodies are not sent. A submission is at most 16 KiB, so this leaves room. */
const maxBodyBytes = 65_536;

const encoder = new TextEncoder();
const decodeConfiguration = Schema.decodeUnknownEffect(WebhookConfiguration);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(WebhookPayload));

const WorkerEnvironment = Schema.Struct({ BETTER_AUTH_URL: Schema.optionalKey(Schema.String) });

/** The Worker's own origin, which is never a destination. */
const workerOrigin = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.flatMap(({ env }) => Schema.decodeUnknownEffect(WorkerEnvironment)(env)),
  Effect.map(({ BETTER_AUTH_URL: origin }) => Option.fromUndefinedOr(origin)),
  Effect.orElseSucceed(() => Option.none<string>()),
);

function permanent(summary: string) {
  return NotificationFailed.make({ retryable: false, summary });
}

function retryable(summary: string) {
  return NotificationFailed.make({ retryable: true, summary });
}

/** 2xx is a success. 408, 425, 429 and 5xx are retried; any other status ends the delivery. */
function failureFor(status: number) {
  if (status >= 200 && status < 300) return Option.none<NotificationFailed>();
  const answered = `The recipient answered HTTP ${status}.`;
  if (status >= 300 && status < 400) {
    return Option.some(permanent(`${answered} Redirects are not followed.`));
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return Option.some(retryable(answered));
  }
  return Option.some(permanent(answered));
}

// The body is never read: a summary is the status code only.
function discardBody(response: HttpClientResponse.HttpClientResponse) {
  const body = Option.flatMapNullishOr(HttpClientResponse.toWeb(response), (web) => web.body);
  if (Option.isNone(body)) return Effect.void;
  return Effect.tryPromise({ try: () => body.value.cancel(), catch: () => "cancel-failed" }).pipe(
    Effect.ignore,
  );
}

const sign = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>, content: Uint8Array) {
  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      encoder.encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign("HMAC", key, new Uint8Array(content)),
  );
  return `v1=${Hex.encode(new Uint8Array(signature))}`;
});

/**
 * Sends a delivery as a signed POST. Only the status of the response is read,
 * and summaries contain the status, never the submission fields.
 */
export const webhookProvider = Effect.gen(function* () {
  const cipher = yield* SecretCipher;
  const client = yield* HttpClient.HttpClient;

  const signingSecrets = Effect.fnUntraced(function* (
    notification: Notification,
    configuration: typeof WebhookConfiguration.Type,
    now: number,
  ) {
    const owner = notification.target.id;
    const current = yield* cipher
      .open(configuration.secret, owner)
      .pipe(
        Effect.mapError(() =>
          permanent("The signing secret of this webhook target cannot be decrypted."),
        ),
      );
    const previous = configuration.previousSecret;
    if (previous === null || previous.expiresAt <= now) return [current];
    // A previous secret that does not open is left out rather than failing the delivery.
    const older = yield* cipher.open(previous.secret, owner).pipe(
      Effect.asSome,
      Effect.tapError(() =>
        Effect.logWarning("Previous webhook secret cannot be decrypted", { targetId: owner }),
      ),
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
    );
    return Option.match(older, { onNone: () => [current], onSome: (value) => [current, value] });
  });

  const send = Effect.fn("WebhookProvider.send")(function* (notification: Notification) {
    yield* Effect.annotateCurrentSpan({
      deliveryId: notification.deliveryId,
      targetId: notification.target.id,
    });
    const configuration = yield* decodeConfiguration(notification.target.configuration).pipe(
      Effect.mapError(() => permanent("The webhook target configuration is invalid.")),
    );
    const origin = yield* workerOrigin;
    const destination = parseWebhookUrl(configuration.url, origin);
    if (Result.isFailure(destination)) {
      return yield* permanent(`The webhook URL is refused: ${destination.failure}.`);
    }
    const now = yield* Clock.currentTimeMillis;
    const secrets = yield* signingSecrets(notification, configuration, now);

    const body = yield* encodePayload({
      version: 1,
      type: "submission.accepted",
      deliveryId: notification.deliveryId,
      submission: {
        id: notification.submission.id,
        receivedAt: DateTime.makeUnsafe(notification.submission.receivedAt),
        fields: notification.fields,
      },
      form: { id: notification.submission.formPublicId, name: notification.submission.formName },
    }).pipe(Effect.mapError(() => permanent("The webhook body cannot be encoded.")));
    const bytes = encoder.encode(body);
    if (bytes.byteLength > maxBodyBytes) {
      return yield* permanent(`The webhook body is larger than ${maxBodyBytes} bytes.`);
    }

    const timestamp = String(Math.floor(now / 1000));
    const signed = encoder.encode(`${timestamp}.${body}`);
    const signatures = yield* Effect.forEach(secrets, (secret) => sign(secret, signed));
    const request = HttpClientRequest.post(destination.success).pipe(
      HttpClientRequest.setHeaders({
        "user-agent": "Rondyr-Webhook/1",
        [webhookHeaders.deliveryId]: notification.deliveryId,
        [webhookHeaders.timestamp]: timestamp,
        [webhookHeaders.signature]: signatures.join(","),
      }),
      HttpClientRequest.bodyText(body, "application/json"),
    );
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(() => retryable("The recipient could not be reached.")),
    );
    yield* discardBody(response);
    const failure = failureFor(response.status);
    if (Option.isSome(failure)) return yield* failure.value;
  });

  return { send } satisfies NotificationProvider["Service"];
});
