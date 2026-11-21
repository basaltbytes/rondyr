import { Context, Effect, Schema } from "effect";

import type {
  DeliveredSubmission,
  DeliveryId,
  NotificationTarget,
} from "../domain/deliveries/delivery.ts";
import type { SubmissionFields } from "../domain/submissions/submission-fields.ts";

/**
 * The attempt did not reach the recipient. A retryable failure is attempted
 * again later; a permanent one ends the delivery. The summary is stored and
 * shown to the organization, so it never contains the submission fields.
 */
export class NotificationFailed extends Schema.TaggedError<
  NotificationFailed,
  { readonly brand: unique symbol }
>()("NotificationFailed", { retryable: Schema.Boolean, summary: Schema.String }) {}

export interface Notification {
  /** The same on every attempt of a delivery, so the recipient can drop duplicates. */
  readonly deliveryId: DeliveryId;
  /**
   * When the delivery was created. An email goes to the recipients confirmed by
   * then, so every attempt of a delivery has the same recipients.
   */
  readonly createdAt: number;
  readonly target: typeof NotificationTarget.Type;
  readonly submission: typeof DeliveredSubmission.Type;
  readonly fields: typeof SubmissionFields.Type;
}

/** A message that tests a target. It belongs to no submission and no delivery. */
export interface TestNotification {
  /** A new identifier for each test, sent where a delivery sends its delivery ID. */
  readonly testId: DeliveryId;
  readonly target: typeof NotificationTarget.Type;
  readonly form: { readonly publicId: string; readonly name: string };
}

export class NotificationProvider extends Context.Service<
  NotificationProvider,
  {
    /** Send one attempt of a delivery to its target. */
    readonly send: (notification: Notification) => Effect.Effect<void, NotificationFailed>;
    /** Send a test message, marked as such, with the checks of `send`. */
    readonly sendTest: (test: TestNotification) => Effect.Effect<void, NotificationFailed>;
  }
>()("rondyr/ports/notification-provider/NotificationProvider") {}
