import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import {
  ClassificationReason,
  ClassificationResult,
  ClassificationScores,
} from "./classification.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class SubmissionQuarantined extends Domain.Event("SubmissionQuarantined", {
  organizationId: OrganizationId,
  reason: ClassificationReason,
  scores: Schema.optionalKey(ClassificationScores),
  rulesVersion: Schema.Int,
}) {}

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
