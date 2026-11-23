import {
  Activity,
  Archive,
  ChevronLeft,
  CircleCheck,
  CirclePause,
  Gauge,
  Inbox as InboxIcon,
  KeyRound,
  Mails,
  Network,
  Plus,
  ScanSearch,
  Settings,
  Timer,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { allows } from "@rondyr/organizations/member-role";

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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  useSidebar,
} from "~/components/ui/sidebar";
import type { Counts, Inbox } from "~/lib/inbox-client";
import { cn } from "cn";

import { FormEmoji } from "~/components/form-emoji";
import { OrganizationSwitcher } from "./organization-switcher.tsx";
import { totalOf } from "~/lib/folder-counts";
import type { Folder } from "~/lib/folder-counts";

type Form = Inbox["forms"][number];

/** A page of the organization's settings, or the status of the processing. */
export type SettingsSection =
  | "members"
  | "apiTokens"
  | "retention"
  | "classification"
  | "domains"
  | "quotas"
  | "operations";

/** What the dashboard shows in place of the messages. */
export type Page =
  | { readonly at: "form"; readonly publicId: Form["publicId"] }
  | { readonly at: "newForm" }
  | { readonly at: "organization" }
  | { readonly at: "settings"; readonly section: SettingsSection };

const folders = [
  ["quarantined", InboxIcon],
  ["accepted", CircleCheck],
  ["archived", Archive],
  ["all", Mails],
] as const;
const organizationSettings = [
  ["members", Users],
  ["apiTokens", KeyRound],
  ["retention", Timer],
] as const;
const filteringSettings = [
  ["classification", ScanSearch],
  ["domains", Network],
  ["quotas", Gauge],
] as const;

interface OrganizationSidebarProps {
  readonly inboxes: readonly Inbox[];
  readonly inbox: Inbox;
  readonly counts: Counts | null;
  readonly folder: Folder;
  /** The page shown in place of the messages, if any. */
  readonly page: Page | null;
  /** The signed-in account and its menu. */
  readonly account: ReactNode;
  readonly onInbox: (id: string) => void;
  readonly onFolder: (folder: Folder) => void;
  /** Leave the settings for the messages that were shown before them. */
  readonly onBack: () => void;
  readonly onPage: (page: Page) => void;
}

/**
 * The navigation of an organization: its folders of messages and its forms.
 * The settings have a navigation of their own, which takes the place of this
 * one while a page of the settings is open.
 */
