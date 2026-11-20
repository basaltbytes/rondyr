import { Context, Effect, Option } from "effect";

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

export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * Lease up to `limit` due events: not handed off, with an expired lease, and
     * never published or published at or before `lease.republishBefore`.
     */
    readonly claimDue: (
      lease: OutboxLease,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<SubmissionId>, StorageUnavailable>;
    /** Lease the event of one submission under the conditions of `claimDue`. */
    readonly claim: (
      lease: OutboxLease,
      submissionId: SubmissionId,
    ) => Effect.Effect<ReadonlyArray<SubmissionId>, StorageUnavailable>;
    /** Record the publication of the events that `lease` still holds, and release them. */
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
  }
>()("rondyr/ports/outbox") {}
