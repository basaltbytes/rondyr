import { ByteSize, Effect, Layer } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { SetupStatus } from "../../domain/organizations/setup.ts";
import { Authentication } from "../ports/authentication.ts";

const authMaxBodySize = ByteSize.kibibytes(8);
const noStore = { headers: { "cache-control": "no-store" } };
const empty = (status: number) => Effect.succeed(HttpServerResponse.empty({ status, ...noStore }));

/**
 * Convert the incoming request into a Web `Request` whose body has been read
 * up to `MaxBodySize`. On Cloudflare Workers `HttpServerRequest.toWeb` hands
 * back the original Web `Request` directly without applying `MaxBodySize`, so
 * POST routes bound the body through `incoming.arrayBuffer` first.
 */
const limitedWebRequest = Effect.fnUntraced(function* () {
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const web = yield* HttpServerRequest.toWeb(incoming);
  if (incoming.method === "GET" || incoming.method === "HEAD") return web;
  const body = yield* incoming.arrayBuffer;
  const init: RequestInit = { method: web.method, headers: web.headers };
  if (body.byteLength > 0) init.body = body;
  return new Request(web.url, init);
});

const handle = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* limitedWebRequest();
  const response = yield* service.handle(request);
  return HttpServerResponse.fromWeb(response);
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, authMaxBodySize),
  Effect.catchTags({
    AuthOriginRefused: () => empty(403),
    AuthUnavailable: () => empty(503),
    HttpServerError: ({ reason }) =>
      empty(reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge" ? 413 : 400),
  }),
);

const setup = Effect.gen(function* () {
  const service = yield* Authentication;
  const request = yield* limitedWebRequest();
  yield* service.setup(request);
  return HttpServerResponse.empty({ status: 201, ...noStore });
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, authMaxBodySize),
  Effect.catchTags({
    AuthOriginRefused: () => empty(403),
    AuthUnavailable: () => empty(503),
    InvalidSetup: () => empty(400),
    SetupClosed: () => empty(404),
    SetupRateLimited: () => empty(429),
    HttpServerError: ({ reason }) =>
      empty(reason._tag === "RequestParseError" && reason.reason === "BodyTooLarge" ? 413 : 400),
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
