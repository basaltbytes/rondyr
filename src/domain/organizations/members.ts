import { Schema } from "effect";

import { EmailLanguage } from "../deliveries/email.ts";
import { OrganizationId, UserId } from "../submissions/submission.id.ts";
import { AccountEmail, AccountName, AccountPassword } from "./account.ts";
import { MemberRole } from "./member-role.ts";

/** An invitation link stays valid for seven days. */
export const invitationLifetimeMillis = 7 * 24 * 60 * 60 * 1000;

/** At most this many unexpired invitations wait in an organization. */
export const maxPendingInvitations = 20;

/**
 * Rondyr emails an address at most this many invitations in 24 hours, across
 * every organization. Beyond it, the invitation is created and its link is
 * copied from the dashboard.
 */
export const invitationEmailsPerDay = 3;

export const InvitationId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("InvitationId"),
);
export type InvitationId = typeof InvitationId.Type;

/** 32 random bytes in base64url, the secret part of an invitation link. */
export const InvitationToken = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
);

export const Member = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
  role: MemberRole,
  /**
   * The API tokens of the organization that this member created and that still
   * work. Removing the member revokes them, and an integration that uses one stops.
   */
  activeApiTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type Member = typeof Member.Type;

/** An invitation that nobody has accepted or cancelled. It may have expired. */
export const PendingInvitation = Schema.Struct({
  id: InvitationId,
  email: Schema.String,
  role: MemberRole,
  createdAt: Schema.Int,
  expiresAt: Schema.Int,
});
export type PendingInvitation = typeof PendingInvitation.Type;

export const OrganizationMembers = Schema.Struct({
  members: Schema.Array(Member),
  invitations: Schema.Array(PendingInvitation),
});
export type OrganizationMembers = typeof OrganizationMembers.Type;

export const InviteMember = Schema.Struct({
  email: AccountEmail,
  role: MemberRole,
  /** The language of the invitation email. English when absent. */
  language: Schema.optionalKey(EmailLanguage),
});

/** What became of the invitation email. The link is in the response in every case. */
export const InvitationEmail = Schema.Literals(["sent", "no-provider", "limit-reached", "failed"]);
export type InvitationEmail = typeof InvitationEmail.Type;

/** A new invitation and its link, which only this response contains. */
export const IssuedInvitation = Schema.Struct({
  invitation: PendingInvitation,
  link: Schema.RedactedFromValue(Schema.String),
  email: InvitationEmail,
});

export const ChangeMemberRole = Schema.Struct({ role: MemberRole });

export const MemberRequestError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("last-admin") }),
  Schema.Struct({ error: Schema.Literal("already-member") }),
  Schema.Struct({ error: Schema.Literal("invitation-limit") }),
]);

/** The invitation as the person who opens its link sees it. */
export const InvitationSummary = Schema.Struct({
  organizationName: Schema.String,
  email: Schema.String,
  role: MemberRole,
  /** Whether an account already has the invited address. Such a person signs in to accept. */
  account: Schema.Literals(["existing", "new"]),
});

export const ReadInvitation = Schema.Struct({ token: InvitationToken });

/**
 * Accept an invitation. A signed-in account at the invited address joins. A
 * person without an account sends a name and a password, with the rules of
 * the first account, and gets an account at the invited address.
 */
export const AcceptInvitation = Schema.Struct({
  token: InvitationToken,
  name: Schema.optionalKey(AccountName),
  password: Schema.optionalKey(AccountPassword),
});

export const AcceptedInvitation = Schema.Struct({ organizationId: OrganizationId });

export const InvitationRequestError = Schema.Union([
  Schema.Struct({ error: Schema.Literal("invitation-invalid") }),
  Schema.Struct({ error: Schema.Literal("sign-in-required") }),
  Schema.Struct({ error: Schema.Literal("other-account") }),
  Schema.Struct({ error: Schema.Literal("account-required") }),
]);
