import { mutationOptions, queryOptions } from "@tanstack/react-query";

import {
  DomainRequestError,
  OrganizationDomainInput,
  OrganizationDomainList,
} from "@rondyr/organizations/organization-domain";

import { organizationPath, refusalOf, request, requestJson } from "./request.ts";

export type { OrganizationDomainList };
export type DomainRequestError = typeof DomainRequestError.Type;

const path = (organizationId: string) => organizationPath(organizationId, "domains");

/** The reason that the domains API gave for a refusal, if any. */
export function domainRefusalOf(cause: unknown) {
  return refusalOf(cause, DomainRequestError);
}

/** The domains of an organization, whose senders the filter knows. */
export function domainsQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "domains"] as const,
    queryFn: ({ signal }) => requestJson(path(organizationId), OrganizationDomainList, { signal }),
  });
}

/** Adds a domain, then to the cached list, in order. */
export function addDomainMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (hostname: string) =>
      requestJson(path(organizationId), OrganizationDomainInput, {
        method: "POST",
        json: { domain: hostname },
        refusal: DomainRequestError,
      }),
    onSuccess: ({ domain }, _hostname, _context, { client }) =>
      client.setQueryData(domainsQuery(organizationId).queryKey, (domains) =>
        domains === undefined || domains.includes(domain)
          ? domains
          : [...domains, domain].toSorted(),
      ),
  });
}

/** Removes a domain, then takes it out of the cached list. */
export function removeDomainMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (domain: string) =>
      request(`${path(organizationId)}?${new URLSearchParams({ domain })}`, {
        method: "DELETE",
        refusal: DomainRequestError,
      }),
    onSuccess: (_response, domain, _context, { client }) =>
      client.setQueryData(domainsQuery(organizationId).queryKey, (domains) =>
        domains?.filter((item) => item !== domain),
      ),
  });
}
