import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { QuarantineReason } from "./classification.ts";
import type { DecisionAuthor } from "./decision-author.ts";
import { ReviewSession } from "./review-session.middleware.ts";
import {
  SubmissionNotFound,
  SubmissionNotReclassifiable,
  SubmissionNotReviewable,
} from "./submission.rejection.ts";
import { ApiTokenId, OrganizationId, SubmissionId, UserId } from "./submission.id.ts";

type Reclassification = { readonly organizationId: OrganizationId } & DecisionAuthor;

/** A person sends a submission back to classification after a classifier error. */
export class ReclassificationRequested extends Domain.Event("ReclassificationRequested", {
  organizationId: OrganizationId,
  // One flat field map, as for `SubmissionDismissed`: `make` requires exactly one author.
  reviewerId: Schema.optionalKey(UserId),
  apiTokenId: Schema.optionalKey(ApiTokenId),
}) {
  static override make(props: Reclassification, options?: Schema.MakeOptions) {
    return super.make(props, options);
  }
}

export class ReclassifySubmission extends Domain.Command(
  "ReclassifySubmission",
  {
    target: SubmissionId,
    input: {
      /**
       * The reason the inbox shows. The aggregate reads it only for a submission
       * quarantined before its state kept the reason, and its own reason otherwise.
       */
      inboxReason: Schema.optionalKey(QuarantineReason),
    },
    events: [ReclassificationRequested],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, SubmissionNotReviewable, SubmissionNotReclassifiable],
  },
  {
    description:
      "Send a submission quarantined after a classifier error back to classification as an organization reviewer.",
  },
) {}
