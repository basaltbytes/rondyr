import { createFileRoute } from "@tanstack/react-router";

import { MemberSettings } from "~/features/organization/member-settings";
import { membersQuery } from "~/lib/api/members";
import { useOrganization } from "~/routes/-layout/organization-context";

/** The members of the organization and its invitations. */
export const Route = createFileRoute("/_signed-in/o/$organizationId/settings/members")({
  staticData: { sidebar: { at: "settings", section: "members" } },
  loader: ({ context, params }) =>
    context.queryClient.query({ ...membersQuery(params.organizationId), staleTime: "static" }).then(
      () => undefined,
      () => undefined,
    ),
  component: Page,
});

function Page() {
  const organization = useOrganization();
  const { user } = Route.useRouteContext();
  return <MemberSettings organizationId={organization.id} self={user.id} />;
}
