import { Schema } from "effect";

import { SubmissionFields } from "../submissions/submission-fields.ts";
import { SubmissionId } from "../submissions/submission.id.ts";
import { DeliveryId, TargetId } from "./delivery.ts";

/** The JSON body of a webhook request, version 1. docs/webhooks.md documents it. */
export const WebhookPayload = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("submission.accepted"),
  deliveryId: DeliveryId,
  submission: Schema.Struct({
    id: SubmissionId,
    receivedAt: Schema.DateTimeUtcFromString,
    fields: SubmissionFields,
  }),
  form: Schema.Struct({ id: Schema.String, name: Schema.String }),
});

/**
 * The body of a test request sent from the dashboard: the fields of version 1,
 * with the type `test`. `deliveryId` and `submission.id` are the same new UUID,
 * and no submission has it.
 */
export const WebhookTestPayload = WebhookPayload.mapFields((fields) => ({
  ...fields,
  type: Schema.Literal("test"),
}));

/** The fields of a test request. No visitor sent them. */
export const testWebhookFields = {
  message: "Message d’essai envoyé depuis le dashboard Rondyr. Aucun visiteur ne l’a envoyé.",
};

export const webhookHeaders = {
  deliveryId: "rondyr-delivery-id",
  timestamp: "rondyr-timestamp",
  signature: "rondyr-signature",
} as const;

/** After a rotation, the previous secret also signs requests for 24 hours. */
export const secretRotationWindowMillis = 86_400_000;

/** A webhook target as the admin API returns it, without its secrets. */
export const WebhookTarget = Schema.Struct({
  id: TargetId,
  type: Schema.Literal("webhook"),
  url: Schema.String,
  active: Schema.Boolean,
  createdAt: Schema.Int,
  /** When the previous secret stops signing requests, in milliseconds since the epoch. */
  previousSecretExpiresAt: Schema.NullOr(Schema.Int),
});

export const CreateWebhookTarget = Schema.Struct({
  type: Schema.Literal("webhook"),
  url: Schema.String.check(Schema.isMaxLength(4096)),
});

/** The only response that contains a signing secret: after a creation or a rotation. */
export const IssuedWebhookSecret = Schema.Struct({ target: WebhookTarget, secret: Schema.String });
