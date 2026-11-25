import { Clock, Effect, Layer } from "effect";

import { findMatchedBlockedTerm } from "../../../domain/forms/blocked-term.ts";
import {
  classificationDecision,
  reviewReason,
  rulesVersion,
  type ClassificationFailure,
  type EscalationEvaluation,
} from "../../../domain/submissions/classification.ts";
import { classifierInput } from "../../../domain/submissions/classifier-input.ts";
import type { ClassificationFailed } from "../../../domain/submissions/classifier.external.ts";
import {
  recordMetric,
  screeningPreviewsMetric,
} from "../../../domain/submissions/submission-metrics.ts";
import type {
  BlockedTermCheck,
  ScreeningPreview,
} from "../../../domain/submissions/verification.ts";
import type { OrganizationId, SubmissionId } from "../../../domain/submissions/submission.id.ts";
import { ClassificationPolicies } from "../../ports/classification-policies.ts";
import { OrganizationQuotas } from "../../ports/organization-quotas.ts";
import { StoredMessages } from "../../ports/stored-messages.ts";
import { ScreeningQuotaReached, SubmissionScreening } from "../../ports/submission-screening.ts";
import { classifierSignals, scoreMessage, workersAi } from "./scoring.ts";

function toFailure(error: ClassificationFailed): ClassificationFailure {
  return {
    kind: error.kind ?? (error.retryable ? "upstream-error" : "invalid-response"),
    retryable: error.retryable,
    attempts: 1,
    ...(error.upstreamCode !== undefined && { upstreamCode: error.upstreamCode }),
  };
}

const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => null),
);

