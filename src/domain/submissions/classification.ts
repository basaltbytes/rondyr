import { Schema } from "effect";

export const Score = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

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

export const ClassificationResult = Schema.Union([
  Schema.TaggedStruct("Scored", { scores: ClassificationScores }),
  Schema.TaggedStruct("ClassificationError", {}),
]);

export const rulesVersion = 4;

export const ClassificationThresholds = Schema.Struct({
  probableSpam: Score,
  ambiguous: Score,
  solicitation: Score,
  lowRelevance: Score,
});

export const classificationThresholds: typeof ClassificationThresholds.Type = {
  probableSpam: 0.7,
  ambiguous: 0.3,
  solicitation: 0.5,
  lowRelevance: 0.35,
};

export function reviewReason(
  scores: typeof ClassificationScores.Type,
  thresholds = classificationThresholds,
) {
  if (scores.solicitation === undefined) return "classification-error";
  if (scores.spam >= thresholds.probableSpam) return "probable-spam";
  if (scores.spam >= thresholds.ambiguous) return "ambiguous";
  if (scores.solicitation > thresholds.solicitation) return "solicitation";
  if (scores.relevance !== undefined && scores.relevance < thresholds.lowRelevance) {
    return "low-relevance";
  }
  return null;
}
