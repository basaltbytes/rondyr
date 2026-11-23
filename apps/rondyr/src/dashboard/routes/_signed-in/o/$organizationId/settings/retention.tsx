import { createFileRoute } from "@tanstack/react-router";

import { RetentionSettings } from "~/features/organization/retention-settings";
import { retentionQuery } from "~/lib/api/retention";
import { useOrganization } from "~/routes/-layout/organization-context";

/** How long the organization keeps its messages. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/retention")({
  loader: ({ context, params }) =>
    context.queryClient
      .query({ ...retentionQuery(params.organizationId), staleTime: "static" })
      .then(
        () => undefined,
        () => undefined,
      ),
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <RetentionSettings organizationId={organization.id} />;
}
