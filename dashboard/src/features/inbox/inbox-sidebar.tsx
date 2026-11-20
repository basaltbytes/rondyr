import {
  Archive,
  CircleCheck,
  FileText,
  Globe,
  Inbox as InboxIcon,
  Mails,
  Send,
} from "lucide-react";
import type { ReactNode } from "react";

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
import { folderLabels, sectionLabels } from "./strings.ts";

export type Folder = keyof typeof folderLabels;
export type Section = keyof typeof sectionLabels;

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

function totalOf(counts: Counts, folder: Folder) {
  if (folder !== "all") return counts[folder];
  return (
    counts.received + counts.classifying + counts.accepted + counts.quarantined + counts.archived
  );
}

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
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar label="Navigation">
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
        <SidebarGroup aria-label="Messages">
          <SidebarGroupLabel>Messages</SidebarGroupLabel>
          <SidebarMenu>
            {folders.map(([key, Icon]) => {
              const total = counts === null ? null : totalOf(counts, key);
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    active={section === null && folder === key}
                    tooltip={total === null ? folderLabels[key] : `${folderLabels[key]} · ${total}`}
                    onClick={() => {
                      onFolder(key);
                      setOpenMobile(false);
                    }}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <SidebarMenuLabel>{folderLabels[key]}</SidebarMenuLabel>
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
        <SidebarGroup aria-label="Réglages">
          <SidebarGroupLabel>Réglages</SidebarGroupLabel>
          <SidebarMenu>
            {settings.map(([key, Icon]) => (
              <SidebarMenuItem key={key}>
                <SidebarMenuButton
                  active={section === key}
                  tooltip={sectionLabels[key]}
                  onClick={() => {
                    onSection(key);
                    setOpenMobile(false);
                  }}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <SidebarMenuLabel>{sectionLabels[key]}</SidebarMenuLabel>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>{account}</SidebarFooter>
    </Sidebar>
  );
}
