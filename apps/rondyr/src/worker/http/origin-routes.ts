import { ByteSize, Effect, Layer, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  AddFormOrigin,
  FormOrigin,
  OriginRequestError,
  parseAllowedOrigin,
  type OriginRefusalReason,
} from "../../domain/forms/allowed-origin.ts";
import { OrganizationId } from "../../domain/submissions/submission.id.ts";
import { FormOrigins } from "../ports/form-origins.ts";
import { authorize } from "./organization-access.ts";

const FormPath = Schema.Struct({
  organizationId: OrganizationId,
  publicId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const RemoveParams = FormPath.mapFields((fields) => ({ ...fields, ...AddFormOrigin.fields }));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const originJson = HttpServerResponse.schemaJson(FormOrigin);
const errorJson = HttpServerResponse.schemaJson(OriginRequestError);

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
        FormOriginNotFound: () => empty(404),
        OriginInUse: () => errorJson({ error: "origin-in-use" }, { status: 409, ...jsonOptions }),
        SchemaError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** An admin of the organization and the form of the path. */
const scope = Effect.gen(function* () {
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  const { userId } = yield* authorize(organizationId, "manage-forms");
  return { userId, organizationId, formPublicId: publicId };
});

const refused = (reason: OriginRefusalReason) =>
  errorJson({ error: "origin-refused", reason }, { status: 400, ...jsonOptions });

const list = Effect.gen(function* () {
  const form = yield* scope;
  const origins = yield* FormOrigins;
  const found = yield* origins.list(form);
  return yield* HttpServerResponse.schemaJson(Schema.Array(FormOrigin))(found, jsonOptions);
});

const add = Effect.gen(function* () {
  const form = yield* scope;
  const input = yield* HttpServerRequest.schemaBodyJson(AddFormOrigin);
  const origin = parseAllowedOrigin(input.origin);
  if (Result.isFailure(origin)) return yield* refused(origin.failure);
  const origins = yield* FormOrigins;
  const added = yield* origins.add(form, origin.success);
  return yield* originJson(added.origin, { status: added.created ? 201 : 200, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const remove = Effect.gen(function* () {
  const form = yield* scope;
  const { origin: input } = yield* HttpRouter.schemaParams(RemoveParams);
  const origin = parseAllowedOrigin(input);
  if (Result.isFailure(origin)) return yield* refused(origin.failure);
  const origins = yield* FormOrigins;
  yield* origins.remove(form, origin.success);
  return HttpServerResponse.empty({ status: 204, ...jsonOptions });
});

const formOrigins = "/api/organizations/:organizationId/forms/:publicId/origins";

export const originRoutes = Layer.mergeAll(
  HttpRouter.add("GET", formOrigins, withErrors(list)),
  HttpRouter.add("POST", formOrigins, withErrors(add)),
  HttpRouter.add("DELETE", formOrigins, withErrors(remove)),
);
