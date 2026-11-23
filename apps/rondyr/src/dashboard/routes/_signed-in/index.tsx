import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { SignOutButton } from "~/features/authentication/sign-out-button";
import { NewOrganization } from "~/features/organization/new-organization";
import { OrganizationsUnavailable } from "~/features/organization/organizations-unavailable";
import { organizationsQuery } from "~/lib/api/organizations";
import { useSignedOut } from "~/lib/session";

import { useOpenCreatedOrganization } from "~/routes/-layout/organization-shell";

/**
 * The dashboard opens on the messages of the first organization of the account, or on
 * the creation of one when the account has none.
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
  component: FirstRun,
});

function FirstRun() {
  const { t } = useTranslation();
  const { user } = Route.useRouteContext();
  const organizations = useQuery(organizationsQuery);
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
      {organizations.data === undefined ? (
        <output className="text-center text-sm text-muted-foreground">
          {t("inbox.organizations.loading")}
        </output>
      ) : (
        <>
          <NewOrganization onCreated={openCreated} />
          {signOut}
        </>
      )}
    </main>
  );
}
