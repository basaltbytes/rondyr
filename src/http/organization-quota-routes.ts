import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { DailyQuotas, DailyUsage } from "../domain/organizations/organization-quotas.ts";
import { OrganizationId } from "../domain/submissions/submission.id.ts";
import { OrganizationQuotas } from "../ports/organization-quotas.ts";
import { reviewer } from "./review-routes.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const responseOptions = { headers: { "cache-control": "no-store" } };
const usageJson = HttpServerResponse.schemaJson(DailyUsage);
const empty = (status: number) =>
  Effect.succeed(HttpServerResponse.empty({ status, ...responseOptions }));

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        OrganizationQuotasNotFound: () => empty(404),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

const scope = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  return { userId, organizationId };
});

const get = Effect.gen(function* () {
  const organization = yield* scope;
  const quotas = yield* OrganizationQuotas;
  const usage = yield* quotas.usage(organization);
  return yield* usageJson(usage, responseOptions);
});

const put = Effect.gen(function* () {
  const organization = yield* scope;
  const limits = yield* HttpServerRequest.schemaBodyJson(DailyQuotas, {
    onExcessProperty: "error",
  });
  const quotas = yield* OrganizationQuotas;
  const usage = yield* quotas.save(organization, limits);
  return yield* usageJson(usage, responseOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const path = "/api/organizations/:organizationId/quotas";
export const organizationQuotaRoutes = Layer.mergeAll(
  HttpRouter.add("GET", path, withErrors(get)),
  HttpRouter.add("PUT", path, withErrors(put)),
);
