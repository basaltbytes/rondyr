import { createFileRoute } from "@tanstack/react-router";

import { OrganizationDomains } from "~/features/organization/organization-domains";
import { domainsQuery } from "~/lib/api/domains";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The domains of the organization. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/domains")({
  staticData: { sidebar: { at: "settings", section: "domains" } },
  loader: ({ context, params }) => {
    void context.queryClient.query(domainsQuery(params.organizationId)).catch(() => undefined);
  },
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <OrganizationDomains organizationId={organization.id} />;
}
