import { queryOptions } from "@tanstack/react-query";

import { PasskeyCreationOptions } from "@rondyr/organizations/authentication";
import { AcceptedInvitation, InvitationSummary } from "@rondyr/organizations/members";

import { createBrowserPasskey } from "~/lib/webauthn";

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

/** Accept as the signed-in account at the invited address. */
export function acceptInvitation(token: string) {
  return requestJson("/api/invitations/accept", AcceptedInvitation, {
    method: "POST",
    json: { token },
    refusal: MemberRefusal,
  });
}

/** Atomically create an account with a passkey, sign in, and join the invited organization. */
export async function acceptInvitationWithPasskey(token: string, name: string) {
  const options = await requestJson("/api/invitations/options", PasskeyCreationOptions, {
    method: "POST",
    json: { token, name },
    refusal: MemberRefusal,
  });
  const credential = await createBrowserPasskey(options);
  return requestJson("/api/invitations/verify", AcceptedInvitation, {
    method: "POST",
    json: { token, credential },
    refusal: MemberRefusal,
  });
}
