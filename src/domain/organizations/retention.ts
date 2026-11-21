import { Schema } from "effect";

/** The longest retention period, in days: about ten years. */
export const maxRetentionDays = 3_650;

const Days = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxRetentionDays })),
);

/**
 * How many days an organization keeps its messages, counted from their
 * reception: the accepted ones, and those in quarantine or archived. `null`
 * keeps them without limit, the default. A message still being received or
 * classified is never purged.
 */
export const RetentionPeriods = Schema.Struct({ accepted: Days, quarantine: Days });
export type RetentionPeriods = typeof RetentionPeriods.Type;

export const dayMillis = 86_400_000;
