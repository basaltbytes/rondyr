import { createFileRoute, Navigate } from "@tanstack/react-router";

import { allows } from "@rondyr/organizations/member-role";

import { OperationsPanel } from "~/features/operations/operations-panel";
import { operationsQuery } from "~/lib/api/operations";
import { requirePermission } from "~/routes/-layout/organization-access";
import { useOrganization } from "~/routes/-layout/organization-context";

/** How the processing of the organizations is doing. A reviewer has no status page. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/status")({
  staticData: { sidebar: { at: "settings", section: "operations" } },
  beforeLoad: ({ context }) => requirePermission(context.organization, "read-operations"),
  loader: ({ context }) =>
    context.queryClient.query({ ...operationsQuery, staleTime: "static" }).then(
      () => undefined,
      () => undefined,
    ),
  component: Status,
});

function Status() {
  const organization = useOrganization();
  if (!allows(organization.role, "read-operations")) {
    return (
      <Navigate
        to="/o/$organizationId/messages"
        params={{ organizationId: organization.id }}
        replace
      />
    );
  }
  return <OperationsPanel />;
}
