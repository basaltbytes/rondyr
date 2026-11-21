import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { ApiTokenInput, ApiTokenList, CreatedApiToken } from "../domain/organizations/api-token.ts";
import { ApiTokenId, OrganizationId } from "../domain/submissions/submission.id.ts";
import { ApiTokens } from "../ports/api-tokens.ts";
import { reviewer } from "./review-routes.ts";

const path = "/api/organizations/:organizationId/api-tokens";
const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const RevokeParams = Schema.Struct({ ...OrganizationPath.fields, id: ApiTokenId });
const jsonOptions = { headers: { "cache-control": "no-store" } };
const empty = (status: number) => HttpServerResponse.empty({ status, ...jsonOptions });

const withErrors = <E, R>(route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  route.pipe(
    Effect.catchTags({
      ReviewUnauthorized: () => Effect.succeed(empty(401)),
      AuthOriginRefused: () => Effect.succeed(empty(403)),
      ApiTokenNotFound: () => Effect.succeed(empty(404)),
      ApiTokenLimit: () => Effect.succeed(empty(409)),
      SchemaError: () => Effect.succeed(empty(400)),
      HttpServerError: () => Effect.succeed(empty(400)),
    }),
    Effect.orElseSucceed(() => empty(503)),
  );

const list = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const tokens = yield* ApiTokens;
  const entries = yield* tokens.list({ userId, organizationId });
  return yield* HttpServerResponse.schemaJson(ApiTokenList)(entries, jsonOptions);
});

const create = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const input = yield* HttpServerRequest.schemaBodyJson(ApiTokenInput);
  const tokens = yield* ApiTokens;
  const created = yield* tokens.create({ userId, organizationId }, input);
  return yield* HttpServerResponse.schemaJson(CreatedApiToken)(created, {
    status: 201,
    ...jsonOptions,
  });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const revoke = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const { organizationId, id } = yield* HttpRouter.schemaParams(RevokeParams);
  const tokens = yield* ApiTokens;
  yield* tokens.revoke({ userId, organizationId }, id);
  return empty(204);
});

export const apiTokenRoutes = Layer.mergeAll(
  HttpRouter.add("GET", path, withErrors(list)),
  HttpRouter.add("POST", path, withErrors(create)),
  HttpRouter.add("DELETE", path, withErrors(revoke)),
);
