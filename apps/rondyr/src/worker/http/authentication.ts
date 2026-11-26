import { ByteSize, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { defaultEmailLanguage, parseEmailRecipients } from "../../domain/deliveries/email.ts";
import { PasskeyId } from "../../domain/organizations/account.ts";
import {
  AccountPasskeys,
  AddPasskeyVerifyInput,
  AuthSession,
  EmailOtpError,
  emailOtpEmail,
  PasskeyCreationOptions,
  PasskeyError,
  PasskeyRequestOptions,
  PasskeySignInVerifyInput,
  PasskeySummary,
  RecoveryOptionsInput,
  RecoveryVerifyInput,
  RenamePasskeyInput,
  RequestEmailOtp,
  SessionResponse,
  SetupOptionsInput,
  SetupVerifyInput,
  VerifyEmailOtp,
} from "../../domain/organizations/authentication.ts";
import { AuthStatus } from "../../domain/organizations/setup.ts";
import { Authentication, type IssuedEmailOtp } from "../ports/authentication.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import { EmailSender } from "../ports/email-sender.ts";
import { enforceClientRateLimit, rateLimitedResponse } from "./client-rate-limit.ts";
import { currentSession, signedInAccount } from "./organization-access.ts";

const smallBodyLimit = ByteSize.kibibytes(8);
const webauthnBodyLimit = ByteSize.kibibytes(16);
const noStore = { headers: { "cache-control": "no-store" } };
const empty = (status: number) => Effect.succeed(HttpServerResponse.empty({ status, ...noStore }));
const otpErrorJson = HttpServerResponse.schemaJson(EmailOtpError);
const passkeyErrorJson = HttpServerResponse.schemaJson(PasskeyError);
const PasskeyPath = Schema.Struct({ id: PasskeyId });

const withCookie = (setCookie: string | null) =>
  setCookie === null
    ? noStore
    : { headers: { "cache-control": "no-store", "set-cookie": setCookie } };

const webRequest = Effect.gen(function* () {
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  return yield* HttpServerRequest.toWeb(incoming);
});

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      if (HttpServerError.isHttpServerError(error.error)) {
        return empty(
          error.error.reason._tag === "RequestParseError" &&
            error.error.reason.reason === "BodyTooLarge"
            ? 413
            : 400,
        );
      }
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        AuthUnavailable: () => empty(503),
        SetupClosed: () => empty(404),
        RecoveryClosed: () => empty(404),
        SetupRateLimited: () => empty(429),
        ClientRateLimited: () => rateLimitedResponse,
        InvalidSetup: () => empty(400),
        PasskeyInvalid: () =>
          passkeyErrorJson({ error: "challenge-invalid" }, { status: 400, ...noStore }),
        PasskeyExists: () =>
          passkeyErrorJson({ error: "passkey-exists" }, { status: 409, ...noStore }),
        PasskeyNotFound: () =>
          passkeyErrorJson({ error: "passkey-not-found" }, { status: 404, ...noStore }),
        LastPasskey: () => passkeyErrorJson({ error: "last-passkey" }, { status: 409, ...noStore }),
        OtpInvalid: () => otpErrorJson({ error: "otp-invalid" }, { status: 401, ...noStore }),
        EmailProviderMissing: () =>
          otpErrorJson({ error: "email-provider-missing" }, { status: 503, ...noStore }),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** Whether the first account can be created, and which sign-in / recovery methods are active. */
const authStatus = Effect.gen(function* () {
  const service = yield* Authentication;
  const status = yield* service.authStatus;
  return yield* HttpServerResponse.schemaJson(AuthStatus)(status, noStore);
});

const getSession = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* HttpServerResponse.schemaJson(SessionResponse)(session, noStore);
});

