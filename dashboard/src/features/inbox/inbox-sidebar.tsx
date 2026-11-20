import {
  Activity,
  Archive,
  CircleCheck,
  FileText,
  Globe,
  Inbox as InboxIcon,
  Mails,
  Send,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

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

import { OrganizationSwitcher } from "./organization-switcher.tsx";
import { totalOf } from "./folder-counts.ts";
import type { Folder } from "./folder-counts.ts";

export type Section = "forms" | "destinations" | "origins" | "organization" | "operations";

const folders = [
  ["quarantined", InboxIcon],
  ["accepted", CircleCheck],
  ["archived", Archive],
  ["all", Mails],
] as const;
const settings = [
  ["forms", FileText],
  ["destinations", Send],
  ["origins", Globe],
] as const;

interface InboxSidebarProps {
  readonly inboxes: readonly Inbox[];
  readonly inbox: Inbox;
  readonly counts: Counts | null;
  readonly folder: Folder;
  /** The settings page shown in place of the messages, if any. */
  readonly section: Section | null;
  /** The signed-in account and its menu. */
  readonly account: ReactNode;
  readonly onInbox: (id: string) => void;
  readonly onFolder: (folder: Folder) => void;
  readonly onSection: (section: Section) => void;
}

export function InboxSidebar({
  inboxes,
  inbox,
  counts,
  folder,
  section,
  account,
  onInbox,
  onFolder,
  onSection,
}: InboxSidebarProps) {
  const { t } = useTranslation();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar label={t("inbox.navigation.label")}>
      <SidebarHeader>
        <OrganizationSwitcher
          inboxes={inboxes}
          inbox={inbox}
          onInbox={onInbox}
          onNew={() => {
            onSection("organization");
            setOpenMobile(false);
          }}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup aria-label={t("inbox.navigation.messages")}>
          <SidebarGroupLabel>{t("inbox.navigation.messages")}</SidebarGroupLabel>
          <SidebarMenu>
            {folders.map(([key, Icon]) => {
              const total = counts === null ? null : totalOf(counts, key);
              const label = t(`inbox.folders.${key}`);
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    active={section === null && folder === key}
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
                        <span className={cn(key === "quarantined" && total > 0 && "text-warning")}>
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
        <SidebarGroup aria-label={t("inbox.navigation.settings")}>
          <SidebarGroupLabel>{t("inbox.navigation.settings")}</SidebarGroupLabel>
          <SidebarMenu>
            {settings.map(([key, Icon]) => (
              <SidebarMenuItem key={key}>
                <SidebarMenuButton
                  active={section === key}
                  tooltip={t(`inbox.sections.${key}`)}
                  onClick={() => {
                    onSection(key);
                    setOpenMobile(false);
                  }}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <SidebarMenuLabel>{t(`inbox.sections.${key}`)}</SidebarMenuLabel>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup aria-label={t("inbox.navigation.operations")}>
          <SidebarGroupLabel>{t("inbox.navigation.operations")}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                active={section === "operations"}
                tooltip={t("operations.title")}
                onClick={() => {
                  onSection("operations");
                  setOpenMobile(false);
                }}
              >
                <Activity aria-hidden="true" className="size-4 shrink-0" />
                <SidebarMenuLabel>{t("operations.title")}</SidebarMenuLabel>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>{account}</SidebarFooter>
    </Sidebar>
  );
}
