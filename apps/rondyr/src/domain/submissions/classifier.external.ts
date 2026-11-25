import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationReservation } from "../organizations/organization-quotas.ts";
import { ClassifierProvider, ResolvedClassificationPolicy } from "./classification-policy.ts";
import { ClassificationFailureKind, ClassifierScores } from "./classification.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class ClassificationFailed extends Schema.TaggedError<
  ClassificationFailed,
  { readonly brand: unique symbol }
>()("ClassificationFailed", {
  retryable: Schema.Boolean,
  kind: Schema.optionalKey(ClassificationFailureKind),
  upstreamCode: Schema.optionalKey(Schema.String),
}) {}

export class Classifier extends Domain.ExternalSystem(
  "Classifier",
  {
    policy: {
      args: { organizationId: OrganizationId },
      success: ResolvedClassificationPolicy.fields,
      error: ClassificationFailed,
    },
    score: {
      args: {
        submissionId: SubmissionId,
        organizationId: OrganizationId,
        classifier: ClassifierProvider,
      },
      success: ClassifierScores.fields,
      error: ClassificationFailed,
    },
    // One more classification for the organization's current UTC day, before a second model call.
    reserveEscalation: {
      args: { organizationId: OrganizationId },
      success: ClassificationReservation,
      error: ClassificationFailed,
    },
  },
  {
    description:
      "Evaluate spam, unsolicited commercial outreach and, when configured, business relevance for a stored message.",
  },
) {}