const signOut = Effect.gen(function* () {
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  // Enforce the body limit on POST requests before processing.
  yield* incoming.arrayBuffer;
  const service = yield* Authentication;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const clearedCookie = yield* service.signOut(request);
  return HttpServerResponse.empty({ status: 200, ...withCookie(clearedCookie) });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const setupOptions = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.verifyOrigin(request);
  const input = yield* HttpServerRequest.schemaBodyJson(SetupOptionsInput, {
    onExcessProperty: "error",
  });
  const options = yield* service.setupOptions(request, input);
  return yield* HttpServerResponse.schemaJson(PasskeyCreationOptions)(options, noStore);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const setupVerify = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.verifyOrigin(request);
  const input = yield* HttpServerRequest.schemaBodyJson(SetupVerifyInput, {
    onExcessProperty: "error",
  });
  const { session, setCookie } = yield* service.setupVerify(
    request,
    input.credential,
    input.passkeyName,
  );
  return yield* HttpServerResponse.schemaJson(AuthSession)(session, {
    status: 201,
    ...withCookie(setCookie),
  });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, webauthnBodyLimit));

const passkeySignInOptions = Effect.gen(function* () {
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  yield* incoming.arrayBuffer;
  const service = yield* Authentication;
  const request = yield* HttpServerRequest.toWeb(incoming);
  yield* service.verifyOrigin(request);
  yield* enforceClientRateLimit("passkey-options");
  const options = yield* service.passkeySignInOptions(request);
  return yield* HttpServerResponse.schemaJson(PasskeyRequestOptions)(options, noStore);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const passkeySignInVerify = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.verifyOrigin(request);
  yield* enforceClientRateLimit("passkey-verify");
  const input = yield* HttpServerRequest.schemaBodyJson(PasskeySignInVerifyInput, {
    onExcessProperty: "error",
  });
  const { session, setCookie } = yield* service
    .passkeySignInVerify(request, input.credential)
    .pipe(Effect.catchTag("PasskeyInvalid", () => Effect.fail("unauthorized" as const)));
  return yield* HttpServerResponse.schemaJson(AuthSession)(session, withCookie(setCookie));
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, webauthnBodyLimit),
  Effect.catchIf(
    (error): error is "unauthorized" => error === "unauthorized",
    () => empty(401),
  ),
);

const sendOtpEmail = Effect.fnUntraced(function* (
  issued: IssuedEmailOtp,
  language: typeof RequestEmailOtp.Type.language,
) {
  const recipients = parseEmailRecipients([issued.email]);
  if (Result.isFailure(recipients)) return;
  const email = yield* EmailSender;
  const from = yield* email.sender;
  const { subject, text } = emailOtpEmail(issued.code, language ?? defaultEmailLanguage);
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

const requestEmailOtp = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  // Check origin first so another site cannot consume a visitor's rate-limit quota.
  yield* service.verifyOrigin(request);
  yield* enforceClientRateLimit("otp-request");
  const input = yield* HttpServerRequest.schemaBodyJson(RequestEmailOtp, {
    onExcessProperty: "error",
  });
  const email = yield* EmailSender;
  // Without an email provider, Email OTP is disabled and returns 503.
  yield* email.sender;
  const issued = yield* service.issueEmailOtp(input.email);
  if (issued !== null) {
    const tasks = yield* BackgroundTasks;
    yield* tasks.run(
      sendOtpEmail(issued, input.language).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Sign-in OTP email failed", { tag: error._tag }),
        ),
        Effect.ignore,
      ),
    );
  }
  return HttpServerResponse.empty({ status: 202, ...noStore });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const verifyEmailOtp = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.verifyOrigin(request);
  yield* enforceClientRateLimit("otp-verify");
  const input = yield* HttpServerRequest.schemaBodyJson(VerifyEmailOtp, {
    onExcessProperty: "error",
  });
  const email = yield* EmailSender;
  yield* email.sender;
  const { session, setCookie } = yield* service.verifyEmailOtp(request, input.email, input.code);
  return yield* HttpServerResponse.schemaJson(AuthSession)(session, withCookie(setCookie));
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const recoveryOptions = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.verifyOrigin(request);
  const input = yield* HttpServerRequest.schemaBodyJson(RecoveryOptionsInput, {
    onExcessProperty: "error",
  });
  const options = yield* service.recoveryOptions(request, input.email);
  return yield* HttpServerResponse.schemaJson(PasskeyCreationOptions)(options, noStore);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const recoveryVerify = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.verifyOrigin(request);
  const input = yield* HttpServerRequest.schemaBodyJson(RecoveryVerifyInput, {
    onExcessProperty: "error",
  });
  const { session, setCookie } = yield* service.recoveryVerify(
    request,
    input.credential,
    input.passkeyName,
  );
  return yield* HttpServerResponse.schemaJson(AuthSession)(session, {
    status: 201,
    ...withCookie(setCookie),
  });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, webauthnBodyLimit));

