import { mutationOptions, queryOptions } from "@tanstack/react-query";

import { ApiTokenList, CreatedApiToken } from "@rondyr/organizations/api-token";

import { keepReadTime } from "./cache.ts";
import { organizationPath, request, requestJson } from "./request.ts";

export type { ApiTokenList };
export type CreatedApiToken = typeof CreatedApiToken.Type;

const path = (organizationId: string) => organizationPath(organizationId, "api-tokens");

/** The active API tokens of an organization, without their secrets. */
export function apiTokensQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "api-tokens"] as const,
    queryFn: ({ signal }) => requestJson(path(organizationId), ApiTokenList, { signal }),
  });
}

/** Creates a token, whose secret only the answer holds, then adds it to the cached list. */
export function createApiTokenMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (name: string) =>
      requestJson(path(organizationId), CreatedApiToken, { method: "POST", json: { name } }),
    onSuccess: ({ token: _secret, ...summary }, _name, _context, { client }) =>
      client.setQueryData(
        apiTokensQuery(organizationId).queryKey,
        (tokens) => (tokens === undefined ? undefined : [summary, ...tokens]),
        keepReadTime(client, apiTokensQuery(organizationId).queryKey),
      ),
  });
}

/** Revokes a token, then takes it out of the cached list. */
export function revokeApiTokenMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (tokenId: ApiTokenList[number]["id"]) =>
      request(`${path(organizationId)}?${new URLSearchParams({ id: tokenId })}`, {
        method: "DELETE",
      }),
    onSuccess: (_response, tokenId, _context, { client }) =>
      client.setQueryData(
        apiTokensQuery(organizationId).queryKey,
        (tokens) => tokens?.filter(({ id }) => id !== tokenId),
        keepReadTime(client, apiTokensQuery(organizationId).queryKey),
      ),
  });
}
