import { Schema } from "effect";

export const Score = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const ClassificationScores = Schema.Struct({
  model: Schema.String,
  spam: Score,
  relevance: Schema.optionalKey(Score),
});
export const ClassificationReason = Schema.Literals([
  "probable-spam",
  "ambiguous",
  "low-relevance",
  "classification-error",
]);
export const ClassificationResult = Schema.Union([
  Schema.TaggedStruct("Scored", { scores: ClassificationScores }),
  Schema.TaggedStruct("ClassificationError", {}),
]);

export const rulesVersion = 1;

export function reviewReason(scores: typeof ClassificationScores.Type) {
  if (scores.spam >= 0.7) return "probable-spam";
  if (scores.spam >= 0.3) return "ambiguous";
  if (scores.relevance !== undefined && scores.relevance < 0.35) return "low-relevance";
  return null;
}
