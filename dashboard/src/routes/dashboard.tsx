import { AccountMenu, SignOutButton } from "~/features/authentication/account";
import { SignInForm } from "~/features/authentication/sign-in-form";
import { InboxPanel } from "~/features/inbox/inbox-panel";
import { OperationsPanel } from "~/features/operations/operations-panel";
import { authClient } from "~/lib/auth-client";

export function Dashboard() {
  const session = authClient.useSession();
  if (session.isPending) {
    return (
      <output className="block p-6 text-sm text-muted-foreground">
        Vérification de la session…
      </output>
    );
  }
  if (session.data === null || session.data === undefined) {
    return (
      <main className="mx-auto grid max-w-sm gap-5 px-5 py-16">
        <h1 className="text-lg font-semibold">Rondyr</h1>
        <SignInForm />
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
