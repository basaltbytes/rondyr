import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  AcceptedInvitation,
  AcceptInvitation,
  InvitationRequestError,
  InvitationSummary,
  ReadInvitation,
} from "../../domain/organizations/members.ts";
import { UserId } from "../../domain/submissions/submission.id.ts";
import { Authentication } from "../ports/authentication.ts";
import { Members } from "../ports/members.ts";
import { enforceClientRateLimit, rateLimitedResponse } from "./client-rate-limit.ts";

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
      return Effect.catchTags(Effect.fail(error.error), {
        AuthOriginRefused: () => empty(403),
        ClientRateLimited: () => rateLimitedResponse,
        InvitationNotFound: () => refused({ error: "invitation-invalid" }, 404),
        InvitationNeedsSignIn: () => refused({ error: "sign-in-required" }, 409),
        InvitationForOtherAccount: () => refused({ error: "other-account" }, 403),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/**
 * The signed-in account, or null. Authentication refuses a request from another
 * origin, with or without a session, so another site cannot accept for a visitor.
 */
const currentAccount = Effect.gen(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const user = yield* auth.userId(request);
  return user === null ? null : yield* Schema.decodeEffect(UserId)(user);
});

/** The link's secret travels in the body, never in a URL that a log would keep. */
const read = Effect.gen(function* () {
  yield* enforceClientRateLimit("invitation-read");
  yield* currentAccount;
  const { token } = yield* HttpServerRequest.schemaBodyJson(ReadInvitation);
  const members = yield* Members;
  const summary = yield* members.readInvitation(token);
  return yield* HttpServerResponse.schemaJson(InvitationSummary)(summary, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

const accept = Effect.gen(function* () {
  yield* enforceClientRateLimit("invitation-accept");
  const account = yield* currentAccount;
  const input = yield* HttpServerRequest.schemaBodyJson(AcceptInvitation, {
    onExcessProperty: "error",
  });
  const members = yield* Members;
  if (account !== null) {
    const organizationId = yield* members.acceptAsAccount(input.token, account);
    return yield* acceptedJson({ organizationId }, jsonOptions);
  }
  if (input.name === undefined || input.password === undefined) {
    const summary = yield* members.readInvitation(input.token);
    return yield* summary.account === "existing"
      ? refused({ error: "sign-in-required" }, 409)
      : refused({ error: "account-required" }, 400);
  }
  const organizationId = yield* members.acceptWithNewAccount(input.token, {
    name: input.name,
    password: input.password,
  });
  return yield* acceptedJson({ organizationId }, { status: 201, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

export const invitationRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/api/invitations/read", withErrors(read)),
  HttpRouter.add("POST", "/api/invitations/accept", withErrors(accept)),
);
