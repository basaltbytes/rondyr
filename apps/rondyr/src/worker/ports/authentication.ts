import { Context, Effect, Redacted, Schema } from "effect";

import type { PasskeyId } from "../../domain/organizations/account.ts";
import type {
  AuthSession,
  PasskeyAssertionCredential,
  PasskeyCreationOptions,
  PasskeyRegistrationCredential,
  PasskeyRequestOptions,
  PasskeySummary,
} from "../../domain/organizations/authentication.ts";
import type { AuthStatus } from "../../domain/organizations/setup.ts";
import type { UserId } from "../../domain/submissions/submission.id.ts";

export class AuthUnavailable extends Schema.TaggedError<
  AuthUnavailable,
  { readonly brand: unique symbol }
>()("AuthUnavailable", {}) {}

export class AuthOriginRefused extends Schema.TaggedError<
  AuthOriginRefused,
  { readonly brand: unique symbol }
>()("AuthOriginRefused", {}) {}

export class SetupClosed extends Schema.TaggedError<
  SetupClosed,
  { readonly brand: unique symbol }
>()("SetupClosed", {}) {}

/** One client tried too many setup or recovery tokens in a minute. */
export class SetupRateLimited extends Schema.TaggedError<
  SetupRateLimited,
  { readonly brand: unique symbol }
>()("SetupRateLimited", {}) {}

export class InvalidSetup extends Schema.TaggedError<
  InvalidSetup,
  { readonly brand: unique symbol }
>()("InvalidSetup", {}) {}

export class PasskeyInvalid extends Schema.TaggedError<
  PasskeyInvalid,
  { readonly brand: unique symbol }
>()("PasskeyInvalid", {}) {}

export class PasskeyExists extends Schema.TaggedError<
  PasskeyExists,
  { readonly brand: unique symbol }
>()("PasskeyExists", {}) {}

export class PasskeyNotFound extends Schema.TaggedError<
  PasskeyNotFound,
  { readonly brand: unique symbol }
>()("PasskeyNotFound", {}) {}

export class LastPasskey extends Schema.TaggedError<
  LastPasskey,
  { readonly brand: unique symbol }
>()("LastPasskey", {}) {}

export class OtpInvalid extends Schema.TaggedError<OtpInvalid, { readonly brand: unique symbol }>()(
  "OtpInvalid",
  {},
) {}

export class RecoveryClosed extends Schema.TaggedError<
  RecoveryClosed,
  { readonly brand: unique symbol }
>()("RecoveryClosed", {}) {}

export interface VerifiedOrigin {
  readonly origin: string;
  readonly rpId: string;
  readonly secure: boolean;
}

export interface SessionResult {
  readonly session: AuthSession | null;
  readonly setCookie: string | null;
}

export interface AuthenticatedSession {
  readonly session: AuthSession;
  readonly setCookie: string;
}

export interface IssuedEmailOtp {
  readonly email: string;
  readonly code: string;
}

export interface PreparedPasskeyRow {
  readonly id: PasskeyId;
  readonly name: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly counter: number;
  readonly transports: string | null;
  readonly rpId: string;
}

export interface PreparedSessionRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly expiresAt: number;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface VerifiedInvitationRegistration {
  readonly userId: typeof UserId.Type;
  readonly name: string;
  readonly email: string;
  readonly passkey: PreparedPasskeyRow;
  readonly session: PreparedSessionRow;
  readonly setCookie: string;
}

