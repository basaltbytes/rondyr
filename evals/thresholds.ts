import { Schema } from "effect";

import {
  ClassificationReason,
  type ClassificationScores,
} from "../src/domain/submissions/classification.ts";

export const Decision = Schema.Literals(["accepted", ...ClassificationReason.literals]);

export type Decision = typeof Decision.Type;

export const Thresholds = Schema.Struct({
  probableSpam: Schema.Finite,
  ambiguous: Schema.Finite,
  lowRelevance: Schema.Finite,
});

export type Thresholds = typeof Thresholds.Type;

/**
 * The thresholds of `reviewReason` in src/domain/submissions/classification.ts. A test compares
 * `reasonAt(currentThresholds, ...)` with `reviewReason` across the score range, so a change
 * there fails until this copy follows.
 */
export const currentThresholds = {
  probableSpam: 0.7,
  ambiguous: 0.3,
  lowRelevance: 0.35,
} as const satisfies Thresholds;

/** The rules of `reviewReason` with other thresholds, for the sweep. */
export function reasonAt(thresholds: Thresholds, scores: typeof ClassificationScores.Type) {
  if (scores.spam >= thresholds.probableSpam) return "probable-spam";
  if (scores.spam >= thresholds.ambiguous) return "ambiguous";
  if (scores.relevance !== undefined && scores.relevance < thresholds.lowRelevance) {
    return "low-relevance";
  }
  return null;
}

/** Thresholds from 0.05 to 0.95 in steps of 0.05, built from integers to avoid drift. */
export const thresholdGrid = Array.from({ length: 19 }, (_, index) => (index + 1) * 5).map(
  (hundredths) => hundredths / 100,
);
