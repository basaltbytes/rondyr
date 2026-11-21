import { Schema } from "effect";

import { DailyUsage, type DailyQuotas } from "@rondyr/organizations/organization-quotas";

import type { Inbox } from "./inbox-client.ts";

const decodeUsage = Schema.decodeUnknownPromise(DailyUsage);
const path = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}/quotas`;

async function request(id: Inbox["id"], init?: RequestInit) {
  const response = await fetch(path(id), init);
  if (!response.ok) throw new Error(`Daily quotas request failed (${response.status}).`);
  return decodeUsage(await response.json());
}

export function getDailyUsage(id: Inbox["id"]) {
  return request(id);
}

export function saveDailyQuotas(id: Inbox["id"], limits: DailyQuotas) {
  return request(id, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(limits),
  });
}
