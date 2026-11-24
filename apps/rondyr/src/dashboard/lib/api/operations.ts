import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import {
  OperationsStatus,
  OrganizationStatus,
  StuckSubmissions,
} from "@rondyr/contracts/operations-status";

import { organizationPath, requestJson, statusOf } from "./request.ts";

export type OperationsStatus = typeof OperationsStatus.Type;
export type OrganizationStatus = typeof OrganizationStatus.Type;
/** The stuck submissions of an organization, oldest first, and how many there are. */
export type StuckSubmissions = typeof StuckSubmissions.Type;

/**
 * How the processing of every organization that the account administers is doing. It
 * covers several organizations, so its key starts with no organization ID.
 */
export const operationsQuery = queryOptions({
  queryKey: ["operations"],
  queryFn: ({ signal }) => requestJson("/api/operations", OperationsStatus, { signal }),
});

const stuckPath = (organizationId: string, ...segments: ReadonlyArray<string>) =>
  organizationPath(organizationId, "stuck-submissions", ...segments);

/** The submissions of an organization that the Cron no longer publishes. */
export function stuckSubmissionsQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "stuck-submissions"] as const,
    queryFn: ({ signal }) => requestJson(stuckPath(organizationId), StuckSubmissions, { signal }),
  });
}

/** Reads the status again, with the stuck submissions of every organization. */
export async function refreshOperations(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: operationsQuery.queryKey }),
    client.invalidateQueries({ predicate: ({ queryKey }) => queryKey[1] === "stuck-submissions" }),
  ]);
}

/**
 * Publishes a stuck submission again, then reads the status again. A submission already
 * retried or handed off since answers 409, and the new status shows it.
 */
export function retryStuckMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: async (submissionId: string) => {
      try {
        return await requestJson(
          stuckPath(organizationId, submissionId, "retry"),
          StuckSubmissions,
          {
            method: "POST",
          },
        );
      } catch (cause) {
        if (statusOf(cause) !== 409) throw cause;
        return null;
      }
    },
    onSuccess: async (stuck, _submission, _context, { client }) => {
      const stuckKey = stuckSubmissionsQuery(organizationId).queryKey;
      if (stuck === null) await client.invalidateQueries({ queryKey: stuckKey });
      else client.setQueryData(stuckKey, stuck);
      await client.invalidateQueries({ queryKey: operationsQuery.queryKey });
    },
  });
}
