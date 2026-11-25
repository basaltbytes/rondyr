import { Clock, Effect, Layer } from "effect";

import { findMatchedBlockedTerm } from "../../../domain/forms/blocked-term.ts";
import type { ClassifierProvider } from "../../../domain/submissions/classification-policy.ts";
import {
  classificationDecision,
  reviewReason,
  rulesVersion,
  type ClassificationFailure,
  type ClassificationFailureKind,
  type EscalationEvaluation,
} from "../../../domain/submissions/classification.ts";
import {
  classifierInput,
  type ClassifierInput,
} from "../../../domain/submissions/classifier-input.ts";
import { ClassificationFailed } from "../../../domain/submissions/classifier.external.ts";
import {
  classificationDurationMetric,
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
import { scoreWithJev } from "./jev.ts";
import { scoreWithOpenAi } from "./openai-decisions.ts";

const providers = { jev: scoreWithJev, openai: scoreWithOpenAi };

function toFailure(
  error: ClassificationFailed,
  fallback: ClassificationFailureKind,
): ClassificationFailure {
  return {
    kind: error.kind ?? fallback,
    retryable: error.retryable,
    attempts: 1,
    ...(error.upstreamCode !== undefined && { upstreamCode: error.upstreamCode }),
  };
}

const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => null),
);

const scoreOnce = Effect.fn("ScreeningPreview.score")(function* (
  classifier: ClassifierProvider,
  input: ClassifierInput,
) {
  yield* Effect.annotateCurrentSpan({ "screening.classifier": classifier });
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  if (env.AI === undefined) {
    yield* Effect.annotateCurrentSpan({ "screening.failureKind": "missing-ai-binding" });
    return yield* ClassificationFailed.make({ retryable: false, kind: "missing-ai-binding" });
  }
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* providers[classifier](env.AI, input).pipe(
    Effect.timeoutOrElse({
      duration: "12 seconds",
      orElse: () => Effect.fail(ClassificationFailed.make({ retryable: true, kind: "timeout" })),
    }),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({
        "screening.failureKind": error.kind ?? "upstream-error",
        "screening.retryable": error.retryable,
        ...(error.upstreamCode !== undefined && {
          "screening.upstreamCode": error.upstreamCode,
        }),
      }),
    ),
    Effect.ensuring(
      Effect.flatMap(Clock.currentTimeMillis, (finishedAt) =>
        recordMetric(
          classificationDurationMetric,
          { classifier, mode: "preview" },
          Math.max(0, finishedAt - startedAt),
        ),
      ),
    ),
  );
});

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

      if ("_tag" in resolved) {
        const evaluatedAt = yield* Clock.currentTimeMillis;
        const traceId = yield* currentTraceId;
        yield* Effect.annotateCurrentSpan({
          "screening.outcome": "error",
          "screening.failureKind": resolved.failure.kind,
        });
        yield* recordMetric(screeningPreviewsMetric, {
          classifier: "unknown",
          outcome: "error",
          reason: resolved.failure.kind,
        });
        yield* Effect.logWarning("Screening preview failed to resolve policy", {
          submissionId,
          organizationId,
          kind: resolved.failure.kind,
        });
        return {
          outcome: "error",
          reason: "classification-error",
          label: null,
          blockedTerm,
          failure: resolved.failure,
          rulesVersion,
          traceId,
          evaluatedAt,
        } satisfies ScreeningPreview;
      }

      const { classifier: provider, policy, escalationClassifier } = resolved;
      const reservation = yield* quotas.reserveClassification(organizationId);
      if (reservation === "limit-reached") {
        yield* Effect.annotateCurrentSpan({
          "screening.classifier": provider,
          "screening.outcome": "quota-reached",
        });
        yield* recordMetric(screeningPreviewsMetric, {
          classifier: provider,
          outcome: "quota-reached",
          reason: "quota",
        });
        return yield* ScreeningQuotaReached.make();
      }

      const input = classifierInput(
        message.fields,
        message.businessContext,
        message.repetition,
        message.organizationDomains,
      );
      const signals = {
        hasBusinessContext: input.business_context !== "",
        urlOrHtmlOutsideLongestField: input.facts.url_or_html_outside_longest_field,
        senderMatchesOrganizationDomain: input.facts.sender_matches_organization_domain === true,
      };
      yield* Effect.annotateCurrentSpan({
        "screening.classifier": provider,
        "screening.hasBusinessContext": signals.hasBusinessContext,
        "screening.urlOrHtmlOutsideLongestField": signals.urlOrHtmlOutsideLongestField,
        "screening.senderMatchesOrganizationDomain": signals.senderMatchesOrganizationDomain,
      });

      const primary = yield* scoreOnce(provider, input).pipe(Effect.result);
      if (primary._tag === "Failure") {
        const failure = toFailure(
          primary.failure,
          primary.failure.retryable ? "upstream-error" : "invalid-response",
        );
        const evaluatedAt = yield* Clock.currentTimeMillis;
        const traceId = yield* currentTraceId;
        yield* Effect.annotateCurrentSpan({
          "screening.outcome": "error",
          "screening.failureKind": failure.kind,
        });
        yield* recordMetric(screeningPreviewsMetric, {
          classifier: provider,
          outcome: "error",
          reason: failure.kind,
        });
        yield* Effect.logWarning("Screening preview failed", {
          submissionId,
          organizationId,
          classifier: provider,
          kind: failure.kind,
          retryable: failure.retryable,
          ...(failure.upstreamCode !== undefined && { upstreamCode: failure.upstreamCode }),
        });
        return {
          outcome: "error",
          reason: "classification-error",
          label: null,
          blockedTerm,
          classifier: provider,
          policy,
          signals,
          failure,
          rulesVersion,
          traceId,
          evaluatedAt,
        } satisfies ScreeningPreview;
      }

      const scores = primary.success;
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
          const secondary = yield* scoreOnce(escalationClassifier, input).pipe(Effect.result);
          escalation =
            secondary._tag === "Success"
              ? {
                  classifier: escalationClassifier,
                  rulesVersion,
                  scores: secondary.success,
                  attempts: 1,
                }
              : {
                  classifier: escalationClassifier,
                  rulesVersion,
                  attempts: 1,
                  failure: toFailure(
                    secondary.failure,
                    secondary.failure.retryable ? "upstream-error" : "invalid-response",
                  ),
                };
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
