import { ChevronsUpDown, LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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

async function signOut(): Promise<string | null> {
  try {
    const result = await authClient.signOut();
    return result.error === null ? null : "La déconnexion a échoué. Réessayez.";
  } catch {
    return "La déconnexion a échoué. Réessayez.";
  }
}

/** Signs out, and keeps the reason if the request fails. */
function useSignOut() {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function leave() {
    setPending(true);
    setProblem(await signOut());
    setPending(false);
  }

  return { problem, pending, leave: () => void leave() };
}

interface AccountProps {
  readonly email: string;
}

/** The signed-in account at the foot of the sidebar, with its menu. */
export function AccountMenu({ email }: AccountProps) {
  const { problem, pending, leave } = useSignOut();
  return (
    <SidebarMenu>
      {problem !== null && (
        <li role="alert" className="px-2.5 text-xs text-pretty text-destructive">
          {problem}
        </li>
      )}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={email}
                aria-label={`Compte ${email}`}
                disabled={pending}
              />
            }
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-card text-xs font-semibold text-foreground uppercase shadow-raised"
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
              <DropdownMenuItem onClick={leave}>
                <LogOut aria-hidden="true" className="size-4" />
                Se déconnecter
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Signs out from a page without a sidebar, such as the first run. */
export function SignOutButton({ email }: AccountProps) {
  const { problem, pending, leave } = useSignOut();
  return (
    <div className="grid justify-items-start gap-1">
      <p className="text-xs wrap-anywhere text-muted-foreground">{email}</p>
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <Button variant="ghost" disabled={pending} onClick={leave}>
        {pending ? "Déconnexion en cours…" : "Se déconnecter"}
      </Button>
    </div>
  );
}
