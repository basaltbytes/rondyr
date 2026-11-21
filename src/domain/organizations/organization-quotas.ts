import { Schema } from "effect";

import type { IntakeReason } from "../submissions/classification.ts";

export const defaultDailySubmissions = 2_000;

export const defaultDailyClassifications = 1_000;

export const maxDailySubmissions = 100_000;

export const maxDailyClassifications = 100_000;

/**
 * The intake reasons that mark a submission as junk. Junk has its own daily
 * budget, equal to the submission limit, so a wave of it cannot use up the
 * budget of the other submissions. `quota` is not junk: the classification
 * quota quarantines messages that can be real.
 */
export const junkIntakeReasons = [
  "honeypot",
  "turnstile-failed",
  "repetition",
] as const satisfies ReadonlyArray<IntakeReason>;

export const DailyQuotas = Schema.Struct({
  submissions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxDailySubmissions })),
  classifications: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: maxDailyClassifications }),
  ),
});
export type DailyQuotas = typeof DailyQuotas.Type;

const Used = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** `junk` counts the stored junk, `submissions` the other stored submissions. */
export const DailyUsage = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  limits: DailyQuotas,
  used: Schema.Struct({ submissions: Used, classifications: Used, junk: Used }),
});
