import * as Domain from "@alchemy.run/domain";

import { ClassificationResult } from "./classification.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { SubmissionId } from "./submission.id.ts";

export class RecordClassification extends Domain.Command(
  "RecordClassification",
  {
    target: SubmissionId,
    input: { result: ClassificationResult },
    events: [SubmissionAccepted, SubmissionQuarantined],
  },
  {
    description: "Apply classification rules to a completed attempt or an exhausted retry budget.",
  },
) {}
