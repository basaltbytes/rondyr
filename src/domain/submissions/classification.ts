import { Schema } from "effect";

export const Score = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const ClassificationScores = Schema.Struct({
  model: Schema.String,
  spam: Score,
  relevance: Schema.optionalKey(Score),
});

/** Why the classification rules quarantine a submission. */
export const ClassificationReason = Schema.Literals([
  "probable-spam",
  "ambiguous",
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

export function reviewReason(scores: typeof ClassificationScores.Type) {
  if (scores.spam >= 0.7) return "probable-spam";
  if (scores.spam >= 0.3) return "ambiguous";
  if (scores.relevance !== undefined && scores.relevance < 0.35) return "low-relevance";
  return null;
}
