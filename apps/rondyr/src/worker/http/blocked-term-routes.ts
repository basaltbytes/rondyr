import { ByteSize, Effect, Layer, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  AddFormBlockedTerm,
  BlockedTermRequestError,
  FormBlockedTerm,
  parseBlockedTerm,
  type BlockedTermRefusalReason,
} from "../../domain/forms/blocked-term.ts";
import { OrganizationId } from "../../domain/submissions/submission.id.ts";
import { FormBlockedTerms } from "../ports/form-blocked-terms.ts";
import { authorize } from "./organization-access.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const FormPath = Schema.Struct({
  organizationId: OrganizationId,
  publicId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const RemoveFormParams = FormPath.mapFields((fields) => ({
  ...fields,
  ...AddFormBlockedTerm.fields,
}));
const RemoveOrganizationParams = OrganizationPath.mapFields((fields) => ({
  ...fields,
  ...AddFormBlockedTerm.fields,
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const termJson = HttpServerResponse.schemaJson(FormBlockedTerm);
const termsJson = HttpServerResponse.schemaJson(Schema.Array(FormBlockedTerm));
const errorJson = HttpServerResponse.schemaJson(BlockedTermRequestError);

function empty(status: number) {
  return Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));
}

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        PermissionDenied: () => empty(403),
        OrganizationNotFound: () => empty(404),
        FormBlockedTermNotFound: () => empty(404),
        FormBlockedTermLimit: () =>
          errorJson({ error: "term-limit" }, { status: 409, ...jsonOptions }),
        SchemaError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** An admin of the organization and the form of the path. */
const formScope = Effect.gen(function* () {
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  const { userId } = yield* authorize(organizationId, "manage-forms");
  return { userId, organizationId, formPublicId: publicId };
});

/** An admin of the organization of the path. */
const organizationScope = Effect.gen(function* () {
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const { userId } = yield* authorize(organizationId, "manage-settings");
  return { userId, organizationId };
});

const refused = (reason: BlockedTermRefusalReason) =>
  errorJson({ error: "term-refused", reason }, { status: 400, ...jsonOptions });

const listForm = Effect.gen(function* () {
  const form = yield* formScope;
  const blockedTerms = yield* FormBlockedTerms;
  const found = yield* blockedTerms.list(form);
  return yield* termsJson(found, jsonOptions);
});

const addForm = Effect.gen(function* () {
  const form = yield* formScope;
  const input = yield* HttpServerRequest.schemaBodyJson(AddFormBlockedTerm);
  const term = parseBlockedTerm(input.term);
  if (Result.isFailure(term)) return yield* refused(term.failure);
  const blockedTerms = yield* FormBlockedTerms;
  const added = yield* blockedTerms.add(form, term.success);
  return yield* termJson(added.term, { status: added.created ? 201 : 200, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const removeForm = Effect.gen(function* () {
  const form = yield* formScope;
  const { term: input } = yield* HttpRouter.schemaParams(RemoveFormParams);
  const term = parseBlockedTerm(input);
  if (Result.isFailure(term)) return yield* refused(term.failure);
  const blockedTerms = yield* FormBlockedTerms;
  yield* blockedTerms.remove(form, term.success);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const listOrganization = Effect.gen(function* () {
  const organization = yield* organizationScope;
  const blockedTerms = yield* FormBlockedTerms;
  const found = yield* blockedTerms.listForOrganization(organization);
  return yield* termsJson(found, jsonOptions);
});

const addOrganization = Effect.gen(function* () {
  const organization = yield* organizationScope;
  const input = yield* HttpServerRequest.schemaBodyJson(AddFormBlockedTerm);
  const term = parseBlockedTerm(input.term);
  if (Result.isFailure(term)) return yield* refused(term.failure);
  const blockedTerms = yield* FormBlockedTerms;
  const added = yield* blockedTerms.addForOrganization(organization, term.success);
  return yield* termJson(added.term, { status: added.created ? 201 : 200, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const removeOrganization = Effect.gen(function* () {
  const organization = yield* organizationScope;
  const { term: input } = yield* HttpRouter.schemaParams(RemoveOrganizationParams);
  const term = parseBlockedTerm(input);
  if (Result.isFailure(term)) return yield* refused(term.failure);
  const blockedTerms = yield* FormBlockedTerms;
  yield* blockedTerms.removeForOrganization(organization, term.success);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const formBlockedTerms = "/api/organizations/:organizationId/forms/:publicId/blocked-terms";
const organizationBlockedTerms = "/api/organizations/:organizationId/blocked-terms";

export const blockedTermRoutes = Layer.mergeAll(
  HttpRouter.add("GET", formBlockedTerms, withErrors(listForm)),
  HttpRouter.add("POST", formBlockedTerms, withErrors(addForm)),
  HttpRouter.add("DELETE", formBlockedTerms, withErrors(removeForm)),
  HttpRouter.add("GET", organizationBlockedTerms, withErrors(listOrganization)),
  HttpRouter.add("POST", organizationBlockedTerms, withErrors(addOrganization)),
  HttpRouter.add("DELETE", organizationBlockedTerms, withErrors(removeOrganization)),
);
