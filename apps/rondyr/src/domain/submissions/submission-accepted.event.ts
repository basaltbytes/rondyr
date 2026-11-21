import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores, EscalationEvaluation, SubmissionLabel } from "./classification.ts";
import { ByApiToken, ByReviewer } from "./decision-author.ts";
import { OrganizationId } from "./submission.id.ts";

export const Acceptance = Schema.Union([
  Schema.TaggedStruct("Automatic", {
    scores: ClassificationScores,
    rulesVersion: Schema.Int,
    policy: Schema.optionalKey(ClassificationPolicy),
    escalation: Schema.optionalKey(EscalationEvaluation),
    label: Schema.optionalKey(SubmissionLabel),
  }),
  Schema.TaggedStruct("Manual", ByReviewer),
  Schema.TaggedStruct("Manual", ByApiToken),
]);

export class SubmissionAccepted extends Domain.Event("SubmissionAccepted", {
  organizationId: OrganizationId,
  acceptance: Acceptance,
}) {}
