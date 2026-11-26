import { ByteSize, Effect, Layer } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { PasskeyCreationOptions } from "../../domain/organizations/authentication.ts";
import {
  AcceptedInvitation,
  AcceptInvitation,
  InvitationOptionsInput,
  InvitationRequestError,
  InvitationSummary,
  InvitationVerifyInput,
  ReadInvitation,
} from "../../domain/organizations/members.ts";
import { Authentication } from "../ports/authentication.ts";
import { Members } from "../ports/members.ts";
import { enforceClientRateLimit, rateLimitedResponse } from "./client-rate-limit.ts";
import { currentSession } from "./organization-access.ts";

const jsonOptions = { headers: { "cache-control": "no-store" } };
const errorJson = HttpServerResponse.schemaJson(InvitationRequestError);
const acceptedJson = HttpServerResponse.schemaJson(AcceptedInvitation);
const empty = (status: number) =>
  Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));
const refused = (error: typeof InvitationRequestError.Type, status: number) =>
  errorJson(error, { status, ...jsonOptions });

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
        AuthOriginRefused: () => empty(403),
        ClientRateLimited: () => rateLimitedResponse,
        InvitationNotFound: () => refused({ error: "invitation-invalid" }, 404),
        InvitationNeedsSignIn: () => refused({ error: "sign-in-required" }, 409),
        InvitationForOtherAccount: () => refused({ error: "other-account" }, 403),
        PasskeyInvalid: () => refused({ error: "passkey-invalid" }, 400),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/**
 * The signed-in account, or null. Authentication refuses a request from another
 * origin, with or without a session, so another site cannot accept for a visitor.
 */
const currentAccount = Effect.map(currentSession(), (session) => session?.user.id ?? null);

const sameOriginRequest = Effect.gen(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  yield* auth.verifyOrigin(request);
  return request;
});

/**
 * The link's secret travels in the body, never in a URL that a log would keep.
 * The origin is checked before the client is counted, so that another site
 * cannot use up a visitor's quota.
 */
const read = Effect.gen(function* () {
  yield* currentAccount;
  yield* enforceClientRateLimit("invitation-read");
  const { token } = yield* HttpServerRequest.schemaBodyJson(ReadInvitation);
  const members = yield* Members;
  const summary = yield* members.readInvitation(token);
  return yield* HttpServerResponse.schemaJson(InvitationSummary)(summary, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

/** Accept an invitation as the signed-in account matching the invited email. */
const accept = Effect.gen(function* () {
  const account = yield* currentAccount;
  yield* enforceClientRateLimit("invitation-accept");
  const input = yield* HttpServerRequest.schemaBodyJson(AcceptInvitation, {
    onExcessProperty: "error",
  });
  const members = yield* Members;
  if (account !== null) {
    const organizationId = yield* members.acceptAsAccount(input.token, account);
    return yield* acceptedJson({ organizationId }, jsonOptions);
  }
  const summary = yield* members.readInvitation(input.token);
  return yield* summary.account === "existing"
    ? refused({ error: "sign-in-required" }, 409)
    : refused({ error: "account-required" }, 400);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

/** Step 1 for a new account: validate the invitation and issue passkey creation options. */
const options = Effect.gen(function* () {
  const request = yield* sameOriginRequest;
  yield* enforceClientRateLimit("invitation-accept");
  const input = yield* HttpServerRequest.schemaBodyJson(InvitationOptionsInput, {
    onExcessProperty: "error",
  });
  const members = yield* Members;
  const summary = yield* members.readInvitation(input.token);
  if (summary.account === "existing") return yield* refused({ error: "sign-in-required" }, 409);
  const auth = yield* Authentication;
  const creationOptions = yield* auth.invitationOptions(request, {
    token: input.token,
    name: input.name,
    email: summary.email,
  });
  return yield* HttpServerResponse.schemaJson(PasskeyCreationOptions)(creationOptions, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

/**
 * Step 2 for a new account: verify the passkey attestation and atomically create the user,
 * passkey, membership, and session, returning the session cookie immediately.
 */
const verify = Effect.gen(function* () {
  const request = yield* sameOriginRequest;
  yield* enforceClientRateLimit("invitation-accept");
  const input = yield* HttpServerRequest.schemaBodyJson(InvitationVerifyInput, {
    onExcessProperty: "error",
  });
  const auth = yield* Authentication;
  const verified = yield* auth.invitationVerify(
    request,
    input.token,
    input.credential,
    input.passkeyName,
  );
  const members = yield* Members;
  const organizationId = yield* members.acceptWithPasskey(input.token, {
    userId: verified.userId,
    name: verified.name,
    passkey: verified.passkey,
    session: verified.session,
  });
  return yield* acceptedJson(
    { organizationId },
    {
      status: 201,
      headers: { "cache-control": "no-store", "set-cookie": verified.setCookie },
    },
  );
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(16)));

export const invitationRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/api/invitations/read", withErrors(read)),
  HttpRouter.add("POST", "/api/invitations/accept", withErrors(accept)),
  HttpRouter.add("POST", "/api/invitations/options", withErrors(options)),
  HttpRouter.add("POST", "/api/invitations/verify", withErrors(verify)),
);
