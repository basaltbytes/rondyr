import { mutationOptions, queryOptions } from "@tanstack/react-query";

import {
  OrganizationClassificationSettings,
  type OrganizationClassificationPolicy,
} from "@rondyr/organizations/organization-classification-policy";

import { keepReadTime } from "./cache.ts";
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

/** Saves the override of the organization, or removes it with null, then its cached copy. */
export function saveClassificationMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (override: OrganizationClassificationPolicy | null) =>
      request(
        path(organizationId),
        override === null ? { method: "DELETE" } : { method: "PUT", json: override },
      ),
    onSuccess: (_response, override, _context, { client }) =>
      client.setQueryData(
        classificationQuery(organizationId).queryKey,
        (settings) => (settings === undefined ? undefined : { ...settings, override }),
        keepReadTime(client, classificationQuery(organizationId).queryKey),
      ),
  });
}
