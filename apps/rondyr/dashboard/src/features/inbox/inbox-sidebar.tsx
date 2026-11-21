import {
  Activity,
  Archive,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CirclePause,
  Gauge,
  FileText,
  Globe,
  Inbox as InboxIcon,
  KeyRound,
  Mails,
  Network,
  ScanSearch,
  Send,
  Timer,
  Users,
} from "lucide-react";
import { useState } from "react";
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
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuSub,
  useSidebar,
} from "~/components/ui/sidebar";
import type { Counts, Inbox } from "~/lib/inbox-client";
import { cn } from "cn";

import { OrganizationSwitcher } from "./organization-switcher.tsx";
import { formsOfFolder, totalOf } from "./folder-counts.ts";
import type { Folder } from "./folder-counts.ts";
import { storeUnfolded, storedUnfolded } from "./unfolded-folders.ts";

export type Section =
  | "forms"
  | "destinations"
  | "origins"
  | "domains"
  | "classification"
  | "quotas"
  | "apiTokens"
  | "members"
  | "retention"
  | "organization"
  | "operations";

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
  ["domains", Network],
  ["classification", ScanSearch],
  ["quotas", Gauge],
  ["apiTokens", KeyRound],
  ["members", Users],
  ["retention", Timer],
] as const;

interface InboxSidebarProps {
  readonly inboxes: readonly Inbox[];
  readonly inbox: Inbox;
  readonly counts: Counts | null;
  readonly folder: Folder;
  /** The public ID of the form that the list is narrowed to, if any. */
  readonly form: string | null;
  /** The settings page shown in place of the messages, if any. */
  readonly section: Section | null;
  /** The signed-in account and its menu. */
  readonly account: ReactNode;
  readonly onInbox: (id: string) => void;
  /** Open a folder: every message of it, or those of one form. */
  readonly onFolder: (folder: Folder, form: string | null) => void;
  readonly onSection: (section: Section) => void;
}

export function InboxSidebar({
  inboxes,
  inbox,
  counts,
  folder,
  form,
  section,
  account,
  onInbox,
  onFolder,
  onSection,
}: InboxSidebarProps) {
  const { t } = useTranslation();
  const { collapsed, setOpenMobile } = useSidebar();
  const [unfolded, setUnfolded] = useState(storedUnfolded);
  // An organization with one form has nothing to unfold, and its rows stay as
  // they are. With several forms every row keeps the room of the arrow, so the
  // counts stay in one column.
  const unfolds = inbox.forms.length > 1 && !collapsed;

  function toggleUnfolded(key: Folder) {
    const next = unfolded.includes(key)
      ? unfolded.filter((other) => other !== key)
      : [...unfolded, key];
    storeUnfolded(next);
    setUnfolded(next);
  }

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
              const open = section === null && folder === key;
              const parts =
                counts === null || !unfolds
                  ? []
                  : formsOfFolder(inbox.forms, counts, key, open ? form : null);
              const isUnfolded = parts.length > 0 && unfolded.includes(key);
              // A form's row is the current page when the folder shows it.
              const onFormRow = open && form !== null && isUnfolded;
              return (
                <SidebarMenuItem key={key}>
                  <SidebarMenuButton
                    active={open && !onFormRow}
                    activeWithin={onFormRow}
                    hasAction={unfolds}
                    tooltip={
                      total === null ? label : t("inbox.folderTotal", { folder: label, total })
                    }
                    onClick={() => {
                      onFolder(key, null);
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
                  {parts.length > 0 && (
                    <SidebarMenuAction
                      aria-expanded={isUnfolded}
                      aria-label={t("inbox.folderForms", { folder: label })}
                      onClick={() => toggleUnfolded(key)}
                    >
                      {isUnfolded ? (
                        <ChevronDown aria-hidden="true" className="size-4" />
                      ) : (
                        <ChevronRight aria-hidden="true" className="size-4" />
                      )}
                    </SidebarMenuAction>
                  )}
                  {isUnfolded && (
                    <SidebarMenuSub aria-label={t("inbox.folderForms", { folder: label })}>
                      {parts.map(({ form: part, total: inForm }) => (
                        <li key={part.publicId}>
                          <SidebarMenuButton
                            active={open && form === part.publicId}
                            title={part.name}
                            nested
                            hasAction
                            onClick={() => {
                              onFolder(key, part.publicId);
                              setOpenMobile(false);
                            }}
                          >
                            <SidebarMenuLabel>{part.name}</SidebarMenuLabel>
                            {part.status === "suspended" && (
                              <>
                                <CirclePause
                                  aria-hidden="true"
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                />
                                <span className="sr-only">
                                  {t("inbox.forms.statuses.suspended")}
                                </span>
                              </>
                            )}
                            <SidebarMenuBadge>
                              <span
                                className={cn(
                                  key === "quarantined" && inForm > 0 && "text-warning",
                                )}
                              >
                                {inForm}
                              </span>
                            </SidebarMenuBadge>
                          </SidebarMenuButton>
                        </li>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
        {/* A reviewer reads and decides; the settings and the status are an admin's. */}
        {allows(inbox.role, "manage-settings") && (
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
        )}
        {allows(inbox.role, "read-operations") && (
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
        )}
      </SidebarContent>
      <SidebarFooter>{account}</SidebarFooter>
    </Sidebar>
  );
}
