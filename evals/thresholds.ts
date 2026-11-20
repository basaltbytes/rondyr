import { Schema } from "effect";

import {
  ClassificationReason,
  type ClassificationThresholds,
  type ClassificationScores,
  reviewReason,
} from "../src/domain/submissions/classification.ts";

export const Decision = Schema.Literals([
  "accepted",
  ...ClassificationReason.literals,
  "repetition",
]);

export type Decision = typeof Decision.Type;

/** The rules of `reviewReason` with other thresholds, for the sweep. */
export function reasonAt(
  thresholds: typeof ClassificationThresholds.Type,
  scores: typeof ClassificationScores.Type,
) {
  return reviewReason(scores, thresholds);
}

/** Thresholds from 0.05 to 0.95 in steps of 0.05, built from integers to avoid drift. */
export const thresholdGrid = Array.from({ length: 19 }, (_, index) => (index + 1) * 5).map(
  (hundredths) => hundredths / 100,
);
