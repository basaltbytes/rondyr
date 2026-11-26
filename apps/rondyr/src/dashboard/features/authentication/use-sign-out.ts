import { useState } from "react";

import { signOutRequest } from "~/lib/api/session";

/** Ends the session. Returns whether it worked. */
async function signOut() {
  try {
    await signOutRequest();
    return true;
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
