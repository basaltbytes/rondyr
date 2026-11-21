import { ByteSize, Clock, Effect, Layer, Option, Result, Schema } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { TargetId } from "../domain/deliveries/delivery.ts";
import {
  defaultEmailLanguage,
  EmailTarget,
  parseEmailRecipients,
  RecipientConfirmationStatus,
  ReplaceEmailRecipients,
  type CreateEmailTarget,
  type RecipientsRefusalReason,
} from "../domain/deliveries/email.ts";
import {
  CreateTarget,
  DestinationTarget,
  TargetRequestError,
} from "../domain/deliveries/targets.ts";
import {
  ConfirmationRequestError,
  ResendConfirmation,
} from "../domain/deliveries/recipient-confirmation.ts";
import { parseWebhookUrl } from "../domain/deliveries/webhook-destination.ts";
import { IssuedWebhookSecret, type CreateWebhookTarget } from "../domain/deliveries/webhook.ts";
import { OrganizationId } from "../domain/submissions/submission.id.ts";
import { requestConfirmations, resendConfirmation } from "../jobs/recipient-confirmations.ts";
import {
  NotificationTargets,
  TargetStatus,
  type FormScope,
} from "../ports/notification-targets.ts";
import { authorize } from "./organization-access.ts";

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
const targetJson = HttpServerResponse.schemaJson(DestinationTarget);
const emailTargetJson = HttpServerResponse.schemaJson(EmailTarget);
const issuedJson = HttpServerResponse.schemaJson(IssuedWebhookSecret);
const errorJson = HttpServerResponse.schemaJson(TargetRequestError);
const confirmationErrorJson = HttpServerResponse.schemaJson(ConfirmationRequestError);
const dayMillis = 86_400_000;

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
        TargetNotFound: () => empty(404),
        TargetChanged: () => empty(409),
        SchemaError: () => empty(400),
        SecretsKeyMissing: () =>
          errorJson({ error: "secrets-key-missing" }, { status: 503, ...jsonOptions }),
        EmailProviderMissing: () =>
          errorJson({ error: "email-provider-missing" }, { status: 503, ...jsonOptions }),
        RecipientNotFound: () => empty(404),
        RecipientConfirmed: () =>
          confirmationErrorJson({ error: "recipient-confirmed" }, { status: 409, ...jsonOptions }),
        ConfirmationLimit: () =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            confirmationErrorJson(
              { error: "confirmation-limit" },
              {
                status: 429,
                headers: {
                  ...jsonOptions.headers,
                  // The count of an address starts again at midnight UTC.
                  "retry-after": String(Math.ceil((dayMillis - (now % dayMillis)) / 1000)),
                },
              },
            ),
          ),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/** An admin of the organization of the path, who manages the destinations of its forms. */
const account = (organizationId: OrganizationId) =>
  Effect.map(authorize(organizationId, "manage-destinations"), ({ userId }) => userId);

const list = Effect.gen(function* () {
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  const userId = yield* account(organizationId);
  const targets = yield* NotificationTargets;
  const found = yield* targets.list({ userId, organizationId, formPublicId: publicId });
  return yield* HttpServerResponse.schemaJson(Schema.Array(DestinationTarget))(found, jsonOptions);
});

// Authentication refuses a request whose origin is not the Worker's, so this is the Worker's origin.
const workerOrigin = Effect.gen(function* () {
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  return new URL(request.url).origin;
});

/** Ask the new recipients to confirm. The destination is saved whatever happens to the emails. */
const askConfirmations = (organizationId: OrganizationId, target: typeof EmailTarget.Type) =>
  Effect.gen(function* () {
    const origin = yield* workerOrigin;
    const pending = target.recipientStatuses
      .filter(({ status }) => status === "pending")
      .map(({ address }) => address);
    yield* requestConfirmations(organizationId, pending, target.language, origin);
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Confirmation request failed", { tag: error._tag }),
    ),
    Effect.ignore,
  );

const createWebhook = Effect.fnUntraced(function* (
  form: FormScope,
  input: typeof CreateWebhookTarget.Type,
) {
  const origin = yield* workerOrigin;
  const url = parseWebhookUrl(input.url, Option.some(origin));
  if (Result.isFailure(url)) {
    return yield* errorJson(
      { error: "destination-refused", reason: url.failure },
      { status: 400, ...jsonOptions },
    );
  }
  const targets = yield* NotificationTargets;
  const issued = yield* targets.createWebhook(form, url.success);
  return yield* issuedJson(issued, { status: 201, ...jsonOptions });
});

