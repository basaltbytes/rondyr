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

const Used = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const DailyUsage = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  limits: DailyQuotas,
  used: Schema.Struct({ submissions: Used, classifications: Used }),
});
