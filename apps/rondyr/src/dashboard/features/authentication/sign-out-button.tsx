import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";

import { useSignOut } from "./use-sign-out.ts";

interface SignOutButtonProps {
  readonly email: string;
  /** Leaves the dashboard for the sign-in page, once the session has ended. */
  readonly onSignedOut: () => Promise<void>;
}

/** Signs out from a page without a sidebar, such as the first run. */
export function SignOutButton({ email, onSignedOut }: SignOutButtonProps) {
  const { t } = useTranslation();
  const { failed, pending, leave } = useSignOut(onSignedOut);
  return (
    <div className="grid gap-1 px-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-xs wrap-anywhere text-muted-foreground">{email}</p>
        <Button variant="ghost" size="sm" disabled={pending} onClick={leave}>
          {pending ? t("authentication.signOut.pending") : t("authentication.signOut.submit")}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {t("authentication.signOut.failed")}
        </p>
      )}
    </div>
  );
}
