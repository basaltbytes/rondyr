import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { sessionQuery } from "~/lib/api/session";

/**
 * What follows a sign-out: the cache of the account empties, and the sign-in page opens.
 * The session is known to be gone, so no read of the dashboard sends the visitor to the
 * sign-in page a second time.
 */
export function useSignedOut() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    queryClient.clear();
    queryClient.setQueryData(sessionQuery.queryKey, null);
    await router.navigate({ to: "/sign-in" });
  };
}

/**
 * What follows a sign-in: the cache of the previous visitor or account empties, and
 * `address`, a path of this origin, opens in place of the sign-in page.
 */
export function useSignedIn(address: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    queryClient.clear();
    await router.navigate({ href: address, replace: true });
  };
}
