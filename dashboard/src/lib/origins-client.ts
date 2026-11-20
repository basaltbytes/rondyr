import { Schema } from "effect";

import { FormOrigin, OriginRequestError } from "@rondyr/forms/allowed-origin";

import type { Inbox } from "./inbox-client.ts";

export type AllowedOrigin = typeof FormOrigin.Type;
export type OriginProblem = typeof OriginRequestError.Type;
type Form = Inbox["forms"][number];

/** A refused request, with the reason the API gives for a refused origin, if any. */
export class OriginRequestFailed extends Schema.TaggedError<
  OriginRequestFailed,
  { readonly brand: unique symbol }
>()("OriginRequestFailed", {
  status: Schema.Int,
  problem: Schema.Option(OriginRequestError),
}) {}

const decodeOrigins = Schema.decodeUnknownPromise(Schema.Array(FormOrigin));
const decodeOrigin = Schema.decodeUnknownPromise(FormOrigin);
const decodeProblem = Schema.decodeUnknownOption(OriginRequestError);

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  throw OriginRequestFailed.make({ status: response.status, problem: decodeProblem(body) });
}

const formOrigins = (id: Inbox["id"], form: Form["publicId"]) =>
  `/api/organizations/${encodeURIComponent(id)}/forms/${encodeURIComponent(form)}/origins`;

export async function listOrigins(id: Inbox["id"], form: Form["publicId"], signal: AbortSignal) {
  const response = await send(formOrigins(id, form), { signal });
  return decodeOrigins(await response.json());
}

export async function addOrigin(id: Inbox["id"], form: Form["publicId"], origin: string) {
  const response = await send(formOrigins(id, form), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin }),
  });
  return decodeOrigin(await response.json());
}

export async function removeOrigin(id: Inbox["id"], form: Form["publicId"], origin: string) {
  await send(`${formOrigins(id, form)}?${new URLSearchParams({ origin })}`, { method: "DELETE" });
}
