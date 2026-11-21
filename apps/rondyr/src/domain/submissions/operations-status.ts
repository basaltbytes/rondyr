import { Schema } from "effect";

import { DeliveryStatus } from "../deliveries/delivery.ts";
import { QuarantineReason } from "./classification.ts";
import { InboxOrganization } from "./inbox.ts";
import { SubmissionId } from "./submission.id.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DeliveryCount = Schema.Struct({ status: DeliveryStatus, count: Count });

export const QuarantineCount = Schema.Struct({ reason: QuarantineReason, count: Count });

/**
 * The outbox of an organization: the events still published until a hand-off,
 * the age of the oldest, and the stuck events that the Cron no longer publishes.
 */
export const OutboxStatus = Schema.Struct({
  count: Count,
  oldestAgeMs: Schema.NullOr(Count),
  stuck: Count,
});

export const CronSuccessTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const OrganizationStatus = InboxOrganization.mapFields((fields) => ({
  ...fields,
  outbox: OutboxStatus,
  deliveries: Schema.Array(DeliveryCount),
  receivedLast24h: Count,
  quarantinedLast24h: Schema.Array(QuarantineCount),
}));

/** A submission whose event the Cron stopped publishing. It has no content. */
export const StuckSubmission = Schema.Struct({
  submissionId: SubmissionId,
  formPublicId: Schema.String,
  formName: Schema.String,
  receivedAt: Schema.Int,
  stuckAt: Schema.Int,
});

/** How many submissions of an organization are stuck, and the oldest ones. */
export const StuckSubmissions = Schema.Struct({
  count: Count,
  submissions: Schema.Array(StuckSubmission),
});

export const OperationsStatus = Schema.Struct({
  organizations: Schema.Array(OrganizationStatus),
  lastSuccessfulCronAt: Schema.NullOr(CronSuccessTime),
});
