import type { QueryClient } from "@tanstack/react-query";
import { notFound, redirect } from "@tanstack/react-router";

import { allows, type Permission } from "@rondyr/organizations/member-role";

import { organizationsQuery, type Organization } from "~/lib/api/organizations";

/**
 * The organization of an address, among the organizations of the account. One that the
 * account is not a member of is not found, whatever the API would answer about it. When
 * the organizations cannot be read, the layout says why, and the organization is unknown.
 */
export async function organizationOf(
  queryClient: QueryClient,
  organizationId: string,
): Promise<Organization | undefined> {
  const read = (staleTime: "static" | 0) =>
    queryClient.query({ ...organizationsQuery, staleTime }).catch(() => undefined);
  const cached = await read("static");
  if (cached === undefined) return undefined;
  // An organization joined since the last read is not in the cache yet.
  const organizations = cached.some(({ id }) => id === organizationId)
    ? cached
    : ((await read(0)) ?? cached);
  const organization = organizations.find(({ id }) => id === organizationId);
  if (organization === undefined) throw notFound();
  return organization;
}

/**
 * Sends a role without the permission of a page to the messages of its organization: a
 * reviewer has no page of forms and no page of settings.
 */
export function requirePermission(organization: Organization | undefined, permission: Permission) {
  if (organization !== undefined && !allows(organization.role, permission)) {
    throw redirect({
      to: "/o/$organizationId/messages",
      params: { organizationId: organization.id },
      replace: true,
    });
  }
}
