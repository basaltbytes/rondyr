import { Schema } from "effect";

import { ApiTokenList, CreatedApiToken } from "@rondyr/organizations/api-token";

import type { Inbox } from "./inbox-client.ts";

const decodeList = Schema.decodeUnknownPromise(ApiTokenList);
const decodeCreated = Schema.decodeUnknownPromise(CreatedApiToken);
const path = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}/api-tokens`;

export class ApiTokenRequestFailed extends Schema.TaggedError<
  ApiTokenRequestFailed,
  { readonly brand: unique symbol }
>()("ApiTokenRequestFailed", { status: Schema.Int }) {}

async function send(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw ApiTokenRequestFailed.make({ status: response.status });
  return response;
}

export async function listApiTokens(id: Inbox["id"]) {
  const response = await send(path(id));
  return decodeList(await response.json());
}

export async function createApiToken(id: Inbox["id"], name: string) {
  const response = await send(path(id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return decodeCreated(await response.json()).catch(() => {
    throw ApiTokenRequestFailed.make({ status: response.status });
  });
}

export async function revokeApiToken(id: Inbox["id"], tokenId: ApiTokenList[number]["id"]) {
  const query = new URLSearchParams({ id: tokenId });
  await send(`${path(id)}?${query}`, { method: "DELETE" });
}
