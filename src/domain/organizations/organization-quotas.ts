import { Schema } from "effect";

export const defaultDailySubmissions = 2_000;

export const defaultDailyClassifications = 1_000;

export const maxDailySubmissions = 100_000;

export const maxDailyClassifications = 100_000;

export const DailyQuotas = Schema.Struct({
  submissions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxDailySubmissions })),
  classifications: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: maxDailyClassifications }),
  ),
});
export type DailyQuotas = typeof DailyQuotas.Type;

/**
 * The outcome of reserving one classification for an organization's current
 * UTC day: `reserved` counted it under the daily limit, `limit-reached` found
 * the day's count at the limit and counted nothing.
 */
export const ClassificationReservation = Schema.Literals(["reserved", "limit-reached"]);
export type ClassificationReservation = typeof ClassificationReservation.Type;

const Used = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const DailyUsage = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  limits: DailyQuotas,
  used: Schema.Struct({ submissions: Used, classifications: Used }),
});
