import { Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { EmailRejected, EmailUnavailable, type EmailMessage } from "../../ports/email-sender.ts";

/** https://resend.com/docs/api-reference/emails/send-email */
const endpoint = "https://api.resend.com/emails";

const ResendEmail = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
});
const encodeEmail = Schema.encodeEffect(Schema.fromJsonString(ResendEmail));

// Only the error code of a refusal is kept. Its message can repeat a field of the request.
const ResendError = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z_]{1,64}$/u)),
});
const decodeError = Schema.decodeUnknownEffect(ResendError);

function body(message: EmailMessage): typeof ResendEmail.Type {
  const email = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  };
  return Option.match(message.replyTo, {
    onNone: () => email,
    onSome: (address) => ({ ...email, reply_to: [address] }),
  });
}

// https://resend.com/docs/api-reference/errors: 429 is a rate limit or a quota,
// and 5xx an error on Resend's side; both can succeed later. A concurrent request
// with the same idempotency key is still running. Any other answer is a refusal
// of this request, such as a validation error, an invalid key or an unverified domain.
function retryable(status: number, code: Option.Option<string>) {
  return (
    status === 429 ||
    status >= 500 ||
    (status === 409 && Option.contains(code, "concurrent_idempotent_requests"))
  );
}

function discardBody(response: HttpClientResponse.HttpClientResponse) {
  const stream = Option.flatMapNullishOr(HttpClientResponse.toWeb(response), (web) => web.body);
  if (Option.isNone(stream)) return Effect.void;
  return Effect.tryPromise({ try: () => stream.value.cancel(), catch: () => "cancel-failed" }).pipe(
    Effect.ignore,
  );
}

/** Sends through the Resend API with the delivery ID as its idempotency key. */
export const resendTransport = Effect.fnUntraced(function* (apiKey: Redacted.Redacted<string>) {
  const client = yield* HttpClient.HttpClient;
  return Effect.fn("Resend.send")(function* (message: EmailMessage) {
    const json = yield* encodeEmail(body(message)).pipe(
      Effect.mapError(() => EmailRejected.make({ summary: "The email cannot be encoded." })),
    );
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${Redacted.value(apiKey)}`,
        // Resend refuses a request without a User-Agent.
        "user-agent": "Rondyr-Email/1",
        "idempotency-key": message.idempotencyKey,
      }),
      HttpClientRequest.bodyText(json, "application/json"),
    );
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(() => EmailUnavailable.make({ summary: "Resend could not be reached." })),
    );
    const { status } = response;
    if (status >= 200 && status < 300) return yield* discardBody(response);
    const code = yield* response.json.pipe(
      Effect.flatMap(decodeError),
      Effect.map(({ name }) => Option.some(name)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const summary = Option.match(code, {
      onNone: () => `Resend answered HTTP ${status}.`,
      onSome: (name) => `Resend answered HTTP ${status} (${name}).`,
    });
    return yield* retryable(status, code)
      ? EmailUnavailable.make({ summary })
      : EmailRejected.make({ summary });
  });
});
