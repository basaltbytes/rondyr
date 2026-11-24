import { ByteSize, Duration, Effect, Layer, Option, Redacted, Result } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { defaultEmailLanguage, parseEmailRecipients } from "../../domain/deliveries/email.ts";
import {
  CompletePasswordReset,
  passwordResetEmail,
  PasswordResetRequestError,
  RequestPasswordReset,
} from "../../domain/organizations/password-reset.ts";
import { Authentication } from "../ports/authentication.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import { EmailSender } from "../ports/email-sender.ts";
import { PasswordResets, type IssuedPasswordReset } from "../ports/password-resets.ts";
import { enforceClientRateLimit, rateLimitedResponse } from "./client-rate-limit.ts";

const jsonOptions = { headers: { "cache-control": "no-store" } };
const errorJson = HttpServerResponse.schemaJson(PasswordResetRequestError);
const empty = (status: number) =>
  Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        AuthOriginRefused: () => empty(403),
        ClientRateLimited: () => rateLimitedResponse,
        EmailProviderMissing: () =>
          errorJson({ error: "email-provider-missing" }, { status: 503, ...jsonOptions }),
        PasswordResetNotFound: () =>
          errorJson({ error: "reset-invalid" }, { status: 404, ...jsonOptions }),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** Refuse a request from another site: Authentication checks its origin. */
const sameOrigin = Effect.gen(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  yield* auth.userId(request);
  return new URL(request.url).origin;
});

/** Email the link. A failure is logged with its tag only, never with the link. */
const sendLink = Effect.fnUntraced(function* (
  issued: IssuedPasswordReset,
  origin: string,
  language: typeof RequestPasswordReset.Type.language,
) {
  const recipients = parseEmailRecipients([issued.email]);
  if (Result.isFailure(recipients)) return;
  const email = yield* EmailSender;
  const from = yield* email.sender;
  // The secret is in the fragment of the page, which no request carries.
  const link = `${origin}/reset-password#${Redacted.value(issued.token)}`;
  const { subject, text } = passwordResetEmail(
    link,
    issued.expiresAt,
    language ?? defaultEmailLanguage,
  );
  yield* email
    .send({
      from,
      to: recipients.success,
      replyTo: Option.none(),
      subject,
      text,
      idempotencyKey: SecureRandom.uuidV4Unsafe(),
    })
    .pipe(Effect.timeout(Duration.seconds(30)));
});

/**
 * Ask for a reset link. The answer is 202 whether an account has the address
 * or not, and the email leaves after the answer, so neither the answer nor its
 * time tells who has an account.
 */
const request = Effect.gen(function* () {
  yield* enforceClientRateLimit("password-reset-request");
  const origin = yield* sameOrigin;
  const input = yield* HttpServerRequest.schemaBodyJson(RequestPasswordReset, {
    onExcessProperty: "error",
  });
  const email = yield* EmailSender;
  // Without an email provider no link can reach its owner: the form says so.
  yield* email.sender;
  const resets = yield* PasswordResets;
  const issued = yield* resets.issue(input.email);
  if (issued !== null) {
    const tasks = yield* BackgroundTasks;
    yield* tasks.run(
      sendLink(issued, origin, input.language).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Password reset email failed", { tag: error._tag }),
        ),
        Effect.ignore,
      ),
    );
  }
  return HttpServerResponse.empty({ status: 202, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

/** Choose a new password with the secret of a link. The secret travels in the body. */
const complete = Effect.gen(function* () {
  yield* enforceClientRateLimit("password-reset-complete");
  yield* sameOrigin;
  const input = yield* HttpServerRequest.schemaBodyJson(CompletePasswordReset, {
    onExcessProperty: "error",
  });
  const resets = yield* PasswordResets;
  yield* resets.complete(input.token, input.password);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

export const passwordResetRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/api/password-resets", withErrors(request)),
  HttpRouter.add("POST", "/api/password-resets/complete", withErrors(complete)),
);
