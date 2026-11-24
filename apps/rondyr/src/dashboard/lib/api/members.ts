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
    // A pending invitation can be accepted from its link at any time, so a revisit checks fresh.
    staleTime: (query) => ((query.state.data?.invitations.length ?? 0) > 0 ? 0 : 30_000),
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
 * account's own role or membership changes the cached organizations, which are then
 * read again.
 */
export function changeMembersMutation(organizationId: string, self: string | null) {
  return mutationOptions({
    mutationFn: (change: MemberChange) => changeMembers(organizationId, change),
    onSuccess: async (result, _change, _context, { client }) => {
      client.setQueryData(membersQuery(organizationId).queryKey, (members) =>
        members === undefined ? undefined : applied(members, result),
      );
      if (result.change !== "role" && result.change !== "remove") return;
      const member = result.change === "role" ? result.member.userId : result.member;
      if (member !== self) return;
      // The account's own role or membership changed: the organizations follow at once.
      client.setQueryData(organizationsQuery.queryKey, (organizations) =>
        result.change === "role"
          ? organizations?.map((organization) =>
              organization.id === organizationId
                ? { ...organization, role: result.member.role }
                : organization,
            )
          : organizations?.filter((organization) => organization.id !== organizationId),
      );
      await client.invalidateQueries({ queryKey: organizationsQuery.queryKey });
    },
  });
}
