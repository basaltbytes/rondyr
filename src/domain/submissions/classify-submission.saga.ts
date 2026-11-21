import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";
import { Activity, DurableClock } from "effect/workflow";

import { ResolvedClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores, reviewReason, rulesVersion } from "./classification.ts";
import { ClassificationFailed, Classifier } from "./classifier.external.ts";
import { RecordClassification } from "./record-classification.command.ts";
import { Submission } from "./submission.aggregate.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

export class ClassifySubmission extends Domain.Saga(
  "ClassifySubmission",
  { key: SubmissionId, input: { organizationId: OrganizationId } },
  { description: "Classify a submission with a bounded retry budget and record its outcome." },
) {}

/**
 * Run an activity up to three times, waiting 10 seconds and then 30 seconds
 * after a retryable failure. The activity's name must include `attempt`, and
 * each wait is named `${sleep}-${attempt}`, so that a replayed workflow finds
 * the outcomes it recorded.
 */
const withRetries = <A, R>(
  sleep: string,
  activity: (attempt: number) => Effect.Effect<A, ClassificationFailed, R>,
) =>
  Effect.gen(function* () {
    for (let attempt = 1; ; attempt += 1) {
      const result = yield* activity(attempt).pipe(Effect.result);
      if (result._tag === "Success" || !result.failure.retryable || attempt === 3) return result;
      yield* DurableClock.sleep({
        name: `${sleep}-${attempt}`,
        duration: attempt === 1 ? "10 seconds" : "30 seconds",
        inMemoryThreshold: 0,
      });
    }
  });

export const classifySubmissionLive = ClassifySubmission.toLayer(
  Effect.gen(function* () {
    const submissions = yield* Submission;
    const classifier = yield* Classifier;

    return Effect.fnUntraced(function* ({ key, organizationId }) {
      const resolved = yield* withRetries("policy-retry", (attempt) =>
        Activity.make({
          name: `resolve-classification-policy-${attempt}`,
          success: ResolvedClassificationPolicy,
          error: ClassificationFailed,
          execute: classifier.policy({ organizationId }),
        }),
      );
      if (resolved._tag === "Success") {
        const { classifier: provider, policy, escalationClassifier } = resolved.success;
        // Workflows started before the policy lookup recorded these names.
        const score = yield* withRetries("retry", (attempt) =>
          Activity.make({
            name: `score-${attempt}`,
            success: ClassificationScores,
            error: ClassificationFailed,
            execute: classifier.score({ submissionId: key, organizationId, classifier: provider }),
          }),
        );
        if (score._tag === "Success") {
          const scores = score.success;
          const result = { _tag: "Scored", scores, policy } as const;
          if (
            policy.escalation === true &&
            escalationClassifier !== undefined &&
            escalationClassifier !== provider &&
            reviewReason(scores, policy) === "ambiguous"
          ) {
            const second = yield* withRetries("escalation-retry", (attempt) =>
              Activity.make({
                name: `score-escalation-${attempt}`,
                success: ClassificationScores,
                error: ClassificationFailed,
                execute: classifier.score({
                  submissionId: key,
                  organizationId,
                  classifier: escalationClassifier,
                }),
              }),
            );
            const escalation = {
              classifier: escalationClassifier,
              rulesVersion,
              ...(second._tag === "Success" && { scores: second.success }),
            };
            yield* Activity.make({
              name: "record-escalated-classification",
              execute: submissions
                .send(key, RecordClassification.make({ result: { ...result, escalation } }))
                .pipe(Effect.asVoid),
            });
            return;
          }
          yield* Activity.make({
            name: "record-classification",
            execute: submissions
              .send(key, RecordClassification.make({ result }))
              .pipe(Effect.asVoid),
          });
          return;
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
