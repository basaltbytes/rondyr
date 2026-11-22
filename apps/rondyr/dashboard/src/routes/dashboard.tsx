import { lazy } from "react";
import { useTranslation } from "react-i18next";

import { ProductLogo } from "~/components/product-logo";
import { AccountMenu, SignOutButton } from "~/features/authentication/account";
import { SignedOut } from "~/features/authentication/owner-setup";
import { InboxPanel } from "~/features/inbox/inbox-panel";
import { authClient } from "~/lib/auth-client";

// The status page is not part of the first paint, so its code loads when it opens.
// The inbox shows it inside its own Suspense boundary.
const OperationsPanel = lazy(async () => {
  const { OperationsPanel: Panel } = await import("~/features/operations/operations-panel");
  return { default: Panel };
});

export function Dashboard() {
  const { t } = useTranslation();
  const session = authClient.useSession();
  if (session.isPending) {
    return (
      <output className="block p-6 text-sm text-muted-foreground">{t("session.checking")}</output>
    );
  }
  if (session.data === null || session.data === undefined) {
    return (
      <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
        <h1>
          <ProductLogo />
        </h1>
        <SignedOut />
      </main>
    );
  }
  const { user } = session.data;
  return (
    <InboxPanel
      key={user.id}
      account={<AccountMenu email={user.email} />}
      signOut={<SignOutButton email={user.email} />}
      operations={<OperationsPanel />}
    />
  );
}
