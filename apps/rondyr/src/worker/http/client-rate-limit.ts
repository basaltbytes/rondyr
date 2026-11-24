import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { ClientRateLimit } from "../ports/client-rate-limit.ts";

export class ClientRateLimited extends Schema.TaggedError<
  ClientRateLimited,
  { readonly brand: unique symbol }
>()("ClientRateLimited", {}) {}

export const rateLimitedResponse = Effect.succeed(
  HttpServerResponse.empty({
    status: 429,
    headers: { "cache-control": "no-store", "retry-after": "60" },
  }),
);

/**
 * Count one request from `CF-Connecting-IP` under `scope`, failing with
 * `ClientRateLimited` when the client is over its limit. Requests without
 * `CF-Connecting-IP` (local development and tests without a client address) pass.
 */
export const enforceClientRateLimit = Effect.fn("Http.enforceClientRateLimit")(function* (
  scope: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = request.headers["cf-connecting-ip"];
  if (address === undefined || address === "") return;
  const limit = yield* ClientRateLimit;
  if (!(yield* limit.admit(scope, address))) return yield* ClientRateLimited.make();
});
