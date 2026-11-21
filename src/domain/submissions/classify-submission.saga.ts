import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";
import { Activity, DurableClock } from "effect/workflow";

import { ResolvedClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores } from "./classification.ts";
import { ClassificationFailed, Classifier } from "./classifier.external.ts";
import { RecordClassification } from "./record-classification.command.ts";
import { Submission } from "./submission.aggregate.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class ClassifySubmission extends Domain.Saga(
  "ClassifySubmission",
  { key: SubmissionId, input: { organizationId: OrganizationId } },
  { description: "Classify a submission with a bounded retry budget and record its outcome." },
) {}

export const classifySubmissionLive = ClassifySubmission.toLayer(
  Effect.gen(function* () {
    const submissions = yield* Submission;
    const classifier = yield* Classifier;

    return Effect.fnUntraced(function* ({ key, organizationId }) {
      const resolved = yield* Activity.make({
        name: "resolve-classification-policy",
        success: ResolvedClassificationPolicy,
        error: ClassificationFailed,
        execute: classifier.policy({ organizationId }),
      }).pipe(Effect.result);
      if (resolved._tag === "Success") {
        const { classifier: provider, policy } = resolved.success;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const score = yield* Activity.make({
            name: `score-${attempt}`,
            success: ClassificationScores,
            error: ClassificationFailed,
            execute: classifier.score({ submissionId: key, organizationId, classifier: provider }),
          }).pipe(Effect.result);
          if (score._tag === "Success") {
            yield* Activity.make({
              name: "record-classification",
              execute: submissions
                .send(
                  key,
                  RecordClassification.make({
                    result: { _tag: "Scored", scores: score.success, policy },
                  }),
                )
                .pipe(Effect.asVoid),
            });
            return;
          }
          if (!score.failure.retryable || attempt === 3) break;
          yield* DurableClock.sleep({
            name: `retry-${attempt}`,
            duration: attempt === 1 ? "10 seconds" : "30 seconds",
            inMemoryThreshold: 0,
          });
        }
      }

      const failure = { _tag: "ClassificationError" } as const;
      const result =
        resolved._tag === "Success" ? { ...failure, policy: resolved.success.policy } : failure;
      yield* Activity.make({
        name: "record-classification-error",
        execute: submissions.send(key, RecordClassification.make({ result })).pipe(Effect.asVoid),
      });
    });
  }),
);
