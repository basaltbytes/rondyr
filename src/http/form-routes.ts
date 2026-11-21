import { ByteSize, Effect, Layer, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  CreateForm,
  FormRequestError,
  ManagedForm,
  parseSuccessUrl,
  SetHoneypotField,
  SetSuccessUrl,
  UpdateForm,
  type FormStatus,
  type SuccessUrlRefusalReason,
} from "../domain/forms/form.ts";
import { SetTurnstile } from "../domain/forms/turnstile.ts";
import { OrganizationId } from "../domain/submissions/submission.id.ts";
import { Forms } from "../ports/forms.ts";
import { reviewer } from "./review-routes.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const FormPath = OrganizationPath.mapFields((fields) => ({
  ...fields,
  publicId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const formJson = HttpServerResponse.schemaJson(ManagedForm);
const errorJson = HttpServerResponse.schemaJson(FormRequestError);

function empty(status: number) {
  return Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));
}

const refused = (reason: SuccessUrlRefusalReason) =>
  errorJson({ error: "success-url-refused", reason }, { status: 400, ...jsonOptions });

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        OrganizationFormNotFound: () => empty(404),
        SuccessOriginNotListed: () => refused("origin-not-listed"),
        SecretsKeyMissing: () =>
          errorJson({ error: "secrets-key-missing" }, { status: 503, ...jsonOptions }),
        SchemaError: () => empty(400),
        HttpServerError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** The signed-in account and the form of the path. */
const scope = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  return { userId, organizationId, formPublicId: publicId };
});

const create = Effect.gen(function* () {
  const { userId } = yield* reviewer();
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const input = yield* HttpServerRequest.schemaBodyJson(CreateForm);
  const forms = yield* Forms;
  const created = yield* forms.create({ userId, organizationId }, input);
  return yield* formJson(created, { status: 201, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const update = Effect.gen(function* () {
  const form = yield* scope;
  const changes = yield* HttpServerRequest.schemaBodyJson(UpdateForm);
  const forms = yield* Forms;
  const updated = yield* forms.update(form, changes);
  return yield* formJson(updated, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const setStatus = (status: FormStatus) =>
  Effect.gen(function* () {
    const form = yield* scope;
    const forms = yield* Forms;
    const updated = yield* forms.setStatus(form, status);
    return yield* formJson(updated, jsonOptions);
  });

const setSuccessUrl = Effect.gen(function* () {
  const form = yield* scope;
  const input = yield* HttpServerRequest.schemaBodyJson(SetSuccessUrl);
  const url = parseSuccessUrl(input.url);
  if (Result.isFailure(url)) return yield* refused(url.failure);
  const forms = yield* Forms;
  const updated = yield* forms.setSuccessUrl(form, url.success);
  return yield* formJson(updated, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const clearSuccessUrl = Effect.gen(function* () {
  const form = yield* scope;
  const forms = yield* Forms;
  const updated = yield* forms.clearSuccessUrl(form);
  return yield* formJson(updated, jsonOptions);
});

const setHoneypotField = Effect.gen(function* () {
  const form = yield* scope;
  const input = yield* HttpServerRequest.schemaBodyJson(SetHoneypotField);
  const forms = yield* Forms;
  const updated = yield* forms.setHoneypotField(form, input.field);
  return yield* formJson(updated, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const clearHoneypotField = Effect.gen(function* () {
  const form = yield* scope;
  const forms = yield* Forms;
  const updated = yield* forms.clearHoneypotField(form);
  return yield* formJson(updated, jsonOptions);
});

const setTurnstile = Effect.gen(function* () {
  const form = yield* scope;
  const settings = yield* HttpServerRequest.schemaBodyJson(SetTurnstile, {
    onExcessProperty: "error",
  });
  const forms = yield* Forms;
  const updated = yield* forms.setTurnstile(form, settings);
  return yield* formJson(updated, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const clearTurnstile = Effect.gen(function* () {
  const form = yield* scope;
  const forms = yield* Forms;
  const updated = yield* forms.setTurnstile(form, null);
  return yield* formJson(updated, jsonOptions);
});

const organizationForms = "/api/organizations/:organizationId/forms";
const form = `${organizationForms}/:publicId`;

export const formRoutes = Layer.mergeAll(
  HttpRouter.add("POST", organizationForms, withErrors(create)),
  HttpRouter.add("PATCH", form, withErrors(update)),
  HttpRouter.add("POST", `${form}/suspend`, withErrors(setStatus("suspended"))),
  HttpRouter.add("POST", `${form}/reactivate`, withErrors(setStatus("active"))),
  HttpRouter.add("PUT", `${form}/success-url`, withErrors(setSuccessUrl)),
  HttpRouter.add("DELETE", `${form}/success-url`, withErrors(clearSuccessUrl)),
  HttpRouter.add("PUT", `${form}/honeypot`, withErrors(setHoneypotField)),
  HttpRouter.add("DELETE", `${form}/honeypot`, withErrors(clearHoneypotField)),
  HttpRouter.add("PUT", `${form}/turnstile`, withErrors(setTurnstile)),
  HttpRouter.add("DELETE", `${form}/turnstile`, withErrors(clearTurnstile)),
);
