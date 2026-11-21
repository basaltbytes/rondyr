import { Context, Effect, Redacted, Schema } from "effect";

import type { EmailAddress, EmailLanguage } from "../domain/deliveries/email.ts";
import type { OrganizationId } from "../domain/submissions/submission.id.ts";
import type { TargetScope } from "./notification-targets.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The address is not a recipient of an email target of the account's organizations. */
export class RecipientNotFound extends Schema.TaggedError<
  RecipientNotFound,
  { readonly brand: unique symbol }
>()("RecipientNotFound", {}) {}

/** The owner of the address has already confirmed it for the organization. */
export class RecipientConfirmed extends Schema.TaggedError<
  RecipientConfirmed,
  { readonly brand: unique symbol }
>()("RecipientConfirmed", {}) {}

/** The address got its daily number of confirmation emails. */
export class ConfirmationLimit extends Schema.TaggedError<
  ConfirmationLimit,
  { readonly brand: unique symbol }
>()("ConfirmationLimit", {}) {}

/** No confirmation can use this link: unknown, expired or already used. */
export class ConfirmationNotFound extends Schema.TaggedError<
  ConfirmationNotFound,
  { readonly brand: unique symbol }
>()("ConfirmationNotFound", {}) {}

/** A new confirmation link for an address. Only the hash of its secret is stored. */
export interface IssuedConfirmation {
  readonly address: EmailAddress;
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

/**
 * The confirmed email recipients of each organization. An address is
 * confirmed once per organization, and then serves every form of it.
 */
export class RecipientConfirmations extends Context.Service<
  RecipientConfirmations,
  {
    /**
     * A new link for each address that the organization has not confirmed and
     * that is under its daily number of confirmation emails. The other
     * addresses get nothing.
     */
    readonly request: (
      organizationId: OrganizationId,
      addresses: ReadonlyArray<EmailAddress>,
    ) => Effect.Effect<ReadonlyArray<IssuedConfirmation>, StorageUnavailable>;
    /** A new link for one recipient of an email target, in the language of the target. */
    readonly requestFor: (
      target: TargetScope,
      address: string,
    ) => Effect.Effect<
      IssuedConfirmation & { readonly language: EmailLanguage },
      RecipientNotFound | RecipientConfirmed | ConfirmationLimit | StorageUnavailable
    >;
    /** Confirm the address of a link, once. */
    readonly confirm: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ConfirmationNotFound | StorageUnavailable>;
    /**
     * The addresses of the list that the organization had confirmed at `asOf`,
     * in the order of the list.
     */
    readonly confirmedAmong: (
      organizationId: OrganizationId,
      addresses: ReadonlyArray<EmailAddress>,
      asOf: number,
    ) => Effect.Effect<ReadonlyArray<EmailAddress>, StorageUnavailable>;
  }
>()("rondyr/ports/recipient-confirmations/RecipientConfirmations") {}