const listAccountPasskeys = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const service = yield* Authentication;
  const email = yield* EmailSender;
  const request = yield* webRequest;
  const passkeys = yield* service.listPasskeys(request, userId);
  const emailOtpEnabled = yield* email.sender.pipe(
    Effect.as(true),
    Effect.catchTag("EmailProviderMissing", () => Effect.succeed(false)),
  );
  return yield* HttpServerResponse.schemaJson(AccountPasskeys)(
    { passkeys, emailOtpEnabled },
    noStore,
  );
});

const addAccountPasskeyOptions = Effect.gen(function* () {
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  yield* incoming.arrayBuffer;
  const userId = yield* signedInAccount();
  const service = yield* Authentication;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const options = yield* service.addPasskeyOptions(request, userId);
  return yield* HttpServerResponse.schemaJson(PasskeyCreationOptions)(options, noStore);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const addAccountPasskeyVerify = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const input = yield* HttpServerRequest.schemaBodyJson(AddPasskeyVerifyInput, {
    onExcessProperty: "error",
  });
  const service = yield* Authentication;
  const request = yield* webRequest;
  const created = yield* service.addPasskeyVerify(request, userId, input.credential, input.name);
  return yield* HttpServerResponse.schemaJson(PasskeySummary)(created, {
    status: 201,
    ...noStore,
  });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, webauthnBodyLimit));

const renameAccountPasskey = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const { id } = yield* HttpRouter.schemaPathParams(PasskeyPath);
  const input = yield* HttpServerRequest.schemaBodyJson(RenamePasskeyInput, {
    onExcessProperty: "error",
  });
  const service = yield* Authentication;
  const request = yield* webRequest;
  const updated = yield* service.renamePasskey(request, userId, id, input.name);
  return yield* HttpServerResponse.schemaJson(PasskeySummary)(updated, noStore);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, smallBodyLimit));

const deleteAccountPasskey = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const { id } = yield* HttpRouter.schemaPathParams(PasskeyPath);
  const email = yield* EmailSender;
  const emailOtpEnabled = yield* email.sender.pipe(
    Effect.as(true),
    Effect.catchTag("EmailProviderMissing", () => Effect.succeed(false)),
  );
  const service = yield* Authentication;
  const request = yield* webRequest;
  yield* service.deletePasskey(request, userId, id, emailOtpEnabled);
  return HttpServerResponse.empty({ status: 204, ...noStore });
});

export const authenticationRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/auth/status", withErrors(authStatus)),
  HttpRouter.add("GET", "/api/auth/get-session", withErrors(getSession)),
  HttpRouter.add("POST", "/api/auth/sign-out", withErrors(signOut)),
  HttpRouter.add("POST", "/api/setup/options", withErrors(setupOptions)),
  HttpRouter.add("POST", "/api/setup/verify", withErrors(setupVerify)),
  HttpRouter.add("POST", "/api/auth/passkey/options", withErrors(passkeySignInOptions)),
  HttpRouter.add("POST", "/api/auth/passkey/verify", withErrors(passkeySignInVerify)),
  HttpRouter.add("POST", "/api/auth/otp/request", withErrors(requestEmailOtp)),
  HttpRouter.add("POST", "/api/auth/otp/verify", withErrors(verifyEmailOtp)),
  HttpRouter.add("POST", "/api/auth/recovery/options", withErrors(recoveryOptions)),
  HttpRouter.add("POST", "/api/auth/recovery/verify", withErrors(recoveryVerify)),
  HttpRouter.add("GET", "/api/account/passkeys", withErrors(listAccountPasskeys)),
  HttpRouter.add("POST", "/api/account/passkeys/options", withErrors(addAccountPasskeyOptions)),
  HttpRouter.add("POST", "/api/account/passkeys/verify", withErrors(addAccountPasskeyVerify)),
  HttpRouter.add("PATCH", "/api/account/passkeys/:id", withErrors(renameAccountPasskey)),
  HttpRouter.add("DELETE", "/api/account/passkeys/:id", withErrors(deleteAccountPasskey)),
);
