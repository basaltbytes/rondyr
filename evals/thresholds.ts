import { Schema } from "effect";

import { ClassificationReason } from "../src/domain/submissions/classification.ts";

export const Decision = Schema.Literals([
  "accepted",
  ...ClassificationReason.literals,
  "repetition",
]);

export type Decision = typeof Decision.Type;

/** Thresholds from 0.05 to 0.95 in steps of 0.05, built from integers to avoid drift. */
export const thresholdGrid = Array.from({ length: 19 }, (_, index) => (index + 1) * 5).map(
  (hundredths) => hundredths / 100,
);
