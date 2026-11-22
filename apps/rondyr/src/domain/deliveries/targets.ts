import { Schema } from "effect";

import {
  ConnectorRefusal,
  ConnectorTarget,
  CreateConnectorTarget,
} from "./connectors/connector-target.ts";
import { CreateEmailTarget, EmailTarget, RecipientsRefusalReason } from "./email.ts";
import { DestinationRefusalReason } from "./webhook-destination.ts";
import { CreateWebhookTarget, WebhookTarget } from "./webhook.ts";

/** A destination of a form as the admin API lists it. */
export const DestinationTarget = Schema.Union([WebhookTarget, EmailTarget, ConnectorTarget]);

export const CreateTarget = Schema.Union([
  CreateWebhookTarget,
  CreateEmailTarget,
  CreateConnectorTarget,
]);

export const TargetRequestError = Schema.Union([
  Schema.Struct({
    error: Schema.Literal("destination-refused"),
    reason: DestinationRefusalReason,
  }),
  Schema.Struct({
    error: Schema.Literal("recipients-refused"),
    reason: RecipientsRefusalReason,
  }),
  ...ConnectorRefusal.members,
  Schema.Struct({ error: Schema.Literal("secrets-key-missing") }),
  Schema.Struct({ error: Schema.Literal("email-provider-missing") }),
  // The Rate Limiting binding of the tests did not answer: no test was sent.
  Schema.Struct({ error: Schema.Literal("test-limit-unavailable") }),
]);
