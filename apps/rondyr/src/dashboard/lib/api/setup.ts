import { queryOptions } from "@tanstack/react-query";

import { SetupStatus } from "@rondyr/organizations/setup";

import { request, requestJson } from "./request.ts";

/** Whether the first account of this instance can be created. */
export const setupQuery = queryOptions({
  queryKey: ["setup"],
  queryFn: async ({ signal }) => {
    const { state } = await requestJson("/api/setup", SetupStatus, { signal, cache: "no-store" });
    return state;
  },
});

interface Owner {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Create the owner account with the setup token that whoever deployed the instance
 * chose. The token travels in a header, like the setup script sends it.
 */
export async function createOwner(token: string, owner: Owner) {
  await request("/api/setup", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    json: { ...owner },
  });
}
