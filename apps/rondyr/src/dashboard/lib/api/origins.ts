import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";

import { FormOrigin, OriginRequestError } from "@rondyr/forms/allowed-origin";

import { keepReadTime } from "./cache.ts";
import { organizationPath, refusalOf, request, requestJson } from "./request.ts";

export type FormOrigin = typeof FormOrigin.Type;
export type OriginRequestError = typeof OriginRequestError.Type;

const Origins = Schema.Array(FormOrigin);

/** The reason that the origins API gave for a refused origin, if any. */
export function originRefusalOf(cause: unknown) {
  return refusalOf(cause, OriginRequestError);
}

const originsPath = (organizationId: string, publicId: string) =>
  organizationPath(organizationId, "forms", publicId, "origins");

/** The origins from which the browser may send a form. */
export function originsQuery(organizationId: string, publicId: string) {
  return queryOptions({
    queryKey: [organizationId, "forms", publicId, "origins"] as const,
    queryFn: ({ signal }) =>
      requestJson(originsPath(organizationId, publicId), Origins, { signal }),
  });
}

/** Adds an origin to a form, then to its cached origins. */
export function addOriginMutation(organizationId: string, publicId: string) {
  return mutationOptions({
    mutationFn: (origin: string) =>
      requestJson(originsPath(organizationId, publicId), FormOrigin, {
        method: "POST",
        json: { origin },
        refusal: OriginRequestError,
      }),
    onSuccess: (added, _origin, _context, { client }) =>
      client.setQueryData(
        originsQuery(organizationId, publicId).queryKey,
        (origins) =>
          origins === undefined || origins.some((item) => item.origin === added.origin)
            ? origins
            : [...origins, added],
        keepReadTime(client, originsQuery(organizationId, publicId).queryKey),
      ),
  });
}

/** Removes an origin from a form, then from its cached origins. */
export function removeOriginMutation(organizationId: string, publicId: string) {
  return mutationOptions({
    mutationFn: (origin: string) =>
      request(`${originsPath(organizationId, publicId)}?${new URLSearchParams({ origin })}`, {
        method: "DELETE",
        refusal: OriginRequestError,
      }),
    onSuccess: (_response, origin, _context, { client }) =>
      client.setQueryData(
        originsQuery(organizationId, publicId).queryKey,
        (origins) => origins?.filter((item) => item.origin !== origin),
        keepReadTime(client, originsQuery(organizationId, publicId).queryKey),
      ),
  });
}
