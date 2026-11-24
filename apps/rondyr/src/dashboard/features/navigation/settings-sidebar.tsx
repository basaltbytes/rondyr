import {
  Activity,
  Ban,
  ChevronLeft,
  Gauge,
  KeyRound,
  Network,
  ScanSearch,
  Timer,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { allows } from "@rondyr/organizations/member-role";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuIcon,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuLink,
  useSidebar,
} from "~/components/ui/sidebar";
import type { Organization } from "~/lib/api/organizations";
import type { MessagesSearch } from "~/lib/messages-search";

import type { SettingsSection } from "./sidebar-page.ts";

// The address of each page of the settings.
const addresses = {
  members: "/o/$organizationId/settings/members",
  apiTokens: "/o/$organizationId/settings/api-tokens",
  retention: "/o/$organizationId/settings/retention",
  classification: "/o/$organizationId/settings/classification",
  domains: "/o/$organizationId/settings/domains",
  blockedTerms: "/o/$organizationId/settings/blocked-terms",
  quotas: "/o/$organizationId/settings/quotas",
  operations: "/o/$organizationId/status",
} as const;

const organizationSettings = [
  ["members", Users],
  ["apiTokens", KeyRound],
  ["retention", Timer],
] as const;
const filteringSettings = [
  ["classification", ScanSearch],
  ["domains", Network],
  ["blockedTerms", Ban],
  ["quotas", Gauge],
] as const;

interface SettingsSidebarProps {
  readonly organization: Organization;
  readonly section: SettingsSection;
  /** The list of messages that was shown before the settings, where Back returns. */
  readonly back: MessagesSearch;
  /** The signed-in account and its menu. */
  readonly account: ReactNode;
}

/** The navigation of the settings and of the status, in place of the organization's. */
export function SettingsSidebar({ organization, section, back, account }: SettingsSidebarProps) {
  const { t } = useTranslation();
  const { setOpenMobile } = useSidebar();
  const organizationId = organization.id;
  const close = () => setOpenMobile(false);

  const entries = (sections: typeof organizationSettings | typeof filteringSettings) =>
    sections.map(([key, Icon]) => (
      <SidebarMenuItem key={key}>
        <SidebarMenuLink
          to={addresses[key]}
          params={{ organizationId }}
          active={section === key}
          tooltip={t(`inbox.sections.${key}`)}
          onClick={close}
        >
          <SidebarMenuIcon>
            <Icon aria-hidden="true" className="size-4" />
          </SidebarMenuIcon>
          <SidebarMenuLabel>{t(`inbox.sections.${key}`)}</SidebarMenuLabel>
        </SidebarMenuLink>
      </SidebarMenuItem>
    ));

  return (
    <Sidebar label={t("inbox.navigation.settings")}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuLink
              to="/o/$organizationId/messages"
              params={{ organizationId }}
              search={back}
              size="lg"
              tooltip={t("inbox.navigation.back")}
              aria-label={t("inbox.navigation.back")}
              onClick={close}
            >
              <SidebarMenuIcon>
                <ChevronLeft aria-hidden="true" className="size-4" />
              </SidebarMenuIcon>
              <SidebarMenuLabel>
                <span className="block truncate text-sidebar-foreground">
                  {t("inbox.navigation.settings")}
                </span>
                <span className="block truncate text-xs font-normal text-sidebar-foreground/70">
                  {t("inbox.navigation.back")}
                </span>
              </SidebarMenuLabel>
            </SidebarMenuLink>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {allows(organization.role, "manage-settings") && (
          <>
            <SidebarGroup aria-label={t("inbox.navigation.organization")}>
              <SidebarGroupLabel>{t("inbox.navigation.organization")}</SidebarGroupLabel>
              <SidebarMenu>{entries(organizationSettings)}</SidebarMenu>
            </SidebarGroup>
            <SidebarGroup aria-label={t("inbox.navigation.filtering")}>
              <SidebarGroupLabel>{t("inbox.navigation.filtering")}</SidebarGroupLabel>
              <SidebarMenu>{entries(filteringSettings)}</SidebarMenu>
            </SidebarGroup>
          </>
        )}
        {allows(organization.role, "read-operations") && (
          <SidebarGroup aria-label={t("inbox.navigation.operations")}>
            <SidebarGroupLabel>{t("inbox.navigation.operations")}</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuLink
                  to={addresses.operations}
                  params={{ organizationId }}
                  active={section === "operations"}
                  tooltip={t("operations.title")}
                  onClick={close}
                >
                  <SidebarMenuIcon>
                    <Activity aria-hidden="true" className="size-4" />
                  </SidebarMenuIcon>
                  <SidebarMenuLabel>{t("operations.title")}</SidebarMenuLabel>
                </SidebarMenuLink>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>{account}</SidebarFooter>
    </Sidebar>
  );
}
