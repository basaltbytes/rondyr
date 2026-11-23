import { ChevronsUpDown, LogOut } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
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
import { authClient } from "~/lib/auth-client";
import { setLanguage, useLanguage } from "~/lib/i18n";
import { chooseLanguage, languages } from "~/lib/language";

/** Ends the session. Returns whether it worked. */
async function signOut() {
  try {
    const result = await authClient.signOut();
    return result.error === null;
  } catch {
    return false;
  }
}

/** Signs out, and remembers a request that fails. */
function useSignOut() {
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  async function leave() {
    setPending(true);
    setFailed(!(await signOut()));
    setPending(false);
  }

  return { failed, pending, leave: () => void leave() };
}

interface AccountProps {
  readonly email: string;
}

/** The signed-in account at the foot of the sidebar, with its menu. */
export function AccountMenu({ email }: AccountProps) {
  const { t } = useTranslation();
  const language = useLanguage();
  const { failed, pending, leave } = useSignOut();
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
              className="flex size-8 shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground uppercase"
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

/** Signs out from a page without a sidebar, such as the first run. */
export function SignOutButton({ email }: AccountProps) {
  const { t } = useTranslation();
  const { failed, pending, leave } = useSignOut();
  return (
    <div className="grid justify-items-start gap-1">
      <p className="text-xs wrap-anywhere text-muted-foreground">{email}</p>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t("authentication.signOut.failed")}
        </p>
      )}
      <Button variant="ghost" disabled={pending} onClick={leave}>
        {pending ? t("authentication.signOut.pending") : t("authentication.signOut.submit")}
      </Button>
    </div>
  );
}
