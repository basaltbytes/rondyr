import { Schema } from "effect";

import {
  ClassificationPolicy,
  ClassifierProvider,
  defaultClassificationPolicies,
} from "./classification-policy.ts";
import {
  ClassificationFailure,
  ClassificationScores,
  ClassificationSignals,
  EscalationEvaluation,
  IntakeReason,
  QuarantineReason,
  SubmissionLabel,
  isOffTopic,
  reviewReason,
} from "./classification.ts";
import { ApiTokenId, UserId } from "./submission.id.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const IntakeChannel = Schema.Literals(["public", "server"]);
export type IntakeChannel = typeof IntakeChannel.Type;

export const OriginCheck = Schema.Union([
  Schema.TaggedStruct("Passed", {
    mode: Schema.Literals(["listed", "unrestricted"]),
    hasOrigin: Schema.Boolean,
  }),
  Schema.TaggedStruct("Skipped", {
    reason: Schema.Literal("server-intake"),
  }),
]);
export type OriginCheck = typeof OriginCheck.Type;

export const HoneypotCheck = Schema.Union([
  Schema.TaggedStruct("NotConfigured", {}),
  Schema.TaggedStruct("Passed", { field: Schema.String }),
  Schema.TaggedStruct("Failed", { field: Schema.String }),
]);
export type HoneypotCheck = typeof HoneypotCheck.Type;

export const TurnstileFailureCause = Schema.Literals(["missing-token", "rejected", "key-changed"]);
export type TurnstileFailureCause = typeof TurnstileFailureCause.Type;

