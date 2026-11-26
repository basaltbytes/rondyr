import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { Option } from "effect";

import type { PasskeyId } from "@rondyr/organizations/account";
import {
  AccountPasskeys,
  PasskeyCreationOptions,
  PasskeyError,
  PasskeySummary,
} from "@rondyr/organizations/authentication";

import { createBrowserPasskey } from "~/lib/webauthn";

import { refusalOf, request, requestJson } from "./request.ts";

export function passkeyErrorOf(cause: unknown) {
  return Option.getOrNull(Option.map(refusalOf(cause, PasskeyError), ({ error }) => error));
}

export const passkeysQuery = queryOptions({
  queryKey: ["account", "passkeys"] as const,
  queryFn: ({ signal }) =>
    requestJson("/api/account/passkeys", AccountPasskeys, { signal, cache: "no-store" }),
  staleTime: 0,
});

export function addPasskeyMutation() {
  return mutationOptions({
    mutationFn: async (name?: string) => {
      const options = await requestJson("/api/account/passkeys/options", PasskeyCreationOptions, {
        method: "POST",
        json: {},
      });
      const credential = await createBrowserPasskey(options);
      const trimmed = name?.trim();
      return requestJson("/api/account/passkeys/verify", PasskeySummary, {
        method: "POST",
        json: {
          credential,
          ...(trimmed !== undefined && trimmed !== "" && { name: trimmed }),
        },
        refusal: PasskeyError,
      });
    },
    onSuccess: (created, _variables, _context, { client }) => {
      client.setQueryData(passkeysQuery.queryKey, (current) =>
        current === undefined
          ? undefined
          : { ...current, passkeys: [created, ...current.passkeys] },
      );
    },
  });
}

export function renamePasskeyMutation() {
  return mutationOptions({
    mutationFn: ({ id, name }: { readonly id: PasskeyId; readonly name: string }) =>
      requestJson(`/api/account/passkeys/${encodeURIComponent(id)}`, PasskeySummary, {
        method: "PATCH",
        json: { name },
        refusal: PasskeyError,
      }),
    onSuccess: (updated, _variables, _context, { client }) => {
      client.setQueryData(passkeysQuery.queryKey, (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              passkeys: current.passkeys.map((item) => (item.id === updated.id ? updated : item)),
            },
      );
    },
  });
}

export function deletePasskeyMutation() {
  return mutationOptions({
    mutationFn: async (id: PasskeyId) => {
      await request(`/api/account/passkeys/${encodeURIComponent(id)}`, {
        method: "DELETE",
        refusal: PasskeyError,
      });
      return id;
    },
    onSuccess: (deletedId, _variables, _context, { client }) => {
      client.setQueryData(passkeysQuery.queryKey, (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              passkeys: current.passkeys.filter(({ id }) => id !== deletedId),
            },
      );
    },
  });
}
