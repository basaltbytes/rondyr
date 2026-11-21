import { Context, Effect, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ApiTokens, type ApiTokenPrincipal } from "../ports/api-tokens.ts";

export const CurrentApiToken = Context.Reference<ApiTokenPrincipal | null>(
  "rondyr/http/CurrentApiToken",
  { defaultValue: () => null },
);

export const organizationPath = "/api/organizations";
const inbox = `${organizationPath}/:organizationId`;
export const submissionsPath = `${inbox}/submissions`;

export const countsPath = `${inbox}/submission-counts`;

export const detailPath = `${submissionsPath}/:submissionId`;

export const decisionPath = `${detailPath}/:decision`;

/** The submission route. A `POST` with an `Authorization` header is a server intake. */
export const intakePath = "/f/:formId";

const tokenReads = new Set<string>([organizationPath, submissionsPath, countsPath, detailPath]);
const bearer = /^Bearer[ \t]+([^,]+)$/iu;
const apiCredential = /(?:^|,)[ \t]*Bearer[ \t]+rdr_/iu;

const empty = (status: number) =>
  HttpServerResponse.empty({ status, headers: { "cache-control": "no-store" } });

/**
 * Match against the registered route, which also covers newly added routes by default.
 * On `/api`, a request with an `rdr_` Bearer credential is authenticated by its
 * token. On the submission route, any `Authorization` header makes a server
 * intake, whatever its scheme or value: a header that is not the Bearer
 * credential of an active token gets `401` and never reaches the public path.
 * The route reads the token's organization from `CurrentApiToken`.
 */
export const apiTokenAuthentication = HttpRouter.middleware(
  Effect.gen(function* () {
    const tokens = yield* ApiTokens;
    return (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { route, params } = yield* HttpRouter.RouteContext;
        const authorization = request.headers.authorization;
        const intake = route.path === intakePath && request.method === "POST";
        const api = route.path === "/api" || route.path.startsWith("/api/");
        if (
          authorization === undefined ||
          !(intake || (api && apiCredential.test(authorization)))
        ) {
          return yield* handler;
        }

        const credential = bearer.exec(authorization)?.[1];
        if (credential === undefined) return empty(401);
        const principal = yield* tokens
          .verify(Redacted.make(credential))
          .pipe(
            Effect.catchTag("StorageUnavailable", () => Effect.succeed("unavailable" as const)),
          );
        if (principal === "unavailable") return empty(503);
        if (principal === null) return empty(401);
        if (intake) return yield* handler.pipe(Effect.provideService(CurrentApiToken, principal));

        const permitted =
          (request.method === "GET" && tokenReads.has(route.path)) ||
          (request.method === "POST" &&
            route.path === decisionPath &&
            (params.decision === "approve" || params.decision === "dismiss"));
        if (!permitted) return empty(403);
        return yield* handler.pipe(Effect.provideService(CurrentApiToken, principal));
      });
  }),
).layer;
