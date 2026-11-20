import { ByteSize, Effect, Layer, Option, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { TargetId } from "../domain/deliveries/delivery.ts";
import { parseWebhookUrl } from "../domain/deliveries/webhook-destination.ts";
import {
  CreateWebhookTarget,
  IssuedWebhookSecret,
  TargetRequestError,
  WebhookTarget,
} from "../domain/deliveries/webhook.ts";
import { OrganizationId } from "../domain/submissions/submission.id.ts";
import { NotificationTargets, TargetStatus } from "../ports/notification-targets.ts";
import { reviewer } from "./review-routes.ts";

const FormPath = Schema.Struct({
  organizationId: OrganizationId,
  publicId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const TargetPath = Schema.Struct({ organizationId: OrganizationId, targetId: TargetId });
const StatusPath = TargetPath.mapFields((fields) => ({
  ...fields,
  action: Schema.Literals(["activate", "deactivate"]),
}));

// A response that contains a secret must never be cached.
const jsonOptions = { headers: { "cache-control": "no-store" } };
const targetJson = HttpServerResponse.schemaJson(WebhookTarget);
const issuedJson = HttpServerResponse.schemaJson(IssuedWebhookSecret);
const errorJson = HttpServerResponse.schemaJson(TargetRequestError);

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
        TargetNotFound: () => empty(404),
        TargetChanged: () => empty(409),
        SchemaError: () => empty(400),
        SecretsKeyMissing: () =>
          errorJson({ error: "secrets-key-missing" }, { status: 503, ...jsonOptions }),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

const account = Effect.map(reviewer(), ({ userId }) => userId);

const list = Effect.gen(function* () {
  const userId = yield* account;
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  const targets = yield* NotificationTargets;
  const found = yield* targets.list({ userId, organizationId, formPublicId: publicId });
  return yield* HttpServerResponse.schemaJson(Schema.Array(WebhookTarget))(found, jsonOptions);
});

const create = Effect.gen(function* () {
  const userId = yield* account;
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  const input = yield* HttpServerRequest.schemaBodyJson(CreateWebhookTarget);
  // Authentication refuses a request whose origin is not the Worker's, so this is the Worker's origin.
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const url = parseWebhookUrl(input.url, Option.some(new URL(request.url).origin));
  if (Result.isFailure(url)) {
    return yield* errorJson(
      { error: "destination-refused", reason: url.failure },
      { status: 400, ...jsonOptions },
    );
  }
  const targets = yield* NotificationTargets;
  const issued = yield* targets.createWebhook(
    { userId, organizationId, formPublicId: publicId },
    url.success,
  );
  return yield* issuedJson(issued, { status: 201, ...jsonOptions });
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const rotate = Effect.gen(function* () {
  const userId = yield* account;
  const { organizationId, targetId } = yield* HttpRouter.schemaPathParams(TargetPath);
  const targets = yield* NotificationTargets;
  const issued = yield* targets.rotateSecret({ userId, organizationId, targetId });
  return yield* issuedJson(issued, jsonOptions);
});

const setStatus = Effect.gen(function* () {
  const userId = yield* account;
  const { action, organizationId, targetId } = yield* HttpRouter.schemaPathParams(StatusPath);
  const targets = yield* NotificationTargets;
  const status: typeof TargetStatus.Type = action === "activate" ? "active" : "inactive";
  const target = yield* targets.setStatus({ userId, organizationId, targetId }, status);
  return yield* targetJson(target, jsonOptions);
});

const formTargets = "/api/organizations/:organizationId/forms/:publicId/targets";
const target = "/api/organizations/:organizationId/targets/:targetId";

export const targetRoutes = Layer.mergeAll(
  HttpRouter.add("GET", formTargets, withErrors(list)),
  HttpRouter.add("POST", formTargets, withErrors(create)),
  HttpRouter.add("POST", `${target}/rotate-secret`, withErrors(rotate)),
  HttpRouter.add("POST", `${target}/:action`, withErrors(setStatus)),
);
