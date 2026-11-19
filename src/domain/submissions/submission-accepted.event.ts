import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationScores } from "./classification.ts";
import { OrganizationId, UserId } from "./submission.id.ts";

export const Acceptance = Schema.Union([
  Schema.TaggedStruct("Automatic", { scores: ClassificationScores, rulesVersion: Schema.Int }),
  Schema.TaggedStruct("Manual", { reviewerId: UserId }),
]);

export class SubmissionAccepted extends Domain.Event("SubmissionAccepted", {
  organizationId: OrganizationId,
  acceptance: Acceptance,
}) {}
