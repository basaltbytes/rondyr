import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ReviewSession } from "./review-session.middleware.ts";
import { SubmissionNotFound, SubmissionNotReviewable } from "./submission.rejection.ts";
import { ApiTokenId, OrganizationId, SubmissionId, UserId } from "./submission.id.ts";

export class SubmissionDismissed extends Domain.Event("SubmissionDismissed", {
  organizationId: OrganizationId,
  reviewerId: Schema.optionalKey(UserId),
  apiTokenId: Schema.optionalKey(ApiTokenId),
}) {}

export class DismissSubmission extends Domain.Command(
  "DismissSubmission",
  {
    target: SubmissionId,
    events: [SubmissionDismissed],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, SubmissionNotReviewable],
  },
  { description: "Archive a quarantined submission as an organization reviewer." },
) {}
