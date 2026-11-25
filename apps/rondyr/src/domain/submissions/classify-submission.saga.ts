import * as Domain from "@alchemy.run/domain";
import { Effect, Schema } from "effect";
import { Activity, DurableClock } from "effect/workflow";

import { ClassificationReservation } from "../organizations/organization-quotas.ts";
import { type ClassifierProvider, ResolvedClassificationPolicy } from "./classification-policy.ts";
import {
  type ClassificationFailure,
  type ClassificationFailureKind,
  ClassificationScores,
  ClassificationSignals,
  classificationDecision,
  reviewReason,
  rulesVersion,
} from "./classification.ts";
import { ClassificationFailed, Classifier } from "./classifier.external.ts";
import { RecordClassification } from "./record-classification.command.ts";
import {
  classificationAttemptsMetric,
  classificationEscalationsMetric,
  classificationRunsMetric,
  recordMetric,
} from "./submission-metrics.ts";
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

const ScoreActivityResult = Schema.Struct({
  ...ClassificationScores.fields,
  signals: Schema.optionalKey(ClassificationSignals),
});

function toFailure(
  error: ClassificationFailed,
  attempts: number,
  fallback: ClassificationFailureKind,
): ClassificationFailure {
  return {
    kind: error.kind ?? fallback,
    retryable: error.retryable,
    attempts,
    ...(error.upstreamCode !== undefined && { upstreamCode: error.upstreamCode }),
  };
}

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
      if (result._tag === "Success") {
        return { _tag: "Success" as const, success: result.success, attempts: attempt };
      }
      if (!result.failure.retryable || attempt === 3) {
        return { _tag: "Failure" as const, failure: result.failure, attempts: attempt };
      }
      yield* Effect.logWarning("Classification activity failed, scheduling retry", {
        stage: sleep,
        attempt,
        kind: result.failure.kind ?? "upstream-error",
        ...(result.failure.upstreamCode !== undefined && {
          upstreamCode: result.failure.upstreamCode,
        }),
      });
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
      if (reservation._tag === "Failure") {
        const failure = toFailure(
          reservation.failure,
          reservation.attempts,
          "reservation-unavailable",
        );
        yield* recordMetric(classificationEscalationsMetric, {
          classifier: second,
          outcome: "reservation-failed",
        });
        yield* Effect.logWarning("Escalation reservation failed", {
          submissionId,
          organizationId,
          classifier: second,
          attempts: reservation.attempts,
          kind: failure.kind,
        });
        return { ...evaluation, failure };
      }
      if (reservation.success === "limit-reached") {
        yield* recordMetric(classificationEscalationsMetric, {
          classifier: second,
          outcome: "skipped-quota",
        });
        yield* Effect.logInfo("Escalation skipped because daily classification quota was reached", {
          submissionId,
          organizationId,
          classifier: second,
        });
        return { ...evaluation, skipped: "quota" as const };
      }
      const scored = yield* withRetries("escalation-retry", (attempt) =>
        Activity.make({
          name: `score-escalation-${attempt}`,
          success: ScoreActivityResult,
          error: ClassificationFailed,
          execute: classifier.score({ submissionId, organizationId, classifier: second }),
        }),
      );
      yield* recordMetric(
        classificationAttemptsMetric,
        {
          classifier: second,
          stage: "escalation",
          outcome: scored._tag === "Success" ? "ok" : "error",
        },
        scored.attempts,
      );
      if (scored._tag === "Failure") {
        const failure = toFailure(
          scored.failure,
          scored.attempts,
          scored.failure.retryable ? "upstream-error" : "invalid-response",
        );
        yield* recordMetric(classificationEscalationsMetric, {
          classifier: second,
          outcome: "failed",
        });
        yield* Effect.logWarning("Escalation classifier failed", {
          submissionId,
          organizationId,
          classifier: second,
          attempts: scored.attempts,
          kind: failure.kind,
          retryable: failure.retryable,
        });
        return { ...evaluation, attempts: scored.attempts, failure };
      }
      const { signals: _signals, ...scores } = scored.success;
      return { ...evaluation, scores, attempts: scored.attempts };
    });

    return Effect.fnUntraced(function* ({ key: run, organizationId, submissionId }) {
      const key = submissionId ?? (yield* decodeSubmissionId(run).pipe(Effect.orDie));
      yield* Effect.annotateCurrentSpan({
        submissionId: key,
        organizationId,
        "classification.runId": run,
      });
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
        yield* Effect.annotateCurrentSpan({ "classification.classifier": provider });
        // Workflows started before the policy lookup recorded these names.
        const score = yield* withRetries("retry", (attempt) =>
          Activity.make({
            name: `score-${attempt}`,
            success: ScoreActivityResult,
            error: ClassificationFailed,
            execute: classifier.score({ submissionId: key, organizationId, classifier: provider }),
          }),
        );
        yield* recordMetric(
          classificationAttemptsMetric,
          {
            classifier: provider,
            stage: "primary",
            outcome: score._tag === "Success" ? "ok" : "error",
          },
          score.attempts,
        );
        if (score._tag === "Success") {
          const { signals, ...scores } = score.success;
          const result = {
            _tag: "Scored",
            classifier: provider,
            scores,
            ...(signals !== undefined && { signals }),
            policy,
            attempts: score.attempts,
          } as const;
          if (
            policy.escalation === true &&
            escalationClassifier !== undefined &&
            escalationClassifier !== provider &&
            reviewReason(scores, policy) === "ambiguous"
          ) {
            const escalation = yield* secondEvaluation(key, organizationId, escalationClassifier);
            const decision = classificationDecision(scores, policy, escalation);
            const outcome = decision.reason === null ? "accepted" : "quarantined";
            if ("scores" in escalation && escalation.scores !== undefined) {
              yield* recordMetric(classificationEscalationsMetric, {
                classifier: escalationClassifier,
                outcome: decision.reason === "ambiguous" ? "confirmed" : "cleared",
              });
            }
            yield* recordMetric(classificationRunsMetric, {
              classifier: provider,
              outcome,
              reason: decision.reason ?? "none",
            });
            yield* Effect.annotateCurrentSpan({
              "classification.outcome": outcome,
              "classification.reason": decision.reason ?? "none",
              "classification.attempts": score.attempts,
              "classification.escalated": true,
              "classification.escalationClassifier": escalationClassifier,
            });
            yield* Effect.logInfo("Classification completed with escalation", {
              submissionId: key,
              organizationId,
              classifier: provider,
              escalationClassifier,
              outcome,
              reason: decision.reason,
              attempts: score.attempts,
            });
            yield* Activity.make({
              name: "record-escalated-classification",
              execute: submissions
                .send(key, RecordClassification.make({ result: { ...result, escalation } }))
                .pipe(Effect.asVoid),
            });
            return;
          }
          const decision = classificationDecision(scores, policy);
          const outcome = decision.reason === null ? "accepted" : "quarantined";
          yield* recordMetric(classificationRunsMetric, {
            classifier: provider,
            outcome,
            reason: decision.reason ?? "none",
          });
          yield* Effect.annotateCurrentSpan({
            "classification.outcome": outcome,
            "classification.reason": decision.reason ?? "none",
            "classification.attempts": score.attempts,
            "classification.escalated": false,
          });
          yield* Effect.logInfo("Classification completed", {
            submissionId: key,
            organizationId,
            classifier: provider,
            outcome,
            reason: decision.reason,
            attempts: score.attempts,
          });
          yield* Activity.make({
            name: "record-classification",
            execute: submissions
              .send(key, RecordClassification.make({ result }))
              .pipe(Effect.asVoid),
          });
          return;
        }
        const failure = toFailure(
          score.failure,
          score.attempts,
          score.failure.retryable ? "upstream-error" : "invalid-response",
        );
        yield* recordMetric(classificationRunsMetric, {
          classifier: provider,
          outcome: "error",
          reason: failure.kind,
        });
        yield* Effect.annotateCurrentSpan({
          "classification.outcome": "error",
          "classification.failureKind": failure.kind,
          "classification.attempts": score.attempts,
          "classification.retryable": failure.retryable,
        });
        yield* Effect.logWarning("Classification failed and submission quarantined", {
          submissionId: key,
          organizationId,
          classifier: provider,
          kind: failure.kind,
          retryable: failure.retryable,
          attempts: score.attempts,
          ...(failure.upstreamCode !== undefined && { upstreamCode: failure.upstreamCode }),
        });
        yield* Activity.make({
          name: "record-classification-error",
          execute: submissions
            .send(
              key,
              RecordClassification.make({
                result: {
                  _tag: "ClassificationError",
                  classifier: provider,
                  policy,
                  failure,
                },
              }),
            )
            .pipe(Effect.asVoid),
        });
        return;
      }

      const failure = toFailure(
        resolved.failure,
        resolved.attempts,
        resolved.failure.retryable ? "policy-unavailable" : "policy-unreadable",
      );
      yield* recordMetric(classificationRunsMetric, {
        classifier: "unknown",
        outcome: "error",
        reason: failure.kind,
      });
      yield* Effect.annotateCurrentSpan({
        "classification.outcome": "error",
        "classification.failureKind": failure.kind,
        "classification.attempts": resolved.attempts,
      });
      yield* Effect.logWarning("Classification policy lookup failed and submission quarantined", {
        submissionId: key,
        organizationId,
        kind: failure.kind,
        retryable: failure.retryable,
        attempts: resolved.attempts,
      });
      yield* Activity.make({
        name: "record-classification-error",
        execute: submissions
          .send(
            key,
            RecordClassification.make({ result: { _tag: "ClassificationError", failure } }),
          )
          .pipe(Effect.asVoid),
      });
    });
  }),
);
