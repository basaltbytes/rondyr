import { Schema } from "effect";

import { DeliveryStatus } from "../deliveries/delivery.ts";
import { QuarantineReason } from "./classification.ts";
import { InboxOrganization } from "./inbox.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DeliveryCount = Schema.Struct({ status: DeliveryStatus, count: Count });

export const QuarantineCount = Schema.Struct({ reason: QuarantineReason, count: Count });

export const OutboxStatus = Schema.Struct({ count: Count, oldestAgeMs: Schema.NullOr(Count) });

export const CronSuccessTime = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const OrganizationStatus = InboxOrganization.mapFields((fields) => ({
  ...fields,
  outbox: OutboxStatus,
  deliveries: Schema.Array(DeliveryCount),
  receivedLast24h: Count,
  quarantinedLast24h: Schema.Array(QuarantineCount),
}));

export const OperationsStatus = Schema.Struct({
  organizations: Schema.Array(OrganizationStatus),
  lastSuccessfulCronAt: Schema.NullOr(CronSuccessTime),
});
