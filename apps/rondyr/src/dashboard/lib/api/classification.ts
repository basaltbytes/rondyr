import { mutationOptions, queryOptions } from "@tanstack/react-query";

import {
  OrganizationClassificationSettings,
  type OrganizationClassificationPolicy,
} from "@rondyr/organizations/organization-classification-policy";

import { organizationPath, request, requestJson } from "./request.ts";

export type OrganizationClassificationSettings = typeof OrganizationClassificationSettings.Type;

const path = (organizationId: string) => organizationPath(organizationId, "classification-policy");

/** The classifier of the instance, its defaults, and the override of the organization. */
export function classificationQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "classification"] as const,
    queryFn: ({ signal }) =>
      requestJson(path(organizationId), OrganizationClassificationSettings, { signal }),
  });
}

/**
 * Saves the override of the organization, or removes it with null. The form on screen
 * already shows what it saved, so the settings are read again when the page next opens.
 */
export function saveClassificationMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (override: OrganizationClassificationPolicy | null) =>
      request(
        path(organizationId),
        override === null ? { method: "DELETE" } : { method: "PUT", json: override },
      ),
    onSuccess: (_response, _override, _context, { client }) =>
      client.invalidateQueries({
        queryKey: classificationQuery(organizationId).queryKey,
        refetchType: "none",
      }),
  });
}
