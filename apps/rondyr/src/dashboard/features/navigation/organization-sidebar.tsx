import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  Archive,
  CircleCheck,
  CirclePause,
  Inbox as InboxIcon,
  Mails,
  Plus,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { allows } from "@rondyr/organizations/member-role";

import { FormEmoji } from "~/components/form-emoji";
import { ProductLogo } from "~/components/product-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuIcon,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuLink,
  useSidebar,
} from "~/components/ui/sidebar";
import { messageCountsQuery } from "~/lib/api/messages";
import type { Organization } from "~/lib/api/organizations";
import { totalOf } from "~/lib/folder-counts";
import { messagesSearch } from "~/lib/messages-search";

import { OrganizationSwitcher } from "./organization-switcher.tsx";
import type { SidebarPage } from "./sidebar-page.ts";

const folders = [
  ["quarantined", InboxIcon],
  ["accepted", CircleCheck],
  ["archived", Archive],
  ["all", Mails],
] as const;

interface OrganizationSidebarProps {
  readonly organizations: readonly Organization[];
  readonly organization: Organization;
  /** The page shown beside the sidebar. */
  readonly page: SidebarPage;
  /** The text that the list is narrowed to, which a change of folder keeps. */
  readonly searchText: string | null;
  /** The signed-in account and its menu. */
  readonly account: ReactNode;
}

/**
 * The navigation of an organization: its folders of messages and its forms. The
 * settings have a navigation of their own, which takes the place of this one while a
 * page of the settings is open.
 */
export function OrganizationSidebar({
  organizations,
  organization,
  page,
  searchText,
  account,
}: OrganizationSidebarProps) {
  const { t } = useTranslation();
  const { collapsed, setOpenMobile } = useSidebar();
  const { data: counts } = useQuery(messageCountsQuery(organization.id));
  const organizationId = organization.id;
  const close = () => setOpenMobile(false);
  // A reviewer reads and decides; the forms, the settings and the status are an admin's.
  const managesForms = allows(organization.role, "manage-forms");
  const firstSettings = allows(organization.role, "manage-settings")
    ? "members"
    : allows(organization.role, "read-operations")
      ? "operations"
      : null;

  return (
    <Sidebar label={t("inbox.navigation.label")}>
      <SidebarHeader>
        <div className={cn("flex", collapsed ? "justify-center" : "pl-1.5")}>
          <ProductLogo compact={collapsed} />
        </div>
        <OrganizationSwitcher organizations={organizations} organization={organization} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup aria-label={t("inbox.navigation.messages")}>
          <SidebarGroupLabel>{t("inbox.navigation.messages")}</SidebarGroupLabel>
          <SidebarMenu>
            {folders.map(([key, Icon]) => {
              const total = counts === undefined ? null : totalOf(counts, key);
              const label = t(`inbox.folders.${key}`);
              const active = page.at === "messages" && page.folder === key;
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuLink
                    to="/o/$organizationId/messages"
                    params={{ organizationId }}
                    search={messagesSearch(key, null, searchText)}
                    active={active}
                    tooltip={
                      total === null ? label : t("inbox.folderTotal", { folder: label, total })
                    }
                    onClick={close}
                  >
                    <SidebarMenuIcon>
                      <Icon aria-hidden="true" className="size-4" />
                    </SidebarMenuIcon>
                    <SidebarMenuLabel>{label}</SidebarMenuLabel>
                    {total !== null && (
                      <SidebarMenuBadge>
                        <span
                          className={cn(
                            key === "quarantined" &&
                              total > 0 &&
                              !active &&
                              "flex h-5 min-w-5 items-center justify-center rounded-full bg-sidebar-primary px-1.5 text-sidebar-primary-foreground",
                          )}
                        >
                          {total}
                        </span>
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuLink>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
        {managesForms && (
          <SidebarGroup aria-label={t("inbox.sections.forms")}>
            <div className="flex items-center">
              <SidebarGroupLabel className="min-w-0 flex-1">
                {t("inbox.sections.forms")}
              </SidebarGroupLabel>
              {!collapsed && (
                <Link
                  to="/o/$organizationId/forms/new"
                  params={{ organizationId }}
                  aria-label={t("inbox.forms.newTitle")}
                  aria-current={page.at === "newForm" ? "page" : undefined}
                  className="relative flex size-8 shrink-0 items-center justify-center mr-1.5 rounded-md text-sidebar-foreground/70 transition-colors duration-150 ease-out before:absolute before:-inset-1 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-foreground pointer-coarse:mr-0 pointer-coarse:size-11 pointer-coarse:before:hidden"
                  onClick={close}
                >
                  <Plus aria-hidden="true" className="size-4" />
                </Link>
              )}
            </div>
            <SidebarMenu>
              {organization.forms.map((form) => (
                <SidebarMenuItem key={form.publicId}>
                  <SidebarMenuLink
                    to="/o/$organizationId/forms/$publicId"
                    params={{ organizationId, publicId: form.publicId }}
                    active={page.at === "form" && page.publicId === form.publicId}
                    tooltip={form.name}
                    onClick={close}
                  >
                    <SidebarMenuIcon>
                      <FormEmoji form={form} />
                    </SidebarMenuIcon>
                    <SidebarMenuLabel>{form.name}</SidebarMenuLabel>
                    {form.status === "suspended" && (
                      <SidebarMenuBadge>
                        <CirclePause aria-hidden="true" className="size-3.5 opacity-70" />
                        <span className="sr-only">{t("inbox.forms.statuses.suspended")}</span>
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        {firstSettings !== null && (
          <nav aria-label={t("inbox.navigation.settings")}>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuLink
                  to={
                    firstSettings === "members"
                      ? "/o/$organizationId/settings/members"
                      : "/o/$organizationId/status"
                  }
                  params={{ organizationId }}
                  tooltip={t("inbox.navigation.settings")}
                  onClick={close}
                >
                  <SidebarMenuIcon>
                    <Settings aria-hidden="true" className="size-4" />
                  </SidebarMenuIcon>
                  <SidebarMenuLabel>{t("inbox.navigation.settings")}</SidebarMenuLabel>
                </SidebarMenuLink>
              </SidebarMenuItem>
            </SidebarMenu>
          </nav>
        )}
        {account}
      </SidebarFooter>
    </Sidebar>
  );
}
