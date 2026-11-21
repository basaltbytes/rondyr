import { Schema } from "effect";

import { RetentionPeriods } from "@rondyr/organizations/retention";

import type { Inbox } from "./inbox-client.ts";

const decodePeriods = Schema.decodeUnknownPromise(RetentionPeriods);
const path = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}/retention`;

export type Retention = RetentionPeriods;

export class RetentionRequestFailed extends Schema.TaggedError<
  RetentionRequestFailed,
  { readonly brand: unique symbol }
>()("RetentionRequestFailed", { status: Schema.Int }) {}

async function send(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw RetentionRequestFailed.make({ status: response.status });
  return response;
}

export async function getRetention(id: Inbox["id"]) {
  const response = await send(path(id));
  return decodePeriods(await response.json());
}

export async function saveRetention(id: Inbox["id"], periods: Retention) {
  const response = await send(path(id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(periods),
  });
  return decodePeriods(await response.json());
}
