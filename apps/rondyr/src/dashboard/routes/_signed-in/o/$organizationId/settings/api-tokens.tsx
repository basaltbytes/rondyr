import { createFileRoute } from "@tanstack/react-router";

import { ApiTokenSettings } from "~/features/organization/api-token-settings";
import { apiTokensQuery } from "~/lib/api/api-tokens";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The API tokens of the organization. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/api-tokens")({
  loader: ({ context, params }) =>
    context.queryClient
      .query({ ...apiTokensQuery(params.organizationId), staleTime: "static" })
      .then(
        () => undefined,
        () => undefined,
      ),
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <ApiTokenSettings organizationId={organization.id} />;
}
