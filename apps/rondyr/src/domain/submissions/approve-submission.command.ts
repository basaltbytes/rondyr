import * as Domain from "@alchemy.run/domain";

import { ReviewSession } from "./review-session.middleware.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { SubmissionNotFound, SubmissionNotReviewable } from "./submission.rejection.ts";
import { SubmissionId } from "./submission.id.ts";

export class ApproveSubmission extends Domain.Command(
  "ApproveSubmission",
  {
    target: SubmissionId,
    events: [SubmissionAccepted],
    middleware: [ReviewSession],
    rejects: [SubmissionNotFound, SubmissionNotReviewable],
  },
  { description: "Accept a quarantined submission as an organization reviewer." },
) {}
