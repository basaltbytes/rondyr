import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";

import type { MemberRole } from "@rondyr/organizations/member-role";
import {
  IssuedInvitation,
  Member,
  OrganizationMembers,
  type InvitationId,
} from "@rondyr/organizations/members";

import type { Language } from "~/lib/language";

import { organizationsQuery } from "./organizations.ts";
import { organizationPath, refusalOf, request, requestJson } from "./request.ts";

export type { Member, OrganizationMembers };
export type IssuedInvitation = typeof IssuedInvitation.Type;

/** The body of a refusal of the members and invitations API: an error code. */
export const MemberRefusal = Schema.Struct({ error: Schema.String });

/** The error code of a refused request, if the API gave one. */
export function memberErrorOf(cause: unknown) {
  return Option.getOrNull(Option.map(refusalOf(cause, MemberRefusal), ({ error }) => error));
}

/** The members of an organization and its pending invitations. */
export function membersQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "members"] as const,
    queryFn: ({ signal }) =>
      requestJson(organizationPath(organizationId, "members"), OrganizationMembers, { signal }),
  });
}

/** A change of the members: an invitation, its cancellation, a role or a removal. */
export type MemberChange =
  | {
      readonly change: "invite";
      readonly email: string;
      readonly role: MemberRole;
      readonly language: Language;
    }
  | { readonly change: "cancel"; readonly invitation: InvitationId }
  | { readonly change: "role"; readonly member: Member["userId"]; readonly role: MemberRole }
  | { readonly change: "remove"; readonly member: Member["userId"] };

type ChangeResult =
  | { readonly change: "invite"; readonly issued: IssuedInvitation }
  | { readonly change: "cancel"; readonly invitation: InvitationId }
  | { readonly change: "role"; readonly member: Member }
  | { readonly change: "remove"; readonly member: Member["userId"] };

async function changeMembers(organizationId: string, change: MemberChange): Promise<ChangeResult> {
  switch (change.change) {
    case "invite": {
      const { email, role, language } = change;
      const issued = await requestJson(
        organizationPath(organizationId, "invitations"),
        IssuedInvitation,
        { method: "POST", json: { email, role, language }, refusal: MemberRefusal },
      );
      return { change: "invite", issued };
    }
    case "cancel": {
      const query = new URLSearchParams({ id: change.invitation });
      await request(`${organizationPath(organizationId, "invitations")}?${query}`, {
        method: "DELETE",
        refusal: MemberRefusal,
      });
      return change;
    }
    case "role": {
      const member = await requestJson(
        organizationPath(organizationId, "members", change.member),
        Member,
        { method: "PATCH", json: { role: change.role }, refusal: MemberRefusal },
      );
      return { change: "role", member };
    }
    case "remove": {
      await request(organizationPath(organizationId, "members", change.member), {
        method: "DELETE",
        refusal: MemberRefusal,
      });
      return change;
    }
  }
}

function applied(members: OrganizationMembers, result: ChangeResult): OrganizationMembers {
  switch (result.change) {
    case "invite": {
      const { invitation } = result.issued;
      return {
        ...members,
        invitations: [
          invitation,
          ...members.invitations.filter(({ email }) => email !== invitation.email),
        ],
      };
    }
    case "cancel":
      return {
        ...members,
        invitations: members.invitations.filter(({ id }) => id !== result.invitation),
      };
    case "role":
      return {
        ...members,
        members: members.members.map((member) =>
          member.userId === result.member.userId ? result.member : member,
        ),
      };
    case "remove":
      return {
        ...members,
        members: members.members.filter(({ userId }) => userId !== result.member),
      };
  }
}

/**
 * Changes the members of an organization, then their cached list. A change to the
 * account's own membership reads the organizations again, since its role or its access
 * changed.
 */
export function changeMembersMutation(organizationId: string, self: string | null) {
  return mutationOptions({
    mutationFn: (change: MemberChange) => changeMembers(organizationId, change),
    onSuccess: async (result, change, _context, { client }) => {
      client.setQueryData(membersQuery(organizationId).queryKey, (members) =>
        members === undefined ? undefined : applied(members, result),
      );
      const own =
        (change.change === "role" || change.change === "remove") && change.member === self;
      if (own) await client.invalidateQueries({ queryKey: organizationsQuery.queryKey });
    },
  });
}
