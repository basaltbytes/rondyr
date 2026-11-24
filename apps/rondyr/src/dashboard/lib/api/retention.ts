import { mutationOptions, queryOptions } from "@tanstack/react-query";

import { RetentionPeriods } from "@rondyr/organizations/retention";

import { organizationPath, requestJson } from "./request.ts";

export type { RetentionPeriods };

const path = (organizationId: string) => organizationPath(organizationId, "retention");

/** How long the organization keeps its messages, which a purge deletes once an hour. */
export function retentionQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "retention"] as const,
    queryFn: ({ signal }) => requestJson(path(organizationId), RetentionPeriods, { signal }),
  });
}

/** Saves the periods. The API answers with the periods it stored. */
export function saveRetentionMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (periods: RetentionPeriods) =>
      requestJson(path(organizationId), RetentionPeriods, { method: "PUT", json: periods }),
    onSuccess: (periods, _sent, _context, { client }) =>
      client.setQueryData(retentionQuery(organizationId).queryKey, periods),
  });
}
