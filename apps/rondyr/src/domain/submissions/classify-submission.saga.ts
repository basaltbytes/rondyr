import * as Domain from "@alchemy.run/domain";
import { Effect, Schema } from "effect";
import { Activity, DurableClock } from "effect/workflow";

import { ClassificationReservation } from "../organizations/organization-quotas.ts";
import { type ClassifierProvider, ResolvedClassificationPolicy } from "./classification-policy.ts";
import { ClassificationScores, reviewReason, rulesVersion } from "./classification.ts";
import { ClassificationFailed, Classifier } from "./classifier.external.ts";
import { RecordClassification } from "./record-classification.command.ts";
import { Submission } from "./submission.aggregate.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

/**
 * One classification run of a submission: the submission ID for its first run,
 * then `<submission ID>/<event sequence number>` for each reclassification.
 */
export const ClassificationRunId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
).pipe(Schema.brand("ClassificationRunId"));

export class ClassifySubmission extends Domain.Saga(
  "ClassifySubmission",
  {
    key: ClassificationRunId,
    input: {
      organizationId: OrganizationId,
      // Runs started before reclassification have only their key, the submission ID.
      submissionId: Schema.optionalKey(SubmissionId),
    },
  },
  { description: "Classify a submission with a bounded retry budget and record its outcome." },
) {}

const decodeSubmissionId = Schema.decodeEffect(SubmissionId);

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

    /**
     * The second evaluation of an ambiguous submission. It first reserves one
     * classification of the organization's day, once, whatever the number of
     * retries of the second call. A reached limit or a reservation that keeps
     * failing leaves the second model uncalled.
     */
    const secondEvaluation = Effect.fnUntraced(function* (
      submissionId: SubmissionId,
      organizationId: OrganizationId,
      second: ClassifierProvider,
    ) {
      const evaluation = { classifier: second, rulesVersion };
      const reservation = yield* withRetries("reservation-retry", (attempt) =>
        Activity.make({
          name: `reserve-escalation-${attempt}`,
          success: ClassificationReservation,
          error: ClassificationFailed,
          execute: classifier.reserveEscalation({ organizationId }),
        }),
      );
      if (reservation._tag === "Failure") return evaluation;
      if (reservation.success === "limit-reached") {
        return { ...evaluation, skipped: "quota" as const };
      }
      const scored = yield* withRetries("escalation-retry", (attempt) =>
        Activity.make({
          name: `score-escalation-${attempt}`,
          success: ClassificationScores,
          error: ClassificationFailed,
          execute: classifier.score({ submissionId, organizationId, classifier: second }),
        }),
      );
      return scored._tag === "Success" ? { ...evaluation, scores: scored.success } : evaluation;
    });

    return Effect.fnUntraced(function* ({ key: run, organizationId, submissionId }) {
      const key = submissionId ?? (yield* decodeSubmissionId(run).pipe(Effect.orDie));
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
            const escalation = yield* secondEvaluation(key, organizationId, escalationClassifier);
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
