import { Context, Effect } from "effect";

import type { RetentionPeriods } from "../domain/organizations/retention.ts";
import type { SubmissionNotFound } from "../domain/submissions/submission.rejection.ts";
import type { SubmissionId } from "../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

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
    /**
     * Delete up to `limit` messages, the oldest first, whose retention period
     * has ended at `now`, and return how many. A batch is one transaction.
     */
    readonly purgeExpired: (
      now: number,
      limit: number,
    ) => Effect.Effect<number, StorageUnavailable>;
  }
>()("rondyr/ports/submission-retention/SubmissionRetention") {}
