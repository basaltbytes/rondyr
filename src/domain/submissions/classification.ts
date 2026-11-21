import { Schema } from "effect";

import { ClassificationPolicy, Score } from "./classification-policy.ts";

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
 * `honeypot`: the form's honeypot field has a value.
 * `repetition`: intake counted enough recent submissions from the same sender or with the same content.
 */
export const IntakeReason = Schema.Literals(["honeypot", "repetition"]);
export type IntakeReason = typeof IntakeReason.Type;

/** Why a submission is quarantined: a classification rule or an intake check. */
export const QuarantineReason = Schema.Literals([
  ...ClassificationReason.literals,
  ...IntakeReason.literals,
]);

export const SubmissionLabel = Schema.Literal("off-topic");

export const rulesVersion = 6;

export function isOffTopic(scores: typeof ClassificationScores.Type, policy: ClassificationPolicy) {
  return scores.relevance !== undefined && scores.relevance < policy.thresholds.lowRelevance;
}

export function reviewReason(
  scores: typeof ClassificationScores.Type,
  policy: ClassificationPolicy,
) {
  const { thresholds } = policy;
  if (scores.solicitation === undefined) return "classification-error";
  if (scores.spam >= thresholds.probableSpam) return "probable-spam";
  if (scores.spam >= thresholds.ambiguous) return "ambiguous";
  if (scores.solicitation > thresholds.solicitation) return "solicitation";
  if (policy.offTopic === "review" && isOffTopic(scores, policy)) return "low-relevance";
  return null;
}
