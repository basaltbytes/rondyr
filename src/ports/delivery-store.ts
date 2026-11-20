import { Context, Effect, Option, Schema } from "effect";

import {
  DeliveryStatus,
  type AttemptOutcome,
  type DeliveredSubmission,
  type DeliveryId,
  type DeliveryTransition,
  type NotificationTarget,
} from "../domain/deliveries/delivery.ts";
import type { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import type { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import type { OutboxLease } from "./outbox.ts";
import type { StorageUnavailable } from "./storage.ts";

export interface AcceptedSubmission {
  readonly submissionId: SubmissionId;
  readonly organizationId: OrganizationId;
  /** Targets created after this time, in milliseconds since the epoch, are left out. */
  readonly acceptedAt: number;
}

/** Times of one attempt, in milliseconds since the epoch. */
export interface AttemptLease {
  readonly now: number;
  /** Another attempt may start after this time if this one never records its result. */
  readonly until: number;
  readonly maxAttempts: number;
}

/** The submission or delivery does not exist in an organization of the account. */
export class DeliveryNotFound extends Schema.TaggedError<
  DeliveryNotFound,
  { readonly brand: unique symbol }
>()("DeliveryNotFound", {}) {}

/** Only a failed delivery can be retried by hand. */
export class DeliveryNotRetryable extends Schema.TaggedError<
  DeliveryNotRetryable,
  { readonly brand: unique symbol }
>()("DeliveryNotRetryable", { status: DeliveryStatus }) {}

/** A submission of one of the account's organizations. */
export interface SubmissionScope {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
  readonly submissionId: SubmissionId;
}

/** A delivery of a submission of one of the account's organizations. */
export interface DeliveryScope extends SubmissionScope {
  readonly deliveryId: DeliveryId;
}

/** An attempt that this caller started and must finish. */
export interface StartedAttempt {
  readonly deliveryId: DeliveryId;
  /** Position of the attempt in the history of the delivery, from 1. */
  readonly attempt: number;
  /**
   * Position in the current series: the attempts since the delivery was created
   * or last retried by hand, this one included. It decides the retry delay and
   * when the delivery fails.
   */
  readonly seriesAttempt: number;
  readonly target: typeof NotificationTarget.Type;
  readonly submission: typeof DeliveredSubmission.Type;
  readonly fields: typeof SubmissionFields.Type;
}

export class DeliveryStore extends Context.Service<
  DeliveryStore,
  {
    /**
     * Create the missing deliveries of an accepted submission: one per active
     * target of its form and organization that existed when it was accepted.
     * Returns the number of such targets, including those that already had one.
     */
    readonly create: (
      accepted: AcceptedSubmission,
      now: number,
    ) => Effect.Effect<number, StorageUnavailable>;
    /**
     * Lease up to `limit` due deliveries: waiting for an attempt that may start,
     * with an expired lease, and not published since that attempt became due,
     * or published at or before `lease.republishBefore`.
     */
    readonly claimDue: (
      lease: OutboxLease,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<DeliveryId>, StorageUnavailable>;
    /** Lease the due deliveries of one submission under the conditions of `claimDue`. */
    readonly claimSubmission: (
      lease: OutboxLease,
      submissionId: SubmissionId,
    ) => Effect.Effect<ReadonlyArray<DeliveryId>, StorageUnavailable>;
    /** Record the publication of the deliveries that `lease` still holds, and release them. */
    readonly markPublished: (
      lease: OutboxLease,
      deliveryIds: ReadonlyArray<DeliveryId>,
    ) => Effect.Effect<void, StorageUnavailable>;
    /**
     * Start the next attempt of a delivery and record it, or return none when the
     * delivery is finished, waits for a retry, or has a running attempt. An
     * expired attempt is recorded as interrupted, and fails the delivery when no
     * attempt is left.
     */
    readonly start: (
      deliveryId: DeliveryId,
      lease: AttemptLease,
    ) => Effect.Effect<Option.Option<StartedAttempt>, StorageUnavailable>;
    /**
     * Start a new series of attempts on a failed delivery, with the same ID: the
     * delivery becomes pending with a fresh attempt budget, and its recorded
     * attempts stay. Refused for any other status, so concurrent retries
     * succeed once.
     */
    readonly retry: (
      delivery: DeliveryScope,
      now: number,
    ) => Effect.Effect<void, DeliveryNotFound | DeliveryNotRetryable | StorageUnavailable>;
    /** Record the result of an attempt, and move the delivery on unless a later attempt started. */
    readonly finish: (
      attempt: StartedAttempt,
      outcome: typeof AttemptOutcome.Type,
      transition: typeof DeliveryTransition.Type,
      finishedAt: number,
    ) => Effect.Effect<void, StorageUnavailable>;
  }
>()("rondyr/ports/delivery-store/DeliveryStore") {}
