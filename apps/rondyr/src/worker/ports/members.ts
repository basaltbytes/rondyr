import { Context, Effect, Redacted, Schema } from "effect";

import type { MemberRole } from "../../domain/organizations/member-role.ts";
import type {
  InvitationId,
  InvitationSummary,
  Member,
  OrganizationMembers,
  PendingInvitation,
} from "../../domain/organizations/members.ts";
import type { OrganizationId, UserId } from "../../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The account is not a member of the organization. */
export class MemberNotFound extends Schema.TaggedError<
  MemberNotFound,
  { readonly brand: unique symbol }
>()("MemberNotFound", {}) {}

/** The acting account lost the admin role while its request ran: 403, as after it. */
export class NotAnAdmin extends Schema.TaggedError<NotAnAdmin, { readonly brand: unique symbol }>()(
  "NotAnAdmin",
  {},
) {}

/** The change would leave the organization without an admin. */
export class LastAdmin extends Schema.TaggedError<LastAdmin, { readonly brand: unique symbol }>()(
  "LastAdmin",
  {},
) {}

/** An account at this address is already a member of the organization. */
export class AlreadyMember extends Schema.TaggedError<
  AlreadyMember,
  { readonly brand: unique symbol }
>()("AlreadyMember", {}) {}

/** The organization has as many unexpired invitations as it may. */
export class InvitationLimit extends Schema.TaggedError<
  InvitationLimit,
  { readonly brand: unique symbol }
>()("InvitationLimit", {}) {}

/** No invitation can be used with this link: unknown, expired, accepted or cancelled. */
export class InvitationNotFound extends Schema.TaggedError<
  InvitationNotFound,
  { readonly brand: unique symbol }
>()("InvitationNotFound", {}) {}

/** The signed-in account does not have the invited address. */
export class InvitationForOtherAccount extends Schema.TaggedError<
  InvitationForOtherAccount,
  { readonly brand: unique symbol }
>()("InvitationForOtherAccount", {}) {}

/** An account already has the invited address: its owner signs in to accept. */
export class InvitationNeedsSignIn extends Schema.TaggedError<
  InvitationNeedsSignIn,
  { readonly brand: unique symbol }
>()("InvitationNeedsSignIn", {}) {}

export interface CreatedInvitation {
  readonly invitation: PendingInvitation;
  /** The secret of the link, shown once. Only its hash is stored. */
  readonly token: Redacted.Redacted<string>;
  /** Whether the address is still under its daily number of invitation emails. */
  readonly mayEmail: boolean;
}

export interface NewAccount {
  readonly name: string;
  readonly password: Redacted.Redacted<string>;
}

/**
 * The members of an organization and its invitations. The caller has checked
 * the permission; each statement is still scoped to the organization and to
 * the acting account's membership. The last admin of an organization can be
 * neither removed nor demoted: the statement that changes the member checks it.
 */
export class Members extends Context.Service<
  Members,
  {
    readonly list: (
      scope: OrganizationScope,
    ) => Effect.Effect<OrganizationMembers, MemberNotFound | StorageUnavailable>;
    /** Invite an address, replacing a pending invitation of the same address. */
    readonly invite: (
      scope: OrganizationScope,
      email: string,
      role: MemberRole,
    ) => Effect.Effect<
      CreatedInvitation,
      MemberNotFound | AlreadyMember | InvitationLimit | StorageUnavailable
    >;
    readonly cancelInvitation: (
      scope: OrganizationScope,
      id: InvitationId,
    ) => Effect.Effect<void, InvitationNotFound | StorageUnavailable>;
    readonly changeRole: (
      scope: OrganizationScope,
      member: typeof UserId.Type,
      role: MemberRole,
    ) => Effect.Effect<Member, MemberNotFound | LastAdmin | NotAnAdmin | StorageUnavailable>;
    readonly remove: (
      scope: OrganizationScope,
      member: typeof UserId.Type,
    ) => Effect.Effect<void, MemberNotFound | LastAdmin | NotAnAdmin | StorageUnavailable>;
    /** The invitation that a link opens, for the person who opened it. */
    readonly readInvitation: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<typeof InvitationSummary.Type, InvitationNotFound | StorageUnavailable>;
    /** The signed-in account joins, if it has the invited address. */
    readonly acceptAsAccount: (
      token: Redacted.Redacted<string>,
      account: typeof UserId.Type,
    ) => Effect.Effect<
      OrganizationId,
      InvitationNotFound | InvitationForOtherAccount | StorageUnavailable
    >;
    /** Create an account at the invited address and join, in one transaction. */
    readonly acceptWithNewAccount: (
      token: Redacted.Redacted<string>,
      account: NewAccount,
    ) => Effect.Effect<
      OrganizationId,
      InvitationNotFound | InvitationNeedsSignIn | StorageUnavailable
    >;
  }
>()("rondyr/worker/ports/members") {}
