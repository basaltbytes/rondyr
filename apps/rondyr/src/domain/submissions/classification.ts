import { Schema } from "effect";

import {
  type ClassificationPolicy,
  ClassifierProvider,
  defaultClassificationPolicies,
  Score,
} from "./classification-policy.ts";

export const ClassificationScores = Schema.Struct({
  model: Schema.String,
  spam: Score,
  // Decisions and durable activities recorded before this question have no score.
  solicitation: Schema.optionalKey(Score),
  relevance: Schema.optionalKey(Score),
});

export const ClassifierScores = Schema.Struct({
  ...ClassificationScores.fields,
  solicitation: Score,
});

/**
 * The second evaluation of an ambiguous submission. Without `scores`, the
 * second model was not called or did not answer; `skipped: "quota"` says that
 * the organization's daily classification limit stopped the call.
 */
export const EscalationEvaluation = Schema.Struct({
  classifier: ClassifierProvider,
  rulesVersion: Schema.Int,
  scores: Schema.optionalKey(ClassificationScores),
  skipped: Schema.optionalKey(Schema.Literal("quota")),
}).check(
  Schema.makeFilter(
    ({ scores, skipped }) =>
      scores === undefined || skipped === undefined || "A skipped evaluation has no scores.",
  ),
);

/** Why the classification rules quarantine a submission. */
export const ClassificationReason = Schema.Literals([
  "probable-spam",
  "ambiguous",
  "solicitation",
  "low-relevance",
  "classification-error",
]);

/**
 * Why intake quarantines a submission before any classifier runs. Intake
 * records the reason with the submission, in the same transaction, so every
 * hand-off of the submission carries the same reason.
 */
export const IntakeReason = Schema.Literals([
  "honeypot",
  "repetition",
  "turnstile-failed",
  "quota",
]);
export type IntakeReason = typeof IntakeReason.Type;

/** Why a submission is quarantined: a classification rule or an intake check. */
export const QuarantineReason = Schema.Literals([
  ...ClassificationReason.literals,
  ...IntakeReason.literals,
]);

export const SubmissionLabel = Schema.Literal("off-topic");

export const rulesVersion = 7;

type Scores = typeof ClassificationScores.Type;
type AnsweredScores = typeof ClassifierScores.Type;

export function isOffTopic(scores: Scores, policy: ClassificationPolicy) {
  return scores.relevance !== undefined && scores.relevance < policy.thresholds.lowRelevance;
}

/** Scores recorded before the solicitation question cannot be decided by the current rules. */
function isAnswered(scores: Scores): scores is AnsweredScores {
  return scores.solicitation !== undefined;
}

function spamReason(scores: Scores, { thresholds }: ClassificationPolicy) {
  if (scores.spam >= thresholds.probableSpam) return "probable-spam";
  if (scores.spam >= thresholds.ambiguous) return "ambiguous";
  return null;
}

/** The rules that follow the spam rules: sales outreach, then low relevance. */
function contentReason(scores: AnsweredScores, policy: ClassificationPolicy) {
  if (scores.solicitation > policy.thresholds.solicitation) return "solicitation";
  if (policy.offTopic === "review" && isOffTopic(scores, policy)) return "low-relevance";
  return null;
}

export function reviewReason(scores: Scores, policy: ClassificationPolicy) {
  if (!isAnswered(scores)) return "classification-error";
  return spamReason(scores, policy) ?? contentReason(scores, policy);
}

type Acceptance = { readonly reason: null; readonly label?: typeof SubmissionLabel.Type };

type ClassificationDecision = { readonly reason: typeof ClassificationReason.Type } | Acceptance;

type EscalatedDecision =
  | { readonly reason: "ambiguous" | "solicitation" | "low-relevance" }
  | Acceptance;

type SecondEvaluation = Pick<typeof EscalationEvaluation.Type, "classifier" | "scores">;

function acceptance(offTopic: boolean): Acceptance {
  return offTopic ? { reason: null, label: "off-topic" } : { reason: null };
}

/**
 * The decision for first scores in the ambiguous spam band, given the second
 * model's evaluation, or `undefined` when the first scores leave no spam doubt.
 * The second model settles the spam doubt only. It uses its default thresholds
 * and the organization's off-topic choice. When it finds no reason of its own,
 * the first model's remaining rules still apply to the first model's scores,
 * and either model can give the off-topic label. When it finds a reason or
 * fails, the submission stays in review as `ambiguous`.
 */
export function escalatedDecision(
  first: Scores,
  policy: ClassificationPolicy,
  escalation: SecondEvaluation,
): EscalatedDecision | undefined {
  if (!isAnswered(first) || spamReason(first, policy) !== "ambiguous") return undefined;
  const second = escalation.scores;
  const secondPolicy = {
    ...defaultClassificationPolicies[escalation.classifier],
    offTopic: policy.offTopic,
  };
  if (second === undefined || reviewReason(second, secondPolicy) !== null) {
    return { reason: "ambiguous" };
  }
  const reason = contentReason(first, policy);
  if (reason !== null) return { reason };
  return acceptance(isOffTopic(first, policy) || isOffTopic(second, secondPolicy));
}

export function classificationDecision(
  scores: Scores,
  policy: ClassificationPolicy,
  escalation?: SecondEvaluation,
): ClassificationDecision {
  const escalated =
    escalation === undefined ? undefined : escalatedDecision(scores, policy, escalation);
  if (escalated !== undefined) return escalated;
  const reason = reviewReason(scores, policy);
  if (reason !== null) return { reason };
  return acceptance(isOffTopic(scores, policy));
}
