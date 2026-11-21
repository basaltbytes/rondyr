import { Effect, Option, Schema } from "effect";

import { EmailRejected, EmailUnavailable, type EmailMessage } from "../../ports/email-sender.ts";

// The binding throws a coded Error, without an HTTP status. Keep only documented
// codes since the error may quote an address or the contents of the message.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/#error-codes
const CloudflareEmailError = Schema.Struct({
  code: Schema.Literals([
    "E_VALIDATION_ERROR",
    "E_FIELD_MISSING",
    "E_TOO_MANY_RECIPIENTS",
    "E_TOO_MANY_ATTACHMENTS",
    "E_SENDER_NOT_VERIFIED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_SENDER_DOMAIN_NOT_CONFIGURED",
    "E_EMAIL_SENDING_NOT_READY",
    "E_RECIPIENT_NOT_ALLOWED",
    "E_RECIPIENT_PLAN_RESTRICTED",
    "E_RECIPIENT_SUPPRESSED",
    "E_ACCOUNT_SUSPENDED",
    "E_CONTENT_TOO_LARGE",
    "E_DELIVERY_FAILED",
    "E_RATE_LIMIT_EXCEEDED",
    "E_DAILY_LIMIT_EXCEEDED",
    "E_INTERNAL_SERVER_ERROR",
    "E_HEADER_NOT_ALLOWED",
    "E_HEADER_USE_API_FIELD",
    "E_HEADER_VALUE_INVALID",
    "E_HEADER_VALUE_TOO_LONG",
    "E_HEADER_NAME_INVALID",
    "E_HEADERS_TOO_LARGE",
    "E_HEADERS_TOO_MANY",
  ]),
});
const decodeError = Schema.decodeUnknownOption(CloudflareEmailError);

function codedError({ code }: typeof CloudflareEmailError.Type) {
  const summary = `Cloudflare Email Sending failed (${code}).`;
  switch (code) {
    case "E_EMAIL_SENDING_NOT_READY":
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
    case "E_INTERNAL_SERVER_ERROR":
      return EmailUnavailable.make({ summary });
    default:
      return EmailRejected.make({ summary });
  }
}

export function cloudflareTransport(binding: SendEmail) {
  return Effect.fn("CloudflareEmail.send")((message: EmailMessage) =>
    Effect.tryPromise({
      // Email Sending has no idempotency key. The delivery ID is in the text.
      try: () =>
        binding.send({
          from: message.from,
          to: [...message.to],
          subject: message.subject,
          text: message.text,
          ...(Option.isSome(message.replyTo) && { replyTo: message.replyTo.value }),
        }),
      catch: (error) => {
        const decoded = decodeError(error);
        if (Option.isSome(decoded)) return codedError(decoded.value);
        return error instanceof TypeError
          ? EmailRejected.make({ summary: "Cloudflare rejected the email payload." })
          : EmailUnavailable.make({
              summary: "Cloudflare Email Sending failed without a known code.",
            });
      },
    }).pipe(Effect.asVoid),
  );
}
