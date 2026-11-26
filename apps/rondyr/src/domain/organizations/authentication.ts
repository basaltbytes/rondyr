import { Schema } from "effect";

import { EmailLanguage } from "../deliveries/email.ts";
import { UserId } from "../submissions/submission.id.ts";
import { AccountEmail, AccountName, OtpCode, PasskeyId, PasskeyName } from "./account.ts";

/** An email sign-in code expires after ten minutes. */
export const otpLifetimeMillis = 10 * 60 * 1000;

/** A code is invalidated after five failed verification attempts. */
export const otpMaxAttempts = 5;

/** At most five codes are sent to one address in an hour. */
export const otpMaxCodesPerHour = 5;

/** A WebAuthn challenge expires after five minutes. */
export const challengeLifetimeMillis = 5 * 60 * 1000;

/** A browser session stays valid for thirty days, sliding on activity. */
export const sessionLifetimeMillis = 30 * 24 * 60 * 60 * 1000;

/** A session is extended when less than half its lifetime remains. */
export const sessionSlideThresholdMillis = 15 * 24 * 60 * 60 * 1000;

export const Base64UrlString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);

export const SessionUser = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
});
export type SessionUser = typeof SessionUser.Type;

export const AuthSession = Schema.Struct({
  user: SessionUser,
});
export type AuthSession = typeof AuthSession.Type;

export const SessionResponse = Schema.NullOr(AuthSession);
export type SessionResponse = typeof SessionResponse.Type;

export const PasskeyCredentialDescriptor = Schema.Struct({
  id: Base64UrlString,
  type: Schema.Literal("public-key"),
  transports: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const PasskeyCreationOptions = Schema.Struct({
  challenge: Base64UrlString,
  rp: Schema.Struct({
    name: Schema.String,
    id: Schema.String,
  }),
  user: Schema.Struct({
    id: Base64UrlString,
    name: Schema.String,
    displayName: Schema.String,
  }),
  pubKeyCredParams: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("public-key"),
      alg: Schema.Int,
    }),
  ),
  timeout: Schema.Int,
  attestation: Schema.Literal("none"),
  authenticatorSelection: Schema.Struct({
    residentKey: Schema.Literal("required"),
    requireResidentKey: Schema.Literal(true),
    userVerification: Schema.Literal("preferred"),
  }),
  excludeCredentials: Schema.optionalKey(Schema.Array(PasskeyCredentialDescriptor)),
});
export type PasskeyCreationOptions = typeof PasskeyCreationOptions.Type;

export const PasskeyRequestOptions = Schema.Struct({
  challenge: Base64UrlString,
  rpId: Schema.String,
  timeout: Schema.Int,
  userVerification: Schema.Literal("preferred"),
  allowCredentials: Schema.Array(PasskeyCredentialDescriptor),
});
export type PasskeyRequestOptions = typeof PasskeyRequestOptions.Type;

const PasskeyTransports = Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(
  Schema.isMaxLength(10),
);

export const PasskeyRegistrationCredential = Schema.Struct({
  id: Base64UrlString,
  rawId: Base64UrlString,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: Base64UrlString,
    attestationObject: Base64UrlString,
    transports: Schema.optionalKey(PasskeyTransports),
  }),
});
export type PasskeyRegistrationCredential = typeof PasskeyRegistrationCredential.Type;

export const PasskeyAssertionCredential = Schema.Struct({
  id: Base64UrlString,
  rawId: Base64UrlString,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: Base64UrlString,
    authenticatorData: Base64UrlString,
    signature: Base64UrlString,
    userHandle: Schema.optionalKey(Schema.NullOr(Base64UrlString)),
  }),
});
export type PasskeyAssertionCredential = typeof PasskeyAssertionCredential.Type;

export const SetupOptionsInput = Schema.Struct({
  name: AccountName,
  email: AccountEmail,
});

export const SetupVerifyInput = Schema.Struct({
  credential: PasskeyRegistrationCredential,
  passkeyName: Schema.optionalKey(PasskeyName),
});

export const PasskeySignInVerifyInput = Schema.Struct({
  credential: PasskeyAssertionCredential,
});

export const RequestEmailOtp = Schema.Struct({
  email: AccountEmail,
  language: Schema.optionalKey(EmailLanguage),
});

export const VerifyEmailOtp = Schema.Struct({
  email: AccountEmail,
  code: OtpCode,
});

export const EmailOtpError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("email-provider-missing") }),
  Schema.Struct({ error: Schema.Literal("otp-invalid") }),
]);

export const RecoveryOptionsInput = Schema.Struct({
  email: AccountEmail,
});

export const RecoveryVerifyInput = Schema.Struct({
  credential: PasskeyRegistrationCredential,
  passkeyName: Schema.optionalKey(PasskeyName),
});

export const PasskeySummary = Schema.Struct({
  id: PasskeyId,
  name: Schema.String,
  rpId: Schema.String,
  currentDomain: Schema.Boolean,
  createdAt: Schema.Int,
  lastUsedAt: Schema.NullOr(Schema.Int),
});
export type PasskeySummary = typeof PasskeySummary.Type;

export const AccountPasskeys = Schema.Struct({
  passkeys: Schema.Array(PasskeySummary),
  emailOtpEnabled: Schema.Boolean,
});
export type AccountPasskeys = typeof AccountPasskeys.Type;

export const AddPasskeyVerifyInput = Schema.Struct({
  credential: PasskeyRegistrationCredential,
  name: Schema.optionalKey(PasskeyName),
});

export const RenamePasskeyInput = Schema.Struct({
  name: PasskeyName,
});

export const PasskeyError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("last-passkey") }),
  Schema.Struct({ error: Schema.Literal("passkey-exists") }),
  Schema.Struct({ error: Schema.Literal("passkey-not-found") }),
  Schema.Struct({ error: Schema.Literal("challenge-invalid") }),
]);

const otpCopy = {
  en: {
    subject: "Your Rondyr sign-in code",
    intro: "Use this code to sign in to your Rondyr account:",
    expires: "This code expires in 10 minutes and works once.",
    ignore: "If you did not ask to sign in, you can ignore this email.",
  },
  fr: {
    subject: "Votre code de connexion Rondyr",
    intro: "Utilisez ce code pour vous connecter à votre compte Rondyr :",
    expires: "Ce code expire dans 10 minutes et ne sert qu’une fois.",
    ignore: "Si vous n’avez pas demandé à vous connecter, vous pouvez ignorer cet e-mail.",
  },
} as const;

/** The plain text email containing a one-time sign-in code. */
export function emailOtpEmail(code: string, language: EmailLanguage) {
  const words = otpCopy[language];
  const text = [words.intro, code, words.expires, words.ignore];
  return { subject: words.subject, text: `${text.join("\n\n")}\n` };
}
