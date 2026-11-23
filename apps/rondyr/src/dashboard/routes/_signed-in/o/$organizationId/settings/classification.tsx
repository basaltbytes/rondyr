import { createFileRoute } from "@tanstack/react-router";

import { ClassificationSettings } from "~/features/organization/classification-settings";
import { classificationQuery } from "~/lib/api/classification";
import { useOrganization } from "~/routes/-layout/organization-context";

/**
 * The classification policy of the organization. Its form starts from the settings as
 * they are read, so the page waits for a read of its own instead of showing the cache.
 */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/classification")({
  loader: ({ context, params }) =>
    context.queryClient.query({ ...classificationQuery(params.organizationId), staleTime: 0 }).then(
      () => undefined,
      () => undefined,
    ),
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <ClassificationSettings organizationId={organization.id} />;
}
