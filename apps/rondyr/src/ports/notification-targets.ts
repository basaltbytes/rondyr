import { Context, Effect, Schema } from "effect";

import type {
  ConnectorDestination,
  ConnectorTarget,
} from "../domain/deliveries/connectors/connector-target.ts";
import type { NotificationTarget, TargetId } from "../domain/deliveries/delivery.ts";
import type { EmailLanguage, EmailRecipients, EmailTarget } from "../domain/deliveries/email.ts";
import type { DestinationTarget } from "../domain/deliveries/targets.ts";
import type { WebhookUrl } from "../domain/deliveries/webhook-destination.ts";
import type { IssuedWebhookSecret } from "../domain/deliveries/webhook.ts";
import type { OrganizationId, UserId } from "../domain/submissions/submission.id.ts";
import type { EmailProviderMissing } from "./email-sender.ts";
import type { SecretsKeyMissing } from "./secret-cipher.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The form or target does not exist in an organization of the account. */
export class TargetNotFound extends Schema.TaggedError<
  TargetNotFound,
  { readonly brand: unique symbol }
>()("TargetNotFound", {}) {}

/** Another request rotated the secret first. */
export class TargetChanged extends Schema.TaggedError<
  TargetChanged,
  { readonly brand: unique symbol }
>()("TargetChanged", {}) {}

export interface FormScope {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
  readonly formPublicId: string;
}

export interface TargetScope {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
  readonly targetId: typeof TargetId.Type;
}

export const TargetStatus = Schema.Literals(["active", "inactive"]);

/** A target as its provider reads it, with the form that it belongs to. */
export interface TestableTarget {
  readonly target: typeof NotificationTarget.Type;
  readonly form: { readonly publicId: string; readonly name: string };
}

/** The destinations of the forms of the account's organizations. */
export class NotificationTargets extends Context.Service<
  NotificationTargets,
  {
    /** The targets of a form: webhooks, emails and the destinations of connectors. */
    readonly list: (
      form: FormScope,
    ) => Effect.Effect<
      ReadonlyArray<typeof DestinationTarget.Type>,
      TargetNotFound | StorageUnavailable
    >;
    /** Create an active webhook target with a new signing secret. */
    readonly createWebhook: (
      form: FormScope,
      url: WebhookUrl,
    ) => Effect.Effect<
      typeof IssuedWebhookSecret.Type,
      TargetNotFound | SecretsKeyMissing | StorageUnavailable
    >;
    /** Issue a new secret. The current one keeps signing until the rotation window ends. */
    readonly rotateSecret: (
      target: TargetScope,
    ) => Effect.Effect<
      typeof IssuedWebhookSecret.Type,
      TargetNotFound | TargetChanged | SecretsKeyMissing | StorageUnavailable
    >;
    /** Create an active email target. Refused when the stage has no email provider. */
    readonly createEmail: (
      form: FormScope,
      recipients: EmailRecipients,
      language: EmailLanguage,
    ) => Effect.Effect<
      typeof EmailTarget.Type,
      TargetNotFound | EmailProviderMissing | StorageUnavailable
    >;
    /** Replace the recipients of an email target, and its language when one is given. */
    readonly replaceRecipients: (
      target: TargetScope,
      recipients: EmailRecipients,
      language: EmailLanguage | undefined,
    ) => Effect.Effect<typeof EmailTarget.Type, TargetNotFound | StorageUnavailable>;
    /** Create an active destination of a connector. Its secret settings are sealed. */
    readonly createConnector: (
      form: FormScope,
      destination: ConnectorDestination,
    ) => Effect.Effect<
      typeof ConnectorTarget.Type,
      TargetNotFound | SecretsKeyMissing | StorageUnavailable
    >;
    /**
     * Replace the name and every setting of a destination of a connector. A
     * target of another type than the destination's is not found.
     */
    readonly replaceConnector: (
      target: TargetScope,
      destination: ConnectorDestination,
    ) => Effect.Effect<
      typeof ConnectorTarget.Type,
      TargetNotFound | SecretsKeyMissing | StorageUnavailable
    >;
    /** A target, active or not, to send a test message to. */
    readonly testable: (
      target: TargetScope,
    ) => Effect.Effect<TestableTarget, TargetNotFound | StorageUnavailable>;
    /** An inactive target gets no delivery for the messages accepted while it is inactive. */
    readonly setStatus: (
      target: TargetScope,
      status: typeof TargetStatus.Type,
    ) => Effect.Effect<typeof DestinationTarget.Type, TargetNotFound | StorageUnavailable>;
  }
>()("rondyr/ports/notification-targets/NotificationTargets") {}