export const submissionScreeningLive = Layer.effect(
  SubmissionScreening,
  Effect.gen(function* () {
    const messages = yield* StoredMessages;
    const policies = yield* ClassificationPolicies;
    const quotas = yield* OrganizationQuotas;

    const preview = Effect.fn("ScreeningPreview.run")(function* (
      submissionId: SubmissionId,
      organizationId: OrganizationId,
    ) {
      yield* Effect.annotateCurrentSpan({ submissionId, organizationId });
      const message = yield* messages.readForScreening(submissionId, organizationId);

      const formMatch = findMatchedBlockedTerm(message.fields, message.formBlockedTerms);
      const orgMatch =
        formMatch === null
          ? findMatchedBlockedTerm(message.fields, message.organizationBlockedTerms)
          : null;
      const blockedTerm: BlockedTermCheck =
        formMatch !== null
          ? { _tag: "Failed", term: formMatch, scope: "form" }
          : orgMatch !== null
            ? { _tag: "Failed", term: orgMatch, scope: "organization" }
            : message.formBlockedTerms.length > 0 || message.organizationBlockedTerms.length > 0
              ? { _tag: "Passed" }
              : { _tag: "NotConfigured" };

      if (blockedTerm._tag === "Failed") {
        const evaluatedAt = yield* Clock.currentTimeMillis;
        const traceId = yield* currentTraceId;
        yield* Effect.annotateCurrentSpan({
          "screening.outcome": "quarantined",
          "screening.reason": "blocked-term",
          "screening.blockedTermScope": blockedTerm.scope,
        });
        yield* recordMetric(screeningPreviewsMetric, {
          classifier: "none",
          outcome: "quarantined",
          reason: "blocked-term",
        });
        yield* Effect.logInfo("Screening preview completed", {
          submissionId,
          organizationId,
          outcome: "quarantined",
          reason: "blocked-term",
          blockedTermScope: blockedTerm.scope,
        });
        return {
          outcome: "quarantined",
          reason: "blocked-term",
          label: null,
          blockedTerm,
          rulesVersion,
          traceId,
          evaluatedAt,
        } satisfies ScreeningPreview;
      }

      const failedPreview = Effect.fnUntraced(function* (
        failure: ClassificationFailure,
        context: Pick<ScreeningPreview, "classifier" | "policy" | "signals">,
      ) {
        const evaluatedAt = yield* Clock.currentTimeMillis;
        const traceId = yield* currentTraceId;
        yield* Effect.annotateCurrentSpan({
          "screening.outcome": "error",
          "screening.failureKind": failure.kind,
        });
        yield* recordMetric(screeningPreviewsMetric, {
          classifier: context.classifier ?? "unknown",
          outcome: "error",
          reason: failure.kind,
        });
        yield* Effect.logWarning("Screening preview failed", {
          submissionId,
          organizationId,
          ...(context.classifier !== undefined && { classifier: context.classifier }),
          kind: failure.kind,
          retryable: failure.retryable,
          ...(failure.upstreamCode !== undefined && { upstreamCode: failure.upstreamCode }),
        });
        return {
          outcome: "error",
          reason: "classification-error",
          label: null,
          blockedTerm,
          ...context,
          failure,
          rulesVersion,
          traceId,
          evaluatedAt,
        } satisfies ScreeningPreview;
      });

      const resolved = yield* policies.resolve(organizationId).pipe(
        Effect.catchTags({
          StorageUnavailable: () =>
            Effect.succeed({
              _tag: "PolicyError" as const,
              failure: {
                kind: "policy-unavailable" as const,
                retryable: true,
                attempts: 1,
              },
            }),
          ClassificationPolicyUnreadable: () =>
            Effect.succeed({
              _tag: "PolicyError" as const,
              failure: {
                kind: "policy-unreadable" as const,
                retryable: false,
                attempts: 1,
              },
            }),
        }),
      );

      if ("_tag" in resolved) return yield* failedPreview(resolved.failure, {});

      const { classifier: provider, policy, escalationClassifier } = resolved;
      const input = classifierInput(
        message.fields,
        message.businessContext,
        message.repetition,
        message.organizationDomains,
      );
      const signals = classifierSignals(input);
      yield* Effect.annotateCurrentSpan({ "screening.classifier": provider });
      // Without Workers AI the preview cannot score: say so before spending a classification.
      const ai = yield* Effect.result(workersAi);
      if (ai._tag === "Failure") {
        return yield* failedPreview(toFailure(ai.failure), {
          classifier: provider,
          policy,
          signals,
        });
      }
      const reservation = yield* quotas.reserveClassification(organizationId);
      if (reservation === "limit-reached") {
        yield* Effect.annotateCurrentSpan({ "screening.outcome": "quota-reached" });
        yield* recordMetric(screeningPreviewsMetric, {
          classifier: provider,
          outcome: "quota-reached",
          reason: "quota",
        });
        return yield* ScreeningQuotaReached.make();
      }

      const primary = yield* Effect.result(scoreMessage(ai.success, provider, input, "preview"));
      if (primary._tag === "Failure") {
        return yield* failedPreview(toFailure(primary.failure), {
          classifier: provider,
          policy,
          signals,
        });
      }

      const { signals: _primarySignals, ...scores } = primary.success;
      let escalation: typeof EscalationEvaluation.Type | undefined;
      if (
        policy.escalation === true &&
        escalationClassifier !== undefined &&
        escalationClassifier !== provider &&
        reviewReason(scores, policy) === "ambiguous"
      ) {
        const escalationReservation = yield* quotas
          .reserveClassification(organizationId)
          .pipe(
            Effect.catchTag("StorageUnavailable", () => Effect.succeed("unavailable" as const)),
          );
        if (escalationReservation === "unavailable") {
          escalation = {
            classifier: escalationClassifier,
            rulesVersion,
            failure: { kind: "reservation-unavailable", retryable: true, attempts: 1 },
          };
        } else if (escalationReservation === "limit-reached") {
          escalation = {
            classifier: escalationClassifier,
            rulesVersion,
            skipped: "quota",
          };
        } else {
          const secondary = yield* Effect.result(
            scoreMessage(ai.success, escalationClassifier, input, "preview"),
          );
          if (secondary._tag === "Success") {
            const { signals: _secondarySignals, ...secondScores } = secondary.success;
            escalation = {
              classifier: escalationClassifier,
              rulesVersion,
              scores: secondScores,
              attempts: 1,
            };
          } else {
            escalation = {
              classifier: escalationClassifier,
              rulesVersion,
              attempts: 1,
              failure: toFailure(secondary.failure),
            };
          }
        }
      }

      const decision = classificationDecision(scores, policy, escalation);
      const outcome = decision.reason === null ? "accepted" : "quarantined";
      const evaluatedAt = yield* Clock.currentTimeMillis;
      const traceId = yield* currentTraceId;
      yield* Effect.annotateCurrentSpan({
        "screening.outcome": outcome,
        "screening.reason": decision.reason ?? "none",
        "screening.escalated": escalation !== undefined,
      });
      yield* recordMetric(screeningPreviewsMetric, {
        classifier: provider,
        outcome,
        reason: decision.reason ?? "none",
      });
      yield* Effect.logInfo("Screening preview completed", {
        submissionId,
        organizationId,
        classifier: provider,
        outcome,
        reason: decision.reason,
        escalated: escalation !== undefined,
      });
      return {
        outcome,
        reason: decision.reason,
        label: decision.reason === null ? (decision.label ?? null) : null,
        blockedTerm,
        classifier: provider,
        policy,
        scores,
        signals,
        ...(escalation !== undefined && { escalation }),
        rulesVersion,
        traceId,
        evaluatedAt,
      } satisfies ScreeningPreview;
    });

    return { preview };
  }),
);
