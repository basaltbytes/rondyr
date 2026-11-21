import { Schema } from "effect";

import {
  type OrganizationClassificationPolicy,
  OrganizationClassificationSettings,
} from "@rondyr/organizations/organization-classification-policy";

import type { Inbox } from "./inbox-client.ts";

const decodeSettings = Schema.decodeUnknownPromise(OrganizationClassificationSettings);
const path = (id: Inbox["id"]) =>
  `/api/organizations/${encodeURIComponent(id)}/classification-policy`;

export async function getClassificationSettings(id: Inbox["id"]) {
  const response = await fetch(path(id));
  if (!response.ok) throw new Error(`Classification policy request failed (${response.status}).`);
  return decodeSettings(await response.json());
}

export async function saveClassificationOverride(
  id: Inbox["id"],
  override: OrganizationClassificationPolicy | null,
) {
  const response = await fetch(
    path(id),
    override === null
      ? { method: "DELETE" }
      : {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(override),
        },
  );
  if (!response.ok) throw new Error(`Classification policy request failed (${response.status}).`);
}
