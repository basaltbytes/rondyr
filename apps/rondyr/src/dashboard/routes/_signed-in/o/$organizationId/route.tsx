import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";

import { PagePending } from "~/components/page-pending";
import { SignOutButton } from "~/features/authentication/sign-out-button";
import { OrganizationsUnavailable } from "~/features/organization/organizations-unavailable";
import { messageCountsQuery } from "~/lib/api/messages";
import { organizationsQuery } from "~/lib/api/organizations";
import { useSignedOut } from "~/lib/session";
import { organizationOf } from "~/routes/-layout/organization-access";
import { OrganizationShell, useSidebarPage } from "~/routes/-layout/organization-shell";

/**
 * The layout of an organization: the sidebar, and the page beside it. An organization
 * that the account is not a member of shows the page of an unknown address.
 */
export const Route = createFileRoute("/_signed-in/o/$organizationId")({
  beforeLoad: async ({ context, params }) => ({
    organization: await organizationOf(context.queryClient, params.organizationId),
  }),
  loader: async ({ context, params, cause }) => {
    // A reload, a change of organization and the first visit count the messages again.
    // A decision and a deletion move the counts in the cache, and Refresh counts again.
    if (cause === "enter") {
      await context.queryClient.invalidateQueries({
        queryKey: messageCountsQuery(params.organizationId).queryKey,
        refetchType: "none",
      });
    }
  },
  component: OrganizationLayout,
});

function OrganizationLayout() {
  const { organizationId } = Route.useParams();
  const { user } = Route.useRouteContext();
  const organizations = useQuery(organizationsQuery);
  const page = useSidebarPage();
  const signedOut = useSignedOut();

  if (organizations.isError && organizations.data === undefined) {
    return (
      <OrganizationsUnavailable
        cause={organizations.error}
        retrying={organizations.isFetching}
        onRetry={() => void organizations.refetch()}
        signOut={<SignOutButton email={user.email} onSignedOut={signedOut} />}
      />
    );
  }
  if (organizations.data === undefined) return <PagePending />;
  const organization = organizations.data.find(({ id }) => id === organizationId);
  // The account left the organization while it was open.
  if (organization === undefined) return <Navigate to="/" replace />;
  return (
    <OrganizationShell
      key={organization.id}
      organizations={organizations.data}
      organization={organization}
      page={page}
    >
      <Outlet />
    </OrganizationShell>
  );
}
