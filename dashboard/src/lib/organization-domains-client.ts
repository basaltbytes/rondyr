import { Schema } from "effect";

import {
  DomainRequestError,
  OrganizationDomainInput,
  OrganizationDomainList,
} from "@rondyr/organizations/organization-domain";

import type { Inbox } from "./inbox-client.ts";

export class DomainRequestFailed extends Schema.TaggedError<
  DomainRequestFailed,
  { readonly brand: unique symbol }
>()("DomainRequestFailed", { problem: Schema.Option(DomainRequestError) }) {}

const decodeList = Schema.decodeUnknownPromise(OrganizationDomainList);
const decodeDomain = Schema.decodeUnknownPromise(OrganizationDomainInput);
const decodeProblem = Schema.decodeUnknownOption(DomainRequestError);

const domainsPath = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}/domains`;

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (response.ok) return response;
  const problem = decodeProblem(await response.json().catch(() => null));
  throw DomainRequestFailed.make({ problem });
}

export async function listDomains(id: Inbox["id"]) {
  const response = await send(domainsPath(id));
  return decodeList(await response.json());
}

export async function addDomain(id: Inbox["id"], domain: string) {
  const response = await send(domainsPath(id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
  return decodeDomain(await response.json());
}

export async function removeDomain(id: Inbox["id"], domain: string) {
  const query = new URLSearchParams({ domain });
  await send(`${domainsPath(id)}?${query}`, { method: "DELETE" });
}
