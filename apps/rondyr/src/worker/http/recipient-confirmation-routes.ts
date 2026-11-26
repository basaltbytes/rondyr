import { ByteSize, Effect } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  ConfirmationRequestError,
  ConfirmRecipient,
} from "../../domain/deliveries/recipient-confirmation.ts";
import { Authentication } from "../ports/authentication.ts";
import { RecipientConfirmations } from "../ports/recipient-confirmations.ts";
import { enforceClientRateLimit, rateLimitedResponse } from "./client-rate-limit.ts";

const jsonOptions = { headers: { "cache-control": "no-store" } };
const errorJson = HttpServerResponse.schemaJson(ConfirmationRequestError);

/** Refuse a request from another site: Authentication checks its origin. */
const sameOrigin = Effect.gen(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  yield* auth.verifyOrigin(request);
});

/**
 * Confirm a recipient with the secret of its link, from the public page of
 * the dashboard. Nobody needs to be signed in. The answer names neither the
 * organization nor the form.
 */
const confirm = Effect.gen(function* () {
  // The origin first, so that another site cannot use up a visitor's quota.
  yield* sameOrigin;
  yield* enforceClientRateLimit("recipient-confirmation");
  const { token } = yield* HttpServerRequest.schemaBodyJson(ConfirmRecipient);
  const confirmations = yield* RecipientConfirmations;
  yield* confirmations.confirm(token);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
  Effect.catchTags({
    AuthOriginRefused: () =>
      Effect.succeed(HttpServerResponse.empty({ status: 403, ...jsonOptions })),
    ClientRateLimited: () => rateLimitedResponse,
    ConfirmationNotFound: () =>
      errorJson({ error: "confirmation-invalid" }, { status: 404, ...jsonOptions }),
    SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400, ...jsonOptions })),
    HttpServerError: () =>
      Effect.succeed(HttpServerResponse.empty({ status: 400, ...jsonOptions })),
  }),
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503, ...jsonOptions })),
);

export const recipientConfirmationRoutes = HttpRouter.add(
  "POST",
  "/api/recipient-confirmations",
  confirm,
);
