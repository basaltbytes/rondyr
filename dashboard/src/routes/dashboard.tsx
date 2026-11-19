import { SessionPanel } from "~/features/authentication/session-panel";
import { InboxPanel } from "~/features/inbox/inbox-panel";
import { authClient } from "~/lib/auth-client";

export function Dashboard() {
  const session = authClient.useSession();
  return (
    <main>
      <h1>Rondyr</h1>
      <SessionPanel />
      {session.data !== null && session.data !== undefined && (
        <InboxPanel key={session.data.user.id} />
      )}
    </main>
  );
}
