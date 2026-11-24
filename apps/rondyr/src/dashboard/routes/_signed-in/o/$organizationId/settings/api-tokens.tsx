import { createFileRoute } from "@tanstack/react-router";

import { ApiTokenSettings } from "~/features/organization/api-token-settings";
import { apiTokensQuery } from "~/lib/api/api-tokens";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The API tokens of the organization. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/api-tokens")({
  staticData: { sidebar: { at: "settings", section: "apiTokens" } },
  loader: ({ context, params }) => {
    void context.queryClient.query(apiTokensQuery(params.organizationId)).catch(() => undefined);
  },
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <ApiTokenSettings organizationId={organization.id} />;
}
