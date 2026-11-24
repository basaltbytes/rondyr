import { createFileRoute } from "@tanstack/react-router";

import { OrganizationBlockedTerms } from "~/features/organization/organization-blocked-terms";
import { organizationBlockedTermsQuery } from "~/lib/api/blocked-terms";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The blocked words, phrases, domains and addresses of the organization. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/blocked-terms")({
  staticData: { sidebar: { at: "settings", section: "blockedTerms" } },
  loader: ({ context, params }) => {
    void context.queryClient
      .query(organizationBlockedTermsQuery(params.organizationId))
      .catch(() => undefined);
  },
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <OrganizationBlockedTerms organizationId={organization.id} />;
}
