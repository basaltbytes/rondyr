import { Schema } from "effect";

import { CreateEmailTarget, EmailTarget, RecipientsRefusalReason } from "./email.ts";
import { DestinationRefusalReason } from "./webhook-destination.ts";
import { CreateWebhookTarget, WebhookTarget } from "./webhook.ts";

/** A destination of a form as the admin API lists it. */
export const DestinationTarget = Schema.Union([WebhookTarget, EmailTarget]);

export const CreateTarget = Schema.Union([CreateWebhookTarget, CreateEmailTarget]);

export const TargetRequestError = Schema.Union([
  Schema.Struct({
    error: Schema.Literal("destination-refused"),
    reason: DestinationRefusalReason,
  }),
  Schema.Struct({
    error: Schema.Literal("recipients-refused"),
    reason: RecipientsRefusalReason,
  }),
  Schema.Struct({ error: Schema.Literal("secrets-key-missing") }),
  Schema.Struct({ error: Schema.Literal("email-provider-missing") }),
]);