function recipientsRefused(reason: RecipientsRefusalReason) {
  return errorJson({ error: "recipients-refused", reason }, { status: 400, ...jsonOptions });
}

const createEmail = Effect.fnUntraced(function* (
  form: FormScope,
  input: typeof CreateEmailTarget.Type,
) {
  const recipients = parseEmailRecipients(input.recipients);
  if (Result.isFailure(recipients)) return yield* recipientsRefused(recipients.failure);
  const targets = yield* NotificationTargets;
  const created = yield* targets.createEmail(
    form,
    recipients.success,
    input.language ?? defaultEmailLanguage,
  );
  yield* askConfirmations(form.organizationId, created);
  return yield* emailTargetJson(created, { status: 201, ...jsonOptions });
});

const create = Effect.gen(function* () {
  const { organizationId, publicId } = yield* HttpRouter.schemaPathParams(FormPath);
  const userId = yield* account(organizationId);
  const input = yield* HttpServerRequest.schemaBodyJson(CreateTarget);
  const form: FormScope = { userId, organizationId, formPublicId: publicId };
  return yield* input.type === "webhook" ? createWebhook(form, input) : createEmail(form, input);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const replaceRecipients = Effect.gen(function* () {
  const { organizationId, targetId } = yield* HttpRouter.schemaPathParams(TargetPath);
  const userId = yield* account(organizationId);
  const input = yield* HttpServerRequest.schemaBodyJson(ReplaceEmailRecipients);
  const recipients = parseEmailRecipients(input.recipients);
  if (Result.isFailure(recipients)) return yield* recipientsRefused(recipients.failure);
  const targets = yield* NotificationTargets;
  const target = yield* targets.replaceRecipients(
    { userId, organizationId, targetId },
    recipients.success,
    input.language,
  );
  yield* askConfirmations(organizationId, target);
  return yield* emailTargetJson(target, jsonOptions);
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(8)));

const rotate = Effect.gen(function* () {
  const { organizationId, targetId } = yield* HttpRouter.schemaPathParams(TargetPath);
  const userId = yield* account(organizationId);
  const targets = yield* NotificationTargets;
  const issued = yield* targets.rotateSecret({ userId, organizationId, targetId });
  return yield* issuedJson(issued, jsonOptions);
});

const setStatus = Effect.gen(function* () {
  const { action, organizationId, targetId } = yield* HttpRouter.schemaPathParams(StatusPath);
  const userId = yield* account(organizationId);
  const targets = yield* NotificationTargets;
  const status: typeof TargetStatus.Type = action === "activate" ? "active" : "inactive";
  const target = yield* targets.setStatus({ userId, organizationId, targetId }, status);
  return yield* targetJson(target, jsonOptions);
});

/** Send the confirmation email of a pending recipient again, with a new link. */
const resend = Effect.gen(function* () {
  const { organizationId, targetId } = yield* HttpRouter.schemaPathParams(TargetPath);
  const userId = yield* account(organizationId);
  const { address } = yield* HttpServerRequest.schemaBodyJson(ResendConfirmation);
  const origin = yield* workerOrigin;
  const sent = yield* resendConfirmation({ userId, organizationId, targetId }, address, origin);
  return yield* HttpServerResponse.schemaJson(RecipientConfirmationStatus)(
    { address: sent, status: "pending" },
    { status: 202, ...jsonOptions },
  );
}).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)));

const formTargets = "/api/organizations/:organizationId/forms/:publicId/targets";
const target = "/api/organizations/:organizationId/targets/:targetId";

export const targetRoutes = Layer.mergeAll(
  HttpRouter.add("GET", formTargets, withErrors(list)),
  HttpRouter.add("POST", formTargets, withErrors(create)),
  HttpRouter.add("POST", `${target}/rotate-secret`, withErrors(rotate)),
  HttpRouter.add("PUT", `${target}/recipients`, withErrors(replaceRecipients)),
  HttpRouter.add("POST", `${target}/confirmations`, withErrors(resend)),
  HttpRouter.add("POST", `${target}/:action`, withErrors(setStatus)),
);
