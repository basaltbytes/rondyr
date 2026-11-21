import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class DeliveriesUnavailable extends Schema.TaggedError<
  DeliveriesUnavailable,
  { readonly brand: unique symbol }
>()("DeliveriesUnavailable", {}) {}

export class DeliveryScheduler extends Domain.ExternalSystem(
  "DeliveryScheduler",
  {
    schedule: {
      args: { submissionId: SubmissionId, organizationId: OrganizationId, acceptedAt: Schema.Int },
      error: DeliveriesUnavailable,
    },
  },
  {
    description:
      "Store one delivery per active target of an accepted submission's form, then queue it.",
  },
) {}
