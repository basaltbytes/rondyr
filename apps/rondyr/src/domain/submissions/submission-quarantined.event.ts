import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationPolicy, ClassifierProvider } from "./classification-policy.ts";
import {
  ClassificationFailure,
  ClassificationScores,
  ClassificationSignals,
  EscalationEvaluation,
  QuarantineReason,
} from "./classification.ts";
import { OrganizationId } from "./submission.id.ts";

/**
 * The submission waits for a human review. A classification rule records the
 * scores it read; an intake check records no score, since no classifier ran.
 */
export class SubmissionQuarantined extends Domain.Event("SubmissionQuarantined", {
  organizationId: OrganizationId,
  reason: QuarantineReason,
  classifier: Schema.optionalKey(ClassifierProvider),
  scores: Schema.optionalKey(ClassificationScores),
  signals: Schema.optionalKey(ClassificationSignals),
  policy: Schema.optionalKey(ClassificationPolicy),
  escalation: Schema.optionalKey(EscalationEvaluation),
  attempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  failure: Schema.optionalKey(ClassificationFailure),
  rulesVersion: Schema.Int,
}) {}
