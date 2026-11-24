import { useState } from "react";

import { authClient } from "~/lib/api/session";

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
export function useSignOut(onSignedOut: () => Promise<void>) {
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  async function leave() {
    setPending(true);
    const signedOut = await signOut();
    setFailed(!signedOut);
    setPending(false);
    if (signedOut) await onSignedOut();
  }

  return { failed, pending, leave: () => void leave() };
}