export const TurnstileCheck = Schema.Union([
  Schema.TaggedStruct("NotConfigured", {}),
  Schema.TaggedStruct("Skipped", { reason: Schema.Literal("server-intake") }),
  Schema.TaggedStruct("Passed", {}),
  Schema.TaggedStruct("Unavailable", { source: Schema.Literals(["secret", "siteverify"]) }),
  Schema.TaggedStruct("Failed", {
    cause: TurnstileFailureCause,
    errorCodes: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);
export type TurnstileCheck = typeof TurnstileCheck.Type;

export const RepetitionCheck = Schema.Struct({
  outcome: Schema.Literals(["passed", "failed"]),
  priorSameSender: NonNegativeInt,
  priorSameContent: NonNegativeInt,
  senderThreshold: PositiveInt,
  contentThreshold: PositiveInt,
  windowDays: PositiveInt,
});
export type RepetitionCheck = typeof RepetitionCheck.Type;

export const BlockedTermCheck = Schema.Union([
  Schema.TaggedStruct("NotConfigured", {}),
  Schema.TaggedStruct("Passed", {}),
  Schema.TaggedStruct("Failed", {
    term: Schema.String,
    scope: Schema.Literals(["form", "organization"]),
  }),
]);
export type BlockedTermCheck = typeof BlockedTermCheck.Type;

export const QuotaCheck = Schema.Union([
  Schema.TaggedStruct("Passed", { used: NonNegativeInt, limit: NonNegativeInt }),
  Schema.TaggedStruct("Failed", { used: NonNegativeInt, limit: NonNegativeInt }),
  Schema.TaggedStruct("Skipped", { reason: Schema.Literal("quarantined-earlier") }),
]);
export type QuotaCheck = typeof QuotaCheck.Type;

/** Exact intake checks recorded atomically when a submission is persisted. */
export const IntakeVerification = Schema.Struct({
  channel: IntakeChannel,
  origin: OriginCheck,
  honeypot: HoneypotCheck,
  turnstile: TurnstileCheck,
  repetition: RepetitionCheck,
  blockedTerm: BlockedTermCheck,
  quota: QuotaCheck,
  decisiveReason: Schema.NullOr(IntakeReason),
});
export type IntakeVerification = typeof IntakeVerification.Type;

/** Resolved identity of the person or API token that acted on a submission. */
export const EventActor = Schema.Union([
  Schema.TaggedStruct("Reviewer", {
    userId: UserId,
    name: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("ApiToken", {
    apiTokenId: ApiTokenId,
    name: Schema.NullOr(Schema.String),
    suffix: Schema.NullOr(Schema.String),
  }),
]);
export type EventActor = typeof EventActor.Type;

export const SubmissionEventDetail = Schema.Union([
  Schema.TaggedStruct("ClassificationRequested", {}),
  Schema.TaggedStruct("ReclassificationRequested", {
    actor: Schema.optionalKey(EventActor),
  }),
  Schema.TaggedStruct("SubmissionQuarantined", {
    reason: QuarantineReason,
    rulesVersion: Schema.Int,
    classifier: Schema.optionalKey(ClassifierProvider),
    scores: Schema.optionalKey(ClassificationScores),
    signals: Schema.optionalKey(ClassificationSignals),
    policy: Schema.optionalKey(ClassificationPolicy),
    escalation: Schema.optionalKey(EscalationEvaluation),
    attempts: Schema.optionalKey(PositiveInt),
    failure: Schema.optionalKey(ClassificationFailure),
  }),
  Schema.TaggedStruct("SubmissionAccepted", {
    mode: Schema.Literals(["automatic", "manual"]),
    rulesVersion: Schema.optionalKey(Schema.Int),
    classifier: Schema.optionalKey(ClassifierProvider),
    scores: Schema.optionalKey(ClassificationScores),
    signals: Schema.optionalKey(ClassificationSignals),
    policy: Schema.optionalKey(ClassificationPolicy),
    escalation: Schema.optionalKey(EscalationEvaluation),
    attempts: Schema.optionalKey(PositiveInt),
    label: Schema.optionalKey(SubmissionLabel),
    actor: Schema.optionalKey(EventActor),
  }),
  Schema.TaggedStruct("SubmissionDismissed", {
    actor: Schema.optionalKey(EventActor),
  }),
]);
export type SubmissionEventDetail = typeof SubmissionEventDetail.Type;

export const SubmissionTimelineEvent = Schema.Struct({
  seq: Schema.Int,
  occurredAt: Schema.Int,
  detail: SubmissionEventDetail,
});
export type SubmissionTimelineEvent = typeof SubmissionTimelineEvent.Type;

export const OutboxSnapshot = Schema.Struct({
  publishedAt: Schema.NullOr(Schema.Int),
  handedOffAt: Schema.NullOr(Schema.Int),
  publicationCount: NonNegativeInt,
  stuckAt: Schema.NullOr(Schema.Int),
});
export type OutboxSnapshot = typeof OutboxSnapshot.Type;

/** Complete verification record returned on submission detail reads. */
export const SubmissionVerification = Schema.Struct({
  intake: Schema.NullOr(IntakeVerification),
  intakeReason: Schema.NullOr(IntakeReason),
  priorSameSender: NonNegativeInt,
  priorSameContent: NonNegativeInt,
  intakeTraceId: Schema.NullOr(Schema.String),
  outbox: Schema.NullOr(OutboxSnapshot),
  events: Schema.Array(SubmissionTimelineEvent),
});
export type SubmissionVerification = typeof SubmissionVerification.Type;

/**
 * Result of a read-only dry-run screening of an existing submission against
 * the form's and organization's current saved rules and classification policy.
 */
export const ScreeningPreview = Schema.Struct({
  outcome: Schema.Literals(["accepted", "quarantined", "error"]),
  reason: Schema.NullOr(QuarantineReason),
  label: Schema.NullOr(SubmissionLabel),
  blockedTerm: BlockedTermCheck,
  classifier: Schema.optionalKey(ClassifierProvider),
  policy: Schema.optionalKey(ClassificationPolicy),
  scores: Schema.optionalKey(ClassificationScores),
  signals: Schema.optionalKey(ClassificationSignals),
  escalation: Schema.optionalKey(EscalationEvaluation),
  failure: Schema.optionalKey(ClassificationFailure),
  rulesVersion: Schema.Int,
  traceId: Schema.NullOr(Schema.String),
  evaluatedAt: Schema.Int,
});
export type ScreeningPreview = typeof ScreeningPreview.Type;

export type SpamCheckStatus = "passed" | "ambiguous" | "cleared" | "failed";
export type SolicitationCheckStatus = "passed" | "failed" | "not-evaluated";
export type RelevanceCheckStatus = "passed" | "failed" | "flagged" | "not-configured";

export interface EvaluatedSpamCheck {
  readonly score: number;
  readonly ambiguousThreshold: number;
  readonly probableSpamThreshold: number;
  readonly status: SpamCheckStatus;
  readonly decisive: boolean;
}

export interface EvaluatedSolicitationCheck {
  readonly score: number | null;
  readonly threshold: number;
  readonly status: SolicitationCheckStatus;
  readonly decisive: boolean;
}

export interface EvaluatedRelevanceCheck {
  readonly score: number | null;
  readonly threshold: number;
  readonly offTopicMode: ClassificationPolicy["offTopic"];
  readonly status: RelevanceCheckStatus;
  readonly decisive: boolean;
}

export type EvaluatedEscalation =
  | {
      readonly status: "cleared";
      readonly classifier: ClassifierProvider;
      readonly scores: typeof ClassificationScores.Type;
      readonly policy: ClassificationPolicy;
      readonly attempts: number | undefined;
    }
  | {
      readonly status: "confirmed";
      readonly classifier: ClassifierProvider;
      readonly scores: typeof ClassificationScores.Type;
      readonly policy: ClassificationPolicy;
      readonly reason: Exclude<ReturnType<typeof reviewReason>, null>;
      readonly attempts: number | undefined;
    }
  | {
      readonly status: "skipped-quota";
      readonly classifier: ClassifierProvider;
    }
  | {
      readonly status: "failed";
      readonly classifier: ClassifierProvider;
      readonly failure: ClassificationFailure | undefined;
      readonly attempts: number | undefined;
    };

export interface EvaluatedClassification {
  readonly spam: EvaluatedSpamCheck;
  readonly escalation: EvaluatedEscalation | null;
  readonly solicitation: EvaluatedSolicitationCheck;
  readonly relevance: EvaluatedRelevanceCheck;
}

/**
 * Derive each rule's pass/fail status from a recorded classification decision.
 * Uses the policy snapshot stored with the decision, or falls back to the
 * classifier's defaults for events recorded before policies were persisted.
 */
export function evaluateClassificationChecks(
  scores: typeof ClassificationScores.Type,
  recordedPolicy: ClassificationPolicy | undefined,
  classifier: ClassifierProvider | undefined,
  escalation: typeof EscalationEvaluation.Type | undefined,
  decisiveReason: typeof QuarantineReason.Type | null,
): EvaluatedClassification {
  const policy = recordedPolicy ?? defaultClassificationPolicies[classifier ?? "jev"];
  const { thresholds } = policy;

  let evaluatedEscalation: EvaluatedEscalation | null = null;
  let escalationCleared = false;
  if (escalation !== undefined) {
    const secondPolicy: ClassificationPolicy = {
      ...defaultClassificationPolicies[escalation.classifier],
      offTopic: policy.offTopic,
    };
    if (escalation.skipped === "quota") {
      evaluatedEscalation = { status: "skipped-quota", classifier: escalation.classifier };
    } else if (escalation.scores === undefined) {
      evaluatedEscalation = {
        status: "failed",
        classifier: escalation.classifier,
        failure: escalation.failure,
        attempts: escalation.attempts ?? escalation.failure?.attempts,
      };
    } else {
      const secondReason = reviewReason(escalation.scores, secondPolicy);
      if (secondReason === null) {
        escalationCleared = true;
        evaluatedEscalation = {
          status: "cleared",
          classifier: escalation.classifier,
          scores: escalation.scores,
          policy: secondPolicy,
          attempts: escalation.attempts,
        };
      } else {
        evaluatedEscalation = {
          status: "confirmed",
          classifier: escalation.classifier,
          scores: escalation.scores,
          policy: secondPolicy,
          reason: secondReason,
          attempts: escalation.attempts,
        };
      }
    }
  }

  const spamStatus: SpamCheckStatus =
    scores.spam >= thresholds.probableSpam
      ? "failed"
      : scores.spam >= thresholds.ambiguous
        ? escalationCleared
          ? "cleared"
          : "ambiguous"
        : "passed";

  const solicitationStatus: SolicitationCheckStatus =
    scores.solicitation === undefined
      ? "not-evaluated"
      : scores.solicitation > thresholds.solicitation
        ? "failed"
        : "passed";

  const offTopic = isOffTopic(scores, policy);
  const relevanceStatus: RelevanceCheckStatus =
    scores.relevance === undefined
      ? "not-configured"
      : offTopic
        ? policy.offTopic === "review"
          ? "failed"
          : "flagged"
        : "passed";

  return {
    spam: {
      score: scores.spam,
      ambiguousThreshold: thresholds.ambiguous,
      probableSpamThreshold: thresholds.probableSpam,
      status: spamStatus,
      decisive: decisiveReason === "probable-spam" || decisiveReason === "ambiguous",
    },
    escalation: evaluatedEscalation,
    solicitation: {
      score: scores.solicitation ?? null,
      threshold: thresholds.solicitation,
      status: solicitationStatus,
      decisive: decisiveReason === "solicitation",
    },
    relevance: {
      score: scores.relevance ?? null,
      threshold: thresholds.lowRelevance,
      offTopicMode: policy.offTopic,
      status: relevanceStatus,
      decisive: decisiveReason === "low-relevance",
    },
  };
}