export class Authentication extends Context.Service<
  Authentication,
  {
    /** Validate the request origin and return the canonical origin and rpID. */
    readonly verifyOrigin: (
      request: Request,
    ) => Effect.Effect<VerifiedOrigin, AuthUnavailable | AuthOriginRefused>;
    /** Read the signed-in user ID from a request cookie, validating origin first. */
    readonly userId: (
      request: Request,
    ) => Effect.Effect<string | null, AuthUnavailable | AuthOriginRefused>;
    /** Read the full session (user details), sliding expiry when near renewal. */
    readonly getSession: (
      request: Request,
    ) => Effect.Effect<SessionResult, AuthUnavailable | AuthOriginRefused>;
    /** Revoke the current session and return a cookie-clearing Set-Cookie header. */
    readonly signOut: (
      request: Request,
    ) => Effect.Effect<string, AuthUnavailable | AuthOriginRefused>;
    /** Instance auth capabilities: setup state, Email OTP availability, recovery availability. */
    readonly authStatus: Effect.Effect<AuthStatus, AuthUnavailable>;
    /** Owner setup step 1: validate token, name, email, and issue a passkey creation challenge. */
    readonly setupOptions: (
      request: Request,
      input: { readonly name: string; readonly email: string },
    ) => Effect.Effect<
      PasskeyCreationOptions,
      AuthUnavailable | AuthOriginRefused | SetupClosed | SetupRateLimited | InvalidSetup
    >;
    /** Owner setup step 2: verify attestation, atomically create user + passkey + session. */
    readonly setupVerify: (
      request: Request,
      credential: PasskeyRegistrationCredential,
      passkeyName?: string,
    ) => Effect.Effect<
      AuthenticatedSession,
      AuthUnavailable | AuthOriginRefused | SetupClosed | SetupRateLimited | PasskeyInvalid
    >;
    /** Issue a discoverable passkey sign-in challenge. */
    readonly passkeySignInOptions: (
      request: Request,
    ) => Effect.Effect<PasskeyRequestOptions, AuthUnavailable | AuthOriginRefused>;
    /** Verify a passkey assertion, update counter/lastUsedAt, and start a session. */
    readonly passkeySignInVerify: (
      request: Request,
      credential: PasskeyAssertionCredential,
    ) => Effect.Effect<AuthenticatedSession, AuthUnavailable | AuthOriginRefused | PasskeyInvalid>;
    /** Issue a 6-digit Email OTP if an account exists and is under the hourly cap. */
    readonly issueEmailOtp: (
      email: string,
    ) => Effect.Effect<IssuedEmailOtp | null, AuthUnavailable>;
    /** Verify a 6-digit Email OTP, enforce 5-attempt lockout, and start a session. */
    readonly verifyEmailOtp: (
      request: Request,
      email: string,
      code: string,
    ) => Effect.Effect<AuthenticatedSession, AuthUnavailable | AuthOriginRefused | OtpInvalid>;
    /** Recovery step 1: validate RONDYR_RECOVERY_TOKEN, find user, issue registration options. */
    readonly recoveryOptions: (
      request: Request,
      email: string,
    ) => Effect.Effect<
      PasskeyCreationOptions,
      AuthUnavailable | AuthOriginRefused | RecoveryClosed | SetupRateLimited
    >;
    /** Recovery step 2: verify token and attestation, add passkey on current origin, start session. */
    readonly recoveryVerify: (
      request: Request,
      credential: PasskeyRegistrationCredential,
      passkeyName?: string,
    ) => Effect.Effect<
      AuthenticatedSession,
      | AuthUnavailable
      | AuthOriginRefused
      | RecoveryClosed
      | SetupRateLimited
      | PasskeyInvalid
      | PasskeyExists
    >;
    /** Invitation step 1: issue a passkey creation challenge tied to an invitation token hash. */
    readonly invitationOptions: (
      request: Request,
      input: {
        readonly token: Redacted.Redacted<string>;
        readonly name: string;
        readonly email: string;
      },
    ) => Effect.Effect<PasskeyCreationOptions, AuthUnavailable | AuthOriginRefused>;
    /** Invitation step 2: verify attestation and prepare atomic rows for Members.acceptWithPasskey. */
    readonly invitationVerify: (
      request: Request,
      token: Redacted.Redacted<string>,
      credential: PasskeyRegistrationCredential,
      passkeyName?: string,
    ) => Effect.Effect<
      VerifiedInvitationRegistration,
      AuthUnavailable | AuthOriginRefused | PasskeyInvalid
    >;
    /** List passkeys owned by a user, annotated with whether each belongs to the current rpID. */
    readonly listPasskeys: (
      request: Request,
      userId: typeof UserId.Type,
    ) => Effect.Effect<ReadonlyArray<PasskeySummary>, AuthUnavailable | AuthOriginRefused>;
    /** Issue passkey creation options for adding another passkey to an existing account. */
    readonly addPasskeyOptions: (
      request: Request,
      userId: typeof UserId.Type,
    ) => Effect.Effect<PasskeyCreationOptions, AuthUnavailable | AuthOriginRefused>;
    /** Verify attestation and store a new passkey for the signed-in user. */
    readonly addPasskeyVerify: (
      request: Request,
      userId: typeof UserId.Type,
      credential: PasskeyRegistrationCredential,
      name?: string,
    ) => Effect.Effect<
      PasskeySummary,
      AuthUnavailable | AuthOriginRefused | PasskeyInvalid | PasskeyExists
    >;
    /** Rename a passkey owned by the signed-in user. */
    readonly renamePasskey: (
      request: Request,
      userId: typeof UserId.Type,
      passkeyId: PasskeyId,
      name: string,
    ) => Effect.Effect<PasskeySummary, AuthUnavailable | AuthOriginRefused | PasskeyNotFound>;
    /** Delete a passkey owned by the signed-in user, refusing the last one if Email OTP is off. */
    readonly deletePasskey: (
      userId: typeof UserId.Type,
      passkeyId: PasskeyId,
      allowDeleteLast: boolean,
    ) => Effect.Effect<void, AuthUnavailable | PasskeyNotFound | LastPasskey>;
    /** Prune expired challenges, expired sessions, and old Email OTP rows. */
    readonly purgeExpired: (now: number) => Effect.Effect<void, AuthUnavailable>;
  }
>()("rondyr/worker/ports/authentication") {}
