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
} from "../domain/deliveries/recipient-confirmation.ts";
import { RecipientConfirmations } from "../ports/recipient-confirmations.ts";

const jsonOptions = { headers: { "cache-control": "no-store" } };
const errorJson = HttpServerResponse.schemaJson(ConfirmationRequestError);

/**
 * Confirm a recipient with the secret of its link, from the public page of
 * the dashboard. Nobody needs to be signed in. The answer names neither the
 * organization nor the form.
 */
const confirm = Effect.gen(function* () {
  const { token } = yield* HttpServerRequest.schemaBodyJson(ConfirmRecipient);
  const confirmations = yield* RecipientConfirmations;
  yield* confirmations.confirm(token);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
  Effect.catchTags({
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
