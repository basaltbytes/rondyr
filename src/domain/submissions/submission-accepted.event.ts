import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores, SubmissionLabel } from "./classification.ts";
import { ApiTokenId, OrganizationId, UserId } from "./submission.id.ts";

export const Acceptance = Schema.Union([
  Schema.TaggedStruct("Automatic", {
    scores: ClassificationScores,
    rulesVersion: Schema.Int,
    policy: Schema.optionalKey(ClassificationPolicy),
    label: Schema.optionalKey(SubmissionLabel),
  }),
  Schema.TaggedStruct("Manual", {
    reviewerId: UserId,
    apiTokenId: Schema.optionalKey(Schema.Never),
  }),
  Schema.TaggedStruct("Manual", {
    apiTokenId: ApiTokenId,
    reviewerId: Schema.optionalKey(Schema.Never),
  }),
]);

export class SubmissionAccepted extends Domain.Event("SubmissionAccepted", {
  organizationId: OrganizationId,
  acceptance: Acceptance,
}) {}
