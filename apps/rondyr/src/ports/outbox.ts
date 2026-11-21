import { Context, Effect, Option, Schema } from "effect";

import type { IntakeReason } from "../domain/submissions/classification.ts";
import type { OrganizationId, SubmissionId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

/** Times of one publication attempt, in milliseconds since the epoch. */
export interface OutboxLease {
  readonly now: number;
  /** End of the lease written on each claimed event. */
  readonly until: number;
  /** An event published at or before this time is due again until it is handed off. */
  readonly republishBefore: number;
}

/**
 * A received submission as intake stored it. `intakeReason` is set when intake
 * found a reason to quarantine it without a classifier; intake wrote it with the
 * submission, so every delivery of the same event reads the same value.
 */
export interface PendingHandoff {
  readonly organizationId: OrganizationId;
  readonly intakeReason: Option.Option<IntakeReason>;
}

/** What one Cron pass did with the due events. */
export interface DueEvents {
  /** The events leased for publication. */
  readonly claimed: ReadonlyArray<SubmissionId>;
  /** The events that reached the publication limit and are no longer republished. */
  readonly stuck: ReadonlyArray<SubmissionId>;
}

/** A submission of an organization, as a member asks for it. */
export interface StuckScope {
  readonly organizationId: OrganizationId;
  readonly submissionId: SubmissionId;
}

/** The submission does not exist in the organization, or has no event left to hand off. */
export class StuckSubmissionNotFound extends Schema.TaggedError<
  StuckSubmissionNotFound,
  { readonly brand: unique symbol }
>()("StuckSubmissionNotFound", {}) {}

/** The submission's event is still being published, or was handed off. */
export class SubmissionNotStuck extends Schema.TaggedError<
  SubmissionNotStuck,
  { readonly brand: unique symbol }
>()("SubmissionNotStuck", {}) {}

export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * Mark as stuck the due events published `maxPublications` times, then lease
     * up to `limit` other due events. An event is due when it is not handed off
     * or stuck, its lease expired, and it was never published or was published
     * at or before `lease.republishBefore`.
     */
    readonly claimDue: (
      lease: OutboxLease,
      limit: number,
      maxPublications: number,
    ) => Effect.Effect<DueEvents, StorageUnavailable>;
    /** Lease the event of one submission if it is due. */
    readonly claim: (
      lease: OutboxLease,
      submissionId: SubmissionId,
    ) => Effect.Effect<ReadonlyArray<SubmissionId>, StorageUnavailable>;
    /** Record the publication of the events that `lease` still holds, count it, and release them. */
    readonly markPublished: (
      lease: OutboxLease,
      submissionIds: ReadonlyArray<SubmissionId>,
    ) => Effect.Effect<void, StorageUnavailable>;
    /** What the model needs about a submission whose event is not handed off yet. */
    readonly pendingHandoff: (
      submissionId: SubmissionId,
    ) => Effect.Effect<Option.Option<PendingHandoff>, StorageUnavailable>;
    readonly markHandedOff: (
      submissionId: SubmissionId,
      handedOffAt: number,
    ) => Effect.Effect<void, StorageUnavailable>;
    /**
     * Make a stuck event due again, with its publication count back to zero. Two
     * retries at the same time count as one: the second finds no stuck event.
     */
    readonly retryStuck: (
      scope: StuckScope,
    ) => Effect.Effect<void, StorageUnavailable | StuckSubmissionNotFound | SubmissionNotStuck>;
  }
>()("rondyr/ports/outbox") {}