export function OrganizationSidebar({
  inboxes,
  inbox,
  counts,
  folder,
  page,
  account,
  onInbox,
  onFolder,
  onBack,
  onPage,
}: OrganizationSidebarProps) {
  const { t } = useTranslation();
  const { collapsed, setOpenMobile } = useSidebar();

  function open(next: Page) {
    onPage(next);
    setOpenMobile(false);
  }

  if (page?.at === "settings") {
    const entries = (sections: typeof organizationSettings | typeof filteringSettings) =>
      sections.map(([key, Icon]) => (
        <SidebarMenuItem key={key}>
          <SidebarMenuButton
            active={page.section === key}
            tooltip={t(`inbox.sections.${key}`)}
            onClick={() => open({ at: "settings", section: key })}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <SidebarMenuLabel>{t(`inbox.sections.${key}`)}</SidebarMenuLabel>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ));
    return (
      <Sidebar label={t("inbox.navigation.settings")}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip={t("inbox.navigation.back")}
                aria-label={t("inbox.navigation.back")}
                onClick={() => {
                  onBack();
                  setOpenMobile(false);
                }}
              >
                <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />
                <SidebarMenuLabel>
                  <span className="block truncate text-sidebar-foreground">
                    {t("inbox.navigation.settings")}
                  </span>
                  <span className="block truncate text-xs font-normal text-sidebar-foreground/70">
                    {t("inbox.navigation.back")}
                  </span>
                </SidebarMenuLabel>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {allows(inbox.role, "manage-settings") && (
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
          {allows(inbox.role, "read-operations") && (
            <SidebarGroup aria-label={t("inbox.navigation.operations")}>
              <SidebarGroupLabel>{t("inbox.navigation.operations")}</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    active={page.section === "operations"}
                    tooltip={t("operations.title")}
                    onClick={() => open({ at: "settings", section: "operations" })}
                  >
                    <Activity aria-hidden="true" className="size-4 shrink-0" />
                    <SidebarMenuLabel>{t("operations.title")}</SidebarMenuLabel>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
        </SidebarContent>
        <SidebarFooter>{account}</SidebarFooter>
      </Sidebar>
    );
  }

  // A reviewer reads and decides; the forms, the settings and the status are an admin's.
  const managesForms = allows(inbox.role, "manage-forms");
  const firstSettings: SettingsSection | null = allows(inbox.role, "manage-settings")
    ? "members"
    : allows(inbox.role, "read-operations")
      ? "operations"
      : null;

  return (
    <Sidebar label={t("inbox.navigation.label")}>
      <SidebarHeader>
        <div className={cn("flex", collapsed ? "justify-center" : "px-1")}>
          <ProductLogo compact={collapsed} />
        </div>
        <OrganizationSwitcher
          inboxes={inboxes}
          inbox={inbox}
          onInbox={onInbox}
          onNew={() => open({ at: "organization" })}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup aria-label={t("inbox.navigation.messages")}>
          <SidebarGroupLabel>{t("inbox.navigation.messages")}</SidebarGroupLabel>
          <SidebarMenu>
            {folders.map(([key, Icon]) => {
              const total = counts === null ? null : totalOf(counts, key);
              const label = t(`inbox.folders.${key}`);
              const active = page === null && folder === key;
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    active={active}
                    tooltip={
                      total === null ? label : t("inbox.folderTotal", { folder: label, total })
                    }
                    onClick={() => {
                      onFolder(key);
                      setOpenMobile(false);
                    }}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <SidebarMenuLabel>{label}</SidebarMenuLabel>
                    {total !== null && (
                      <SidebarMenuBadge>
                        <span
                          className={cn(
                            key === "quarantined" &&
                              total > 0 &&
                              !active &&
                              "rounded-full bg-sidebar-primary px-1.5 py-0.5 text-sidebar-primary-foreground",
                          )}
                        >
                          {total}
                        </span>
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuButton>
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
                <button
                  type="button"
                  aria-label={t("inbox.forms.newTitle")}
                  aria-current={page?.at === "newForm" ? "page" : undefined}
                  className="relative flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors duration-150 ease-out before:absolute before:-inset-1 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-sidebar-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-foreground pointer-coarse:size-11 pointer-coarse:before:hidden"
                  onClick={() => open({ at: "newForm" })}
                >
                  <Plus aria-hidden="true" className="size-4" />
                </button>
              )}
            </div>
            <SidebarMenu>
              {inbox.forms.map((form) => (
                <SidebarMenuItem key={form.publicId}>
                  <SidebarMenuButton
                    active={page?.at === "form" && page.publicId === form.publicId}
                    tooltip={form.name}
                    onClick={() => open({ at: "form", publicId: form.publicId })}
                  >
                    <FormEmoji form={form} />
                    <SidebarMenuLabel>{form.name}</SidebarMenuLabel>
                    {form.status === "suspended" && !collapsed && (
                      <>
                        <CirclePause aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
                        <span className="sr-only">{t("inbox.forms.statuses.suspended")}</span>
                      </>
                    )}
                  </SidebarMenuButton>
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
                <SidebarMenuButton
                  tooltip={t("inbox.navigation.settings")}
                  onClick={() => open({ at: "settings", section: firstSettings })}
                >
                  <Settings aria-hidden="true" className="size-4 shrink-0" />
                  <SidebarMenuLabel>{t("inbox.navigation.settings")}</SidebarMenuLabel>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </nav>
        )}
        {account}
      </SidebarFooter>
    </Sidebar>
  );
}
