import { Schema } from "effect";

/** The name of an account, as the first account and an invited person choose it. */
export const AccountName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

/** The email address of an account, in the format that Better Auth accepts at sign-in. */
export const AccountEmail = Schema.Trim.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u,
  ),
);

/** 12 to 128 characters, the rule of Better Auth's sign-in for every account. */
export const accountPasswordLength = { minimum: 12, maximum: 128 } as const;

export const AccountPassword = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(accountPasswordLength.minimum),
    Schema.isMaxLength(accountPasswordLength.maximum),
  ),
);
