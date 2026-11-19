import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationScores } from "./classification.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class ClassificationFailed extends Schema.TaggedError<
  ClassificationFailed,
  { readonly brand: unique symbol }
>()("ClassificationFailed", { retryable: Schema.Boolean }) {}

export class Classifier extends Domain.ExternalSystem(
  "Classifier",
  {
    score: {
      args: { submissionId: SubmissionId, organizationId: OrganizationId },
      success: ClassificationScores.fields,
      error: ClassificationFailed,
    },
  },
  { description: "Evaluate spam and, when configured, business relevance for a stored message." },
) {}
