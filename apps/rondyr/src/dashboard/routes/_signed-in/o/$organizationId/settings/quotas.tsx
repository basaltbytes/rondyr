import { createFileRoute } from "@tanstack/react-router";

import { QuotaSettings } from "~/features/organization/quota-settings";
import { quotasQuery } from "~/lib/api/quotas";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The daily quotas of the organization and today's usage. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/quotas")({
  staticData: { sidebar: { at: "settings", section: "quotas" } },
  loader: ({ context, params }) =>
    context.queryClient.query({ ...quotasQuery(params.organizationId), staleTime: "static" }).then(
      () => undefined,
      () => undefined,
    ),
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <QuotaSettings organizationId={organization.id} />;
}
