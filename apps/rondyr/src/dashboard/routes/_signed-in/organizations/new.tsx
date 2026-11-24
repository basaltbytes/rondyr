import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect, useRouterState } from "@tanstack/react-router";

import { SidebarTrigger } from "~/components/ui/sidebar";
import { SignOutButton } from "~/features/authentication/sign-out-button";
import { NewOrganization } from "~/features/organization/new-organization";
import { OrganizationsUnavailable } from "~/features/organization/organizations-unavailable";
import { organizationsQuery } from "~/lib/api/organizations";
import { useSignedOut } from "~/lib/session";
import { OrganizationShell, useOpenCreatedOrganization } from "~/routes/-layout/organization-shell";

/**
 * The creation of another organization, beside the sidebar of the organization it was
 * opened from. Only an account that administers at least one organization can open it.
 * Once created, the new organization opens.
 */
export const Route = createFileRoute("/_signed-in/organizations/new")({
  staticData: { sidebar: { at: "organization" } },
  beforeLoad: async ({ context, location }) => {
    const organizations = await context.queryClient
      .query({ ...organizationsQuery, staleTime: "static" })
      .catch(() => undefined);
    if (organizations === undefined) return;
    const organization =
      organizations.find(({ id }) => id === location.state.organizationId) ?? organizations[0];
    if (organization === undefined) throw redirect({ to: "/", replace: true });
    if (!organizations.some(({ role }) => role === "admin")) {
      throw redirect({
        to: "/o/$organizationId/messages",
        params: { organizationId: organization.id },
        replace: true,
      });
    }
  },
  component: NewOrganizationPage,
});

function NewOrganizationPage() {
  const { user } = Route.useRouteContext();
  const organizations = useQuery(organizationsQuery);
  const from = useRouterState({ select: ({ location }) => location.state.organizationId });
  const signedOut = useSignedOut();
  const known = organizations.data ?? [];
  const openCreated = useOpenCreatedOrganization(known);

  if (organizations.isError) {
    return (
      <OrganizationsUnavailable
        cause={organizations.error}
        retrying={organizations.isFetching}
        onRetry={() => void organizations.refetch()}
        signOut={<SignOutButton email={user.email} onSignedOut={signedOut} />}
      />
    );
  }
  const organization = known.find(({ id }) => id === from) ?? known[0];
  // An account without an organization creates its first one where the dashboard opens.
  if (organization === undefined) return <Navigate to="/" replace />;
  // Only an admin of an existing organization can create another one.
  if (!known.some(({ role }) => role === "admin")) {
    return (
      <Navigate
        to="/o/$organizationId/messages"
        params={{ organizationId: organization.id }}
        replace
      />
    );
  }
  return (
    <OrganizationShell organizations={known} organization={organization}>
      <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
        <header className="flex h-14 items-center px-1">
          <SidebarTrigger />
        </header>
        <div className="mx-auto max-w-xl px-5 pb-8">
          <NewOrganization onCreated={openCreated} />
        </div>
      </main>
    </OrganizationShell>
  );
}
