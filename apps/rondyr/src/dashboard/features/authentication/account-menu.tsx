import { ChevronsUpDown, LogOut } from "lucide-react";
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
import { setTheme, useTheme } from "~/lib/appearance";
import { setLanguage, useLanguage } from "~/lib/i18n";
import { chooseLanguage, languages } from "~/lib/language";
import { chooseTheme, themes } from "~/lib/theme";

import { useSignOut } from "./use-sign-out.ts";

interface AccountMenuProps {
  readonly email: string;
  /** Leaves the dashboard for the sign-in page, once the session has ended. */
  readonly onSignedOut: () => Promise<void>;
}

/** The signed-in account at the foot of the sidebar, with its menu. */
export function AccountMenu({ email, onSignedOut }: AccountMenuProps) {
  const { t } = useTranslation();
  const language = useLanguage();
  const theme = useTheme();
  const { failed, pending, leave } = useSignOut(onSignedOut);
  return (
    <SidebarMenu>
      {failed && (
        <li
          role="alert"
          className="rounded-md bg-destructive px-2.5 py-1 text-xs text-pretty text-destructive-foreground"
        >
          {t("authentication.signOut.failed")}
        </li>
      )}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={email}
                aria-label={t("authentication.account.label", { email })}
                disabled={pending}
              />
            }
          >
            <span
              aria-hidden="true"
              className="flex size-(--sidebar-rail) shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground uppercase"
            >
              {email.slice(0, 1)}
            </span>
            <SidebarMenuLabel>{email}</SidebarMenuLabel>
            <SidebarMenuBadge>
              <ChevronsUpDown aria-hidden="true" className="size-4" />
            </SidebarMenuBadge>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="wrap-anywhere">{email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("authentication.account.language")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={language}
                onValueChange={(value: string) => setLanguage(chooseLanguage(value, []))}
              >
                {languages.map((code) => (
                  <DropdownMenuRadioItem key={code} value={code}>
                    <span className="min-w-0 flex-1">{t(`languages.${code}`)}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("authentication.account.theme")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value: string) => setTheme(chooseTheme(value))}
              >
                {themes.map((name) => (
                  <DropdownMenuRadioItem key={name} value={name}>
                    <span className="min-w-0 flex-1">{t(`themes.${name}`)}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={leave}>
              <LogOut aria-hidden="true" className="size-4" />
              {t("authentication.signOut.submit")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
