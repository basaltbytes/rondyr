import { Context, Effect, Schema } from "effect";

import type { TargetId } from "../domain/deliveries/delivery.ts";
import type { EmailRecipients, EmailTarget } from "../domain/deliveries/email.ts";
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

/** The destinations of the forms of the account's organizations. */
export class NotificationTargets extends Context.Service<
  NotificationTargets,
  {
    /** The webhook and email targets of a form. */
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
    ) => Effect.Effect<
      typeof EmailTarget.Type,
      TargetNotFound | EmailProviderMissing | StorageUnavailable
    >;
    /** Replace the recipients of an email target. */
    readonly replaceRecipients: (
      target: TargetScope,
      recipients: EmailRecipients,
    ) => Effect.Effect<typeof EmailTarget.Type, TargetNotFound | StorageUnavailable>;
    /** An inactive target gets no delivery for the messages accepted while it is inactive. */
    readonly setStatus: (
      target: TargetScope,
      status: typeof TargetStatus.Type,
    ) => Effect.Effect<typeof DestinationTarget.Type, TargetNotFound | StorageUnavailable>;
  }
>()("rondyr/ports/notification-targets/NotificationTargets") {}
