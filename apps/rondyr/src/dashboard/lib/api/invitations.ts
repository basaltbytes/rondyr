import { queryOptions } from "@tanstack/react-query";

import { AcceptedInvitation, InvitationSummary } from "@rondyr/organizations/members";

import { MemberRefusal } from "./members.ts";
import { requestJson } from "./request.ts";

export type InvitationSummary = typeof InvitationSummary.Type;

/** The invitation of a link. The secret goes in the body, never in a URL. */
export function invitationQuery(token: string) {
  return queryOptions({
    queryKey: ["invitation", token] as const,
    queryFn: ({ signal }) =>
      requestJson("/api/invitations/read", InvitationSummary, {
        method: "POST",
        json: { token },
        signal,
        refusal: MemberRefusal,
      }),
  });
}

/** Accept as the signed-in account, or with a new account when a name and a password are given. */
export function acceptInvitation(
  token: string,
  account?: { readonly name: string; readonly password: string },
) {
  return requestJson("/api/invitations/accept", AcceptedInvitation, {
    method: "POST",
    json: { token, ...account },
    refusal: MemberRefusal,
  });
}
