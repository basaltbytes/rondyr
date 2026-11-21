import { Context, Effect, Redacted, Schema } from "effect";

import type { StorageUnavailable } from "./storage.ts";

/** No usable link has this secret: unknown, expired or used. */
export class PasswordResetNotFound extends Schema.TaggedError<
  PasswordResetNotFound,
  { readonly brand: unique symbol }
>()("PasswordResetNotFound", {}) {}

export interface IssuedPasswordReset {
  /** The address of the account, as stored. */
  readonly email: string;
  /** The secret of the link. Only its hash is stored. */
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

/**
 * Reset links of the accounts. A reset proves that its user reads the mailbox
 * of the account: it replaces the password, signs every session out, and marks
 * the address verified. The owner of an address thus takes back an account
 * that someone else created at it, for example from an invitation link that an
 * admin copied.
 */
export class PasswordResets extends Context.Service<
  PasswordResets,
  {
    /**
     * A new link for the account at `email`, or null when no account has the
     * address or the account already got its links of the last 24 hours.
     */
    readonly issue: (
      email: string,
    ) => Effect.Effect<IssuedPasswordReset | null, StorageUnavailable>;
    /** Replace the password of the link's account, once. */
    readonly complete: (
      token: Redacted.Redacted<string>,
      password: Redacted.Redacted<string>,
    ) => Effect.Effect<void, PasswordResetNotFound | StorageUnavailable>;
  }
>()("rondyr/ports/password-resets/PasswordResets") {}
