import {
  AuthSession,
  PasskeyCreationOptions,
  PasskeyError,
} from "@rondyr/organizations/authentication";

import { createBrowserPasskey } from "~/lib/webauthn";

import { requestJson } from "./request.ts";

interface Owner {
  readonly name: string;
  readonly email: string;
}

/**
 * Create the owner account and its first passkey atomically with the setup token,
 * starting a session immediately upon verification.
 */
export async function createOwnerWithPasskey(token: string, owner: Owner) {
  const headers = { authorization: `Bearer ${token}` };
  const options = await requestJson("/api/setup/options", PasskeyCreationOptions, {
    method: "POST",
    headers,
    json: { name: owner.name, email: owner.email },
  });
  const credential = await createBrowserPasskey(options);
  return requestJson("/api/setup/verify", AuthSession, {
    method: "POST",
    headers,
    json: { credential },
    refusal: PasskeyError,
  });
}
