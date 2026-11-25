import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationPolicy, ClassifierProvider } from "./classification-policy.ts";
import {
  ClassificationFailure,
  ClassificationScores,
  ClassificationSignals,
  EscalationEvaluation,
} from "./classification.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { SubmissionId } from "./submission.id.ts";

export class RecordClassification extends Domain.Command(
  "RecordClassification",
  {
    target: SubmissionId,
    input: {
      result: Schema.Union([
        Schema.TaggedStruct("Scored", {
          classifier: Schema.optionalKey(ClassifierProvider),
          scores: ClassificationScores,
          signals: Schema.optionalKey(ClassificationSignals),
          policy: ClassificationPolicy,
          escalation: Schema.optionalKey(EscalationEvaluation),
          attempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
        }),
        Schema.TaggedStruct("ClassificationError", {
          classifier: Schema.optionalKey(ClassifierProvider),
          policy: Schema.optionalKey(ClassificationPolicy),
          failure: Schema.optionalKey(ClassificationFailure),
        }),
      ]),
    },
    events: [SubmissionAccepted, SubmissionQuarantined],
  },
  {
    description: "Apply classification rules to a completed attempt or an exhausted retry budget.",
  },
) {}
