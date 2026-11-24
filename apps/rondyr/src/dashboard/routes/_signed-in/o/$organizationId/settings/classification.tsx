import { createFileRoute } from "@tanstack/react-router";

import { ClassificationSettings } from "~/features/organization/classification-settings";
import { classificationQuery } from "~/lib/api/classification";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The classification policy of the organization. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/classification")({
  staticData: { sidebar: { at: "settings", section: "classification" } },
  loader: ({ context, params }) => {
    void context.queryClient
      .query(classificationQuery(params.organizationId))
      .catch(() => undefined);
  },
  component: Page,
});

function Page() {
  const organization = useOrganization();
  return <ClassificationSettings organizationId={organization.id} />;
}
