import { Schema } from "effect";

/** The name of an account, as the first account and an invited person choose it. */
export const AccountName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

/** The email address of an account. */
export const AccountEmail = Schema.Trim.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u,
  ),
);

/** The label of a registered passkey. */
export const PasskeyName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));

export const PasskeyId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("PasskeyId"));
export type PasskeyId = typeof PasskeyId.Type;

/** Six numeric digits sent by email for passwordless sign-in. */
export const OtpCode = Schema.Trim.check(Schema.isPattern(/^[0-9]{6}$/u));
