import { Context, Effect } from "effect";

import type { RetentionPeriods } from "../domain/organizations/retention.ts";
import type { SubmissionNotFound } from "../domain/submissions/submission.rejection.ts";
import type { OrganizationId, SubmissionId } from "../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

/**
 * The messages of one organization that one of its retention periods covers:
 * the accepted ones, or those in quarantine and the archived ones. A message
 * received at or before `cutoff` has reached the end of its period.
 */
export interface RetentionLane {
  readonly organizationId: OrganizationId;
  readonly statuses: "accepted" | "quarantine";
  readonly cutoff: number;
}

/**
 * The deletion of messages, by a member or by the retention period of their
 * organization. Deleting a message deletes its outbox event, its inbox row,
 * its deliveries and their attempts, and writes a line without content to
 * `submission_deletions` in the same transaction.
 */
export class SubmissionRetention extends Context.Service<
  SubmissionRetention,
  {
    readonly remove: (
      scope: OrganizationScope,
      submissionId: SubmissionId,
    ) => Effect.Effect<void, SubmissionNotFound | StorageUnavailable>;
    readonly periods: (
      scope: OrganizationScope,
    ) => Effect.Effect<RetentionPeriods, StorageUnavailable>;
    readonly savePeriods: (
      scope: OrganizationScope,
      periods: RetentionPeriods,
    ) => Effect.Effect<RetentionPeriods, StorageUnavailable>;
    /** The lanes that have a retention period at `now`, by organization. */
    readonly retentionLanes: (
      now: number,
    ) => Effect.Effect<ReadonlyArray<RetentionLane>, StorageUnavailable>;
    /**
     * Delete up to `limit` messages of a lane, the oldest first, whose retention
     * period has ended at `now`, and return how many. A batch is one transaction,
     * which reads the period again: a period changed since `retentionLanes` wins.
     */
    readonly purgeLane: (
      lane: RetentionLane,
      now: number,
      limit: number,
    ) => Effect.Effect<number, StorageUnavailable>;
  }
>()("rondyr/ports/submission-retention/SubmissionRetention") {}
