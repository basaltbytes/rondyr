import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores, QuarantineReason } from "./classification.ts";
import { OrganizationId } from "./submission.id.ts";

/**
 * The submission waits for a human review. A classification rule records the
 * scores it read; an intake check records no score, since no classifier ran.
 */
export class SubmissionQuarantined extends Domain.Event("SubmissionQuarantined", {
  organizationId: OrganizationId,
  reason: QuarantineReason,
  scores: Schema.optionalKey(ClassificationScores),
  policy: Schema.optionalKey(ClassificationPolicy),
  rulesVersion: Schema.Int,
}) {}
