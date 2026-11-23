import { queryOptions } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/client";
import { Option } from "effect";

import { RequestFailed } from "./request.ts";

/** The client of Better Auth, which signs in, signs out and reads the session. */
export const authClient = createAuthClient();

/**
 * The signed-in account, or null for a visitor. The dashboard reads it once, and again
 * after a sign-in, a sign-out or an answer that says the session ended.
 */
export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async () => {
    const { data, error } = await authClient.getSession();
    if (error !== null) {
      throw RequestFailed.make({ status: error.status, refusal: Option.none() });
    }
    return data;
  },
  staleTime: Number.POSITIVE_INFINITY,
});
