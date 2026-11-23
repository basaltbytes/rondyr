import { mutationOptions, queryOptions } from "@tanstack/react-query";

import { DailyUsage, type DailyQuotas } from "@rondyr/organizations/organization-quotas";

import { organizationPath, requestJson } from "./request.ts";

export type DailyUsage = typeof DailyUsage.Type;

const path = (organizationId: string) => organizationPath(organizationId, "quotas");

/** Today's usage of the organization and its daily limits. */
export function quotasQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "quotas"] as const,
    queryFn: ({ signal }) => requestJson(path(organizationId), DailyUsage, { signal }),
  });
}

/** Saves the daily limits. The API answers with today's usage under them. */
export function saveQuotasMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (limits: DailyQuotas) =>
      requestJson(path(organizationId), DailyUsage, { method: "PUT", json: limits }),
    onSuccess: (usage, _limits, _context, { client }) =>
      client.setQueryData(quotasQuery(organizationId).queryKey, usage),
  });
}
