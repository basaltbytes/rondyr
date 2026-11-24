import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { allows } from "@rondyr/organizations/member-role";

import { requirePermission } from "~/routes/-layout/organization-access";
import { useOrganization } from "~/routes/-layout/organization-context";

/**
 * The pages of the settings, which are an admin's. A reviewer, or an admin who stepped
 * down while one was open, goes to the messages.
 */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings")({
  beforeLoad: ({ context }) => requirePermission(context.organization, "manage-settings"),
  component: Settings,
});

function Settings() {
  const organization = useOrganization();
  if (!allows(organization.role, "manage-settings")) {
    return (
      <Navigate
        to="/o/$organizationId/messages"
        params={{ organizationId: organization.id }}
        replace
      />
    );
  }
  return <Outlet />;
}
