import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  DomainRequestError,
  OrganizationDomainInput,
  OrganizationDomainList,
} from "../domain/organizations/organization-domain.ts";
import { OrganizationId } from "../domain/submissions/submission.id.ts";
import {
  OrganizationDirectory,
  OrganizationDomainNotFound,
} from "../ports/organization-directory.ts";
import { reviewer } from "./review-routes.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const RemoveParams = OrganizationPath.mapFields((fields) => ({
  ...fields,
  ...OrganizationDomainInput.fields,
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const domainJson = HttpServerResponse.schemaJson(OrganizationDomainInput);
const domainsJson = HttpServerResponse.schemaJson(OrganizationDomainList);
const errorJson = HttpServerResponse.schemaJson(DomainRequestError);

const empty = (status: number) =>
  Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));
const invalidDomain = () => errorJson({ error: "invalid-domain" }, { status: 400, ...jsonOptions });

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        OrganizationDomainNotFound: () => empty(404),
        OrganizationDomainLimit: () =>
          errorJson({ error: "domain-limit" }, { status: 409, ...jsonOptions }),
        SchemaError: invalidDomain,
        HttpServerError: invalidDomain,
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

const scope = Effect.gen(function* () {
  const { userId, organizations } = yield* reviewer();
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  if (!organizations.some(({ id }) => id === organizationId)) {
    return yield* OrganizationDomainNotFound.make();
  }
  return { userId, organizationId };
});

const list = Effect.gen(function* () {
  const organization = yield* scope;
  const directory = yield* OrganizationDirectory;
  const domains = yield* directory.listDomains(organization);
  return yield* domainsJson(domains, jsonOptions);
});

const add = Effect.gen(function* () {
  const organization = yield* scope;
  const { domain } = yield* HttpServerRequest.schemaBodyJson(OrganizationDomainInput);
  const directory = yield* OrganizationDirectory;
  const created = yield* directory.addDomain(organization, domain);
  return yield* domainJson({ domain }, { status: created ? 201 : 200, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const remove = Effect.gen(function* () {
  const organization = yield* scope;
  const { domain } = yield* HttpRouter.schemaParams(RemoveParams);
  const directory = yield* OrganizationDirectory;
  yield* directory.removeDomain(organization, domain);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const organizationDomains = "/api/organizations/:organizationId/domains";

export const organizationDomainRoutes = Layer.mergeAll(
  HttpRouter.add("GET", organizationDomains, withErrors(list)),
  HttpRouter.add("POST", organizationDomains, withErrors(add)),
  HttpRouter.add("DELETE", organizationDomains, withErrors(remove)),
);
