import { useQueryClient } from "@tanstack/react-query";
import {
  useMatches,
  useNavigate,
  useParams,
  useRouteContext,
  useSearch,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { AccountMenu } from "~/features/authentication/account";
import { OrganizationSidebar } from "~/features/navigation/organization-sidebar";
import { SettingsSidebar } from "~/features/navigation/settings-sidebar";
import type { SidebarPage } from "~/features/navigation/sidebar-page";
import { organizationsQuery, type Organization } from "~/lib/api/organizations";
import { useSignedOut } from "~/lib/session";

import { lastMessages } from "./last-messages.ts";
import { OrganizationContext } from "./organization-context.ts";

/** The page of the address, which the sidebar marks as current. */
export function useSidebarPage(): SidebarPage {
  const routeId = useMatches({ select: (matches) => matches.at(-1)?.routeId });
  const { publicId } = useParams({ strict: false });
  const { folder } = useSearch({ strict: false });
  switch (routeId) {
    case "/_signed-in/o/$organizationId/forms/new":
      return { at: "newForm" };
    case "/_signed-in/o/$organizationId/forms/$publicId":
      return { at: "form", publicId: publicId ?? "" };
    case "/_signed-in/o/$organizationId/settings/members":
      return { at: "settings", section: "members" };
    case "/_signed-in/o/$organizationId/settings/api-tokens":
      return { at: "settings", section: "apiTokens" };
    case "/_signed-in/o/$organizationId/settings/retention":
      return { at: "settings", section: "retention" };
    case "/_signed-in/o/$organizationId/settings/classification":
      return { at: "settings", section: "classification" };
    case "/_signed-in/o/$organizationId/settings/domains":
      return { at: "settings", section: "domains" };
    case "/_signed-in/o/$organizationId/settings/quotas":
      return { at: "settings", section: "quotas" };
    case "/_signed-in/o/$organizationId/status":
      return { at: "settings", section: "operations" };
    default:
      return { at: "messages", folder: folder ?? "quarantined" };
  }
}

/**
 * Opens the organization that the account just created: the organizations are read
 * again by then, and the new one is the one that `known` did not have.
 */
export function useOpenCreatedOrganization(known: readonly Organization[]) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    const organizations = queryClient.getQueryData(organizationsQuery.queryKey) ?? [];
    const created =
      organizations.find(({ id }) => !known.some((other) => other.id === id)) ?? organizations[0];
    if (created === undefined) return;
    await navigate({ to: "/o/$organizationId/messages", params: { organizationId: created.id } });
  };
}

interface OrganizationShellProps {
  readonly organizations: readonly Organization[];
  readonly organization: Organization;
  /** The page beside the sidebar. */
  readonly page: SidebarPage;
  readonly children: ReactNode;
}

/**
 * The layout of an organization: its sidebar, or the sidebar of the settings while one
 * of their pages is open, with the account menu at its foot, and the page beside it.
 */
export function OrganizationShell({
  organizations,
  organization,
  page,
  children,
}: OrganizationShellProps) {
  const { user } = useRouteContext({ from: "/_signed-in" });
  const { q } = useSearch({ strict: false });
  const signedOut = useSignedOut();
  const account = <AccountMenu email={user.email} onSignedOut={signedOut} />;
  return (
    <OrganizationContext value={organization}>
      <SidebarProvider className="lg:h-dvh lg:overflow-hidden">
        {page.at === "settings" ? (
          <SettingsSidebar
            organization={organization}
            section={page.section}
            back={lastMessages(organization.id)}
            account={account}
          />
        ) : (
          <OrganizationSidebar
            organizations={organizations}
            organization={organization}
            page={page}
            searchText={q ?? null}
            account={account}
          />
        )}
        <SidebarInset className="lg:grid lg:h-dvh lg:inbox-panes">{children}</SidebarInset>
      </SidebarProvider>
    </OrganizationContext>
  );
}
