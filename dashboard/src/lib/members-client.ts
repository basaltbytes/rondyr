import { Schema } from "effect";

import {
  AcceptedInvitation,
  InvitationSummary,
  IssuedInvitation,
  Member,
  OrganizationMembers,
  type InvitationId,
  type Member as MemberType,
  type OrganizationMembers as Members,
} from "@rondyr/organizations/members";
import type { MemberRole } from "@rondyr/organizations/member-role";

import type { Inbox } from "./inbox-client.ts";
import type { Language } from "./language.ts";

const decodeMembers = Schema.decodeUnknownPromise(OrganizationMembers);
const decodeMember = Schema.decodeUnknownPromise(Member);
const decodeIssued = Schema.decodeUnknownPromise(IssuedInvitation);
const decodeSummary = Schema.decodeUnknownPromise(InvitationSummary);
const decodeAccepted = Schema.decodeUnknownPromise(AcceptedInvitation);
const decodeError = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

/** A request that the API refused, with the error code of its body when it has one. */
export class MemberRequestFailed extends Schema.TaggedError<
  MemberRequestFailed,
  { readonly brand: unique symbol }
>()("MemberRequestFailed", { status: Schema.Int, error: Schema.NullOr(Schema.String) }) {}

async function send(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  const error = decodeError(body);
  throw MemberRequestFailed.make({
    status: response.status,
    error: error._tag === "Some" ? error.value.error : null,
  });
}

const json = (body: Readonly<Record<string, string>>, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const organization = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}`;

export type MemberList = Members;
export type OrganizationMember = MemberType;

export async function listMembers(id: Inbox["id"]) {
  const response = await send(`${organization(id)}/members`);
  return decodeMembers(await response.json());
}

export async function inviteMember(
  id: Inbox["id"],
  email: string,
  role: MemberRole,
  language: Language,
) {
  const response = await send(`${organization(id)}/invitations`, json({ email, role, language }));
  return decodeIssued(await response.json());
}

export async function cancelInvitation(id: Inbox["id"], invitation: InvitationId) {
  const query = new URLSearchParams({ id: invitation });
  await send(`${organization(id)}/invitations?${query}`, { method: "DELETE" });
}

export async function changeMemberRole(
  id: Inbox["id"],
  member: OrganizationMember["userId"],
  role: MemberRole,
) {
  const response = await send(
    `${organization(id)}/members/${encodeURIComponent(member)}`,
    json({ role }, "PATCH"),
  );
  return decodeMember(await response.json());
}

export async function removeMember(id: Inbox["id"], member: OrganizationMember["userId"]) {
  await send(`${organization(id)}/members/${encodeURIComponent(member)}`, { method: "DELETE" });
}

/** The invitation of a link. The secret goes in the body, never in a URL. */
export async function readInvitation(token: string) {
  const response = await send("/api/invitations/read", json({ token }));
  return decodeSummary(await response.json());
}

/** Accept as the signed-in account, or with a new account when a name and a password are given. */
export async function acceptInvitation(
  token: string,
  account?: { readonly name: string; readonly password: string },
) {
  const response = await send("/api/invitations/accept", json({ token, ...account }));
  return decodeAccepted(await response.json());
}
