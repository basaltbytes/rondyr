import { useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronsUpDown, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

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
import type { Organization } from "~/lib/api/organizations";

import { initialsOf } from "./initials.ts";

interface OrganizationMarkProps {
  readonly name: string;
}

function OrganizationMark({ name }: OrganizationMarkProps) {
  return (
    <span
      aria-hidden="true"
      className="flex size-(--sidebar-rail) shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
    >
      {initialsOf(name)}
    </span>
  );
}

interface OrganizationSwitcherProps {
  readonly organizations: readonly Organization[];
  readonly organization: Organization;
}

/** The open organization, and a menu to open another one or to create one. */
export function OrganizationSwitcher({ organizations, organization }: OrganizationSwitcherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  const canCreate = organizations.some(({ role }) => role === "admin");
  const preloadOrganization = (organizationId: string) => {
    if (organizationId === organization.id) return;
    void router
      .preloadRoute({ to: "/o/$organizationId/messages", params: { organizationId } })
      .catch(() => undefined);
  };
  const preloadNewOrganization = () => {
    if (!canCreate) return;
    void router.preloadRoute({ to: "/organizations/new" }).catch(() => undefined);
  };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={organization.name}
                aria-label={t("inbox.organizations.switcher", { name: organization.name })}
              />
            }
          >
            <OrganizationMark name={organization.name} />
            <SidebarMenuLabel>
              <span className="block truncate text-sidebar-foreground">{organization.name}</span>
              <span className="block truncate text-xs font-normal text-sidebar-foreground/70 tabular-nums">
                {t("inbox.organizations.forms", { count: organization.forms.length })}
              </span>
            </SidebarMenuLabel>
            <SidebarMenuBadge>
              <ChevronsUpDown aria-hidden="true" className="size-4" />
            </SidebarMenuBadge>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("inbox.organizations.title")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={organization.id}
                onValueChange={(organizationId: string) =>
                  void navigate({ to: "/o/$organizationId/messages", params: { organizationId } })
                }
              >
                {organizations.map(({ id, name }) => (
                  <DropdownMenuRadioItem
                    key={id}
                    value={id}
                    onMouseEnter={() => preloadOrganization(id)}
                    onFocus={() => preloadOrganization(id)}
                  >
                    <OrganizationMark name={name} />
                    <span className="min-w-0 flex-1 wrap-anywhere">{name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {canCreate && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onMouseEnter={preloadNewOrganization}
                  onFocus={preloadNewOrganization}
                  onClick={() =>
                    void navigate({
                      to: "/organizations/new",
                      state: { organizationId: organization.id },
                    })
                  }
                >
                  <span className="flex size-(--sidebar-rail) shrink-0 items-center justify-center rounded-md bg-muted">
                    <Plus aria-hidden="true" className="size-4" />
                  </span>
                  {t("inbox.sections.organization")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
