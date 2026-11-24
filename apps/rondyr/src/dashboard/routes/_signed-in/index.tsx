import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CardFormSkeleton } from "~/components/page-pending";
import { ProductLogo } from "~/components/product-logo";
import { Card, CardContent } from "~/components/ui/card";
import { SignOutButton } from "~/features/authentication/sign-out-button";
import { NewOrganization } from "~/features/organization/new-organization";
import { NoOrganization } from "~/features/organization/no-organization";
import { OrganizationsUnavailable } from "~/features/organization/organizations-unavailable";
import { organizationCreationQuery, organizationsQuery } from "~/lib/api/organizations";
import { useSignedOut } from "~/lib/session";

import { useOpenCreatedOrganization } from "~/routes/-layout/organization-shell";

/**
 * The dashboard opens on the messages of the first organization of the account. An
 * account without one gets the creation of the first organization when the Worker
 * allows it (the instance has none yet), and otherwise a page that says to ask for an
 * invitation.
 */
export const Route = createFileRoute("/_signed-in/")({
  beforeLoad: async ({ context }) => {
    const organizations = await context.queryClient
      .query({ ...organizationsQuery, staleTime: "static" })
      .catch(() => undefined);
    const first = organizations?.[0];
    if (first !== undefined) {
      throw redirect({
        to: "/o/$organizationId/messages",
        params: { organizationId: first.id },
        replace: true,
      });
    }
  },
  // Only an account without an organization gets this far.
  loader: ({ context }) => {
    void context.queryClient.query(organizationCreationQuery).catch(() => undefined);
  },
  component: FirstRun,
});

function FirstRun() {
  const { t } = useTranslation();
  const { user } = Route.useRouteContext();
  const organizations = useQuery(organizationsQuery);
  const creation = useQuery({
    ...organizationCreationQuery,
    enabled: organizations.data?.length === 0,
  });
  const signedOut = useSignedOut();
  const openCreated = useOpenCreatedOrganization([]);
  const signOut = <SignOutButton email={user.email} onSignedOut={signedOut} />;

  if (organizations.isError) {
    return (
      <OrganizationsUnavailable
        cause={organizations.error}
        retrying={organizations.isFetching}
        onRetry={() => void organizations.refetch()}
        signOut={signOut}
      />
    );
  }
  if (creation.isError) {
    return (
      <OrganizationsUnavailable
        cause={creation.error}
        retrying={creation.isFetching}
        onRetry={() => void creation.refetch()}
        signOut={signOut}
      />
    );
  }
  const first = organizations.data?.[0];
  if (first !== undefined) {
    return (
      <Navigate to="/o/$organizationId/messages" params={{ organizationId: first.id }} replace />
    );
  }
  return (
    <main className="mx-auto grid max-w-xl gap-5 px-5 py-12">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      {creation.data === undefined ? (
        <Card>
          <CardContent>
            <CardFormSkeleton label={t("inbox.organizations.loading")} />
          </CardContent>
        </Card>
      ) : (
        <>
          {creation.data.allowed ? <NewOrganization onCreated={openCreated} /> : <NoOrganization />}
          {signOut}
        </>
      )}
    </main>
  );
}
