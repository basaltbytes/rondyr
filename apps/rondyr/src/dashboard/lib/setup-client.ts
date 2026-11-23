import { Schema } from "effect";

import { SetupStatus } from "@rondyr/organizations/setup";

const decodeStatus = Schema.decodeUnknownPromise(SetupStatus);

/** A setup request that the API refused, with its HTTP status. */
export class SetupRequestFailed extends Schema.TaggedError<
  SetupRequestFailed,
  { readonly brand: unique symbol }
>()("SetupRequestFailed", { status: Schema.Int }) {}

/** Whether the first account of this instance can be created. */
export async function readSetupState() {
  const response = await fetch("/api/setup", { cache: "no-store" });
  if (!response.ok) throw SetupRequestFailed.make({ status: response.status });
  return (await decodeStatus(await response.json())).state;
}

interface Owner {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Create the owner account with the setup token that whoever deployed the instance
 * chose. The token travels in a header, like the setup script sends it.
 */
export async function createOwner(token: string, owner: Owner) {
  const response = await fetch("/api/setup", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(owner),
  });
  if (!response.ok) throw SetupRequestFailed.make({ status: response.status });
}
