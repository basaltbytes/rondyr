import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";

import { BlockedTermRequestError, FormBlockedTerm } from "@rondyr/forms/blocked-term";

import { organizationPath, refusalOf, request, requestJson } from "./request.ts";

export type FormBlockedTerm = typeof FormBlockedTerm.Type;
export type BlockedTermRequestError = typeof BlockedTermRequestError.Type;

const BlockedTerms = Schema.Array(FormBlockedTerm);

/** The reason that the blocked-terms API gave for a refused term, if any. */
export function blockedTermRefusalOf(cause: unknown) {
  return refusalOf(cause, BlockedTermRequestError);
}

const formBlockedTermsPath = (organizationId: string, publicId: string) =>
  organizationPath(organizationId, "forms", publicId, "blocked-terms");

const organizationBlockedTermsPath = (organizationId: string) =>
  organizationPath(organizationId, "blocked-terms");

/** The blocked words, phrases, domains and addresses of a form. */
export function blockedTermsQuery(organizationId: string, publicId: string) {
  return queryOptions({
    queryKey: [organizationId, "forms", publicId, "blocked-terms"] as const,
    queryFn: ({ signal }) =>
      requestJson(formBlockedTermsPath(organizationId, publicId), BlockedTerms, { signal }),
  });
}

/** Adds a blocked term to a form, then to its cached list. */
export function addBlockedTermMutation(organizationId: string, publicId: string) {
  return mutationOptions({
    mutationFn: (term: string) =>
      requestJson(formBlockedTermsPath(organizationId, publicId), FormBlockedTerm, {
        method: "POST",
        json: { term },
        refusal: BlockedTermRequestError,
      }),
    onSuccess: (added, _term, _context, { client }) =>
      client.setQueryData(blockedTermsQuery(organizationId, publicId).queryKey, (terms) =>
        terms === undefined || terms.some((item) => item.term === added.term)
          ? terms
          : [...terms, added],
      ),
  });
}

/** Removes a blocked term from a form, then from its cached list. */
export function removeBlockedTermMutation(organizationId: string, publicId: string) {
  return mutationOptions({
    mutationFn: (term: string) =>
      request(
        `${formBlockedTermsPath(organizationId, publicId)}?${new URLSearchParams({ term })}`,
        {
          method: "DELETE",
          refusal: BlockedTermRequestError,
        },
      ),
    onSuccess: (_response, term, _context, { client }) =>
      client.setQueryData(blockedTermsQuery(organizationId, publicId).queryKey, (terms) =>
        terms?.filter((item) => item.term !== term),
      ),
  });
}

/** The blocked words, phrases, domains and addresses of an organization. */
export function organizationBlockedTermsQuery(organizationId: string) {
  return queryOptions({
    queryKey: [organizationId, "blocked-terms"] as const,
    queryFn: ({ signal }) =>
      requestJson(organizationBlockedTermsPath(organizationId), BlockedTerms, { signal }),
  });
}

/** Adds a blocked term to an organization, then to its cached list. */
export function addOrganizationBlockedTermMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (term: string) =>
      requestJson(organizationBlockedTermsPath(organizationId), FormBlockedTerm, {
        method: "POST",
        json: { term },
        refusal: BlockedTermRequestError,
      }),
    onSuccess: (added, _term, _context, { client }) =>
      client.setQueryData(organizationBlockedTermsQuery(organizationId).queryKey, (terms) =>
        terms === undefined || terms.some((item) => item.term === added.term)
          ? terms
          : [...terms, added],
      ),
  });
}

/** Removes a blocked term from an organization, then from its cached list. */
export function removeOrganizationBlockedTermMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: (term: string) =>
      request(`${organizationBlockedTermsPath(organizationId)}?${new URLSearchParams({ term })}`, {
        method: "DELETE",
        refusal: BlockedTermRequestError,
      }),
    onSuccess: (_response, term, _context, { client }) =>
      client.setQueryData(organizationBlockedTermsQuery(organizationId).queryKey, (terms) =>
        terms?.filter((item) => item.term !== term),
      ),
  });
}
