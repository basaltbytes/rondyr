import { createContext, use } from "react";

import type { Organization } from "~/lib/api/organizations";

/** The organization of the address, as the account has it now. */
export const OrganizationContext = createContext<Organization | null>(null);

/** The organization of the address, in a page under the layout of the organization. */
export function useOrganization(): Organization {
  const organization = use(OrganizationContext);
  if (organization === null) throw new Error("useOrganization needs the organization's layout.");
  return organization;
}
