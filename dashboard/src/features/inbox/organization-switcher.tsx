import { ChevronsUpDown, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
} from "~/components/ui/sidebar";
import type { Inbox } from "~/lib/inbox-client";

/** The first letters of the first two words, such as "AT" for "Atelier Terre & Feu". */
function initialsOf(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const letters = `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`;
  return letters === "" ? "?" : letters.toUpperCase();
}

function formsLabel(count: number) {
  if (count === 0) return "Aucun formulaire";
  return count === 1 ? "1 formulaire" : `${count} formulaires`;
}

interface OrganizationMarkProps {
  readonly name: string;
}

function OrganizationMark({ name }: OrganizationMarkProps) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
    >
      {initialsOf(name)}
    </span>
  );
}

interface OrganizationSwitcherProps {
  readonly inboxes: readonly Inbox[];
  readonly inbox: Inbox;
  readonly onInbox: (id: string) => void;
  readonly onNew: () => void;
}

/** The open organization, and a menu to open another one or to create one. */
export function OrganizationSwitcher({
  inboxes,
  inbox,
  onInbox,
  onNew,
}: OrganizationSwitcherProps) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={inbox.name}
                aria-label={`Organisation : ${inbox.name}. Changer d’organisation`}
              />
            }
          >
            <OrganizationMark name={inbox.name} />
            <SidebarMenuLabel>
              <span className="block truncate text-foreground">{inbox.name}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground tabular-nums">
                {formsLabel(inbox.forms.length)}
              </span>
            </SidebarMenuLabel>
            <SidebarMenuBadge>
              <ChevronsUpDown aria-hidden="true" className="size-4" />
            </SidebarMenuBadge>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organisations</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={inbox.id} onValueChange={onInbox}>
                {inboxes.map(({ id, name }) => (
                  <DropdownMenuRadioItem key={id} value={id}>
                    <OrganizationMark name={name} />
                    <span className="min-w-0 flex-1 wrap-anywhere">{name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNew}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                <Plus aria-hidden="true" className="size-4" />
              </span>
              Nouvelle organisation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
