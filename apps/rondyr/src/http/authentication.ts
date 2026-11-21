import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { SetupStatus } from "../domain/organizations/setup.ts";
import { Authentication } from "../ports/authentication.ts";

const handle = Effect.gen(function* () {
  const service = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const response = yield* service.handle(request);
  return HttpServerResponse.fromWeb(response);
}).pipe(
  Effect.catchTags({
    AuthOriginRefused: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    AuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
  }),
);

const setup = Effect.gen(function* () {
  const service = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  yield* service.setup(request);
  return HttpServerResponse.empty({ status: 201, headers: { "cache-control": "no-store" } });
}).pipe(
  Effect.catchTags({
    AuthOriginRefused: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
    AuthUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    InvalidSetup: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    SetupClosed: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
    SetupRateLimited: () => Effect.succeed(HttpServerResponse.empty({ status: 429 })),
  }),
);

/** Whether the first account can be created. The dashboard shows its setup page from it. */
const setupStatus = Effect.gen(function* () {
  const service = yield* Authentication;
  const state = yield* service.setupState;
  return yield* HttpServerResponse.schemaJson(SetupStatus)(
    { state },
    { headers: { "cache-control": "no-store" } },
  );
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })));

export const authenticationRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/auth/get-session", handle),
  HttpRouter.add("POST", "/api/auth/sign-in/email", handle),
  HttpRouter.add("POST", "/api/auth/sign-out", handle),
  HttpRouter.add("GET", "/api/setup", setupStatus),
  HttpRouter.add("POST", "/api/setup", setup),
);
