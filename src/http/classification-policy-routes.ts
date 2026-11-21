import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  OrganizationClassificationPolicy,
  OrganizationClassificationSettings,
} from "../domain/organizations/organization-classification-policy.ts";
import { OrganizationId } from "../domain/submissions/submission.id.ts";
import {
  ClassificationPolicies,
  ClassificationPolicyNotFound,
} from "../ports/classification-policies.ts";
import { reviewer } from "./review-routes.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const responseOptions = { headers: { "cache-control": "no-store" } };
const settingsJson = HttpServerResponse.schemaJson(OrganizationClassificationSettings);
const readOverride = HttpServerRequest.schemaBodyJson(OrganizationClassificationPolicy, {
  onExcessProperty: "error",
});
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
        ClassificationPolicyNotFound: () => empty(404),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

const scope = Effect.gen(function* () {
  const { userId, organizations } = yield* reviewer();
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  if (!organizations.some(({ id }) => id === organizationId)) {
    return yield* ClassificationPolicyNotFound.make();
  }
  return { userId, organizationId };
});

const get = Effect.gen(function* () {
  const organization = yield* scope;
  const policies = yield* ClassificationPolicies;
  const settings = yield* policies.settings(organization);
  return yield* settingsJson(settings, responseOptions);
});

const put = Effect.gen(function* () {
  const organization = yield* scope;
  const override = yield* readOverride;
  const policies = yield* ClassificationPolicies;
  yield* policies.save(organization, override);
  return HttpServerResponse.empty({ status: 204, ...responseOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const reset = Effect.gen(function* () {
  const organization = yield* scope;
  const policies = yield* ClassificationPolicies;
  yield* policies.save(organization, null);
  return HttpServerResponse.empty({ status: 204, ...responseOptions });
});

const path = "/api/organizations/:organizationId/classification-policy";

export const classificationPolicyRoutes = Layer.mergeAll(
  HttpRouter.add("GET", path, withErrors(get)),
  HttpRouter.add("PUT", path, withErrors(put)),
  HttpRouter.add("DELETE", path, withErrors(reset)),
);
