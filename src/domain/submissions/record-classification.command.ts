import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

import { ClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores } from "./classification.ts";
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
          scores: ClassificationScores,
          policy: ClassificationPolicy,
        }),
        Schema.TaggedStruct("ClassificationError", {
          policy: Schema.optionalKey(ClassificationPolicy),
        }),
      ]),
    },
    events: [SubmissionAccepted, SubmissionQuarantined],
  },
  {
    description: "Apply classification rules to a completed attempt or an exhausted retry budget.",
  },
) {}
