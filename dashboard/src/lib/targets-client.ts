import { Schema } from "effect";

import { IssuedWebhookSecret, TargetRequestError, WebhookTarget } from "@rondyr/deliveries/webhook";

import type { Inbox } from "./inbox-client.ts";

export type Target = typeof WebhookTarget.Type;
export type IssuedSecret = typeof IssuedWebhookSecret.Type;
export type TargetProblem = typeof TargetRequestError.Type;
type Form = Inbox["forms"][number];

/** A refused request, with the error that the API explains in its body, if any. */
export class TargetRequestFailed extends Schema.TaggedError<
  TargetRequestFailed,
  { readonly brand: unique symbol }
>()("TargetRequestFailed", {
  status: Schema.Int,
  problem: Schema.Option(TargetRequestError),
}) {}

const decodeTargets = Schema.decodeUnknownPromise(Schema.Array(WebhookTarget));
const decodeTarget = Schema.decodeUnknownPromise(WebhookTarget);
const decodeIssued = Schema.decodeUnknownPromise(IssuedWebhookSecret);
const decodeProblem = Schema.decodeUnknownOption(TargetRequestError);

async function send(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  throw TargetRequestFailed.make({ status: response.status, problem: decodeProblem(body) });
}

const organization = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}`;
const formTargets = (id: Inbox["id"], form: Form["publicId"]) =>
  `${organization(id)}/forms/${encodeURIComponent(form)}/targets`;
const target = (id: Inbox["id"], targetId: Target["id"]) =>
  `${organization(id)}/targets/${encodeURIComponent(targetId)}`;

export async function listTargets(id: Inbox["id"], form: Form["publicId"], signal: AbortSignal) {
  const response = await send(formTargets(id, form), { signal });
  return decodeTargets(await response.json());
}

export async function createWebhook(id: Inbox["id"], form: Form["publicId"], url: string) {
  const response = await send(formTargets(id, form), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "webhook", url }),
  });
  return decodeIssued(await response.json());
}

export async function rotateSecret(id: Inbox["id"], targetId: Target["id"]) {
  const response = await send(`${target(id, targetId)}/rotate-secret`, { method: "POST" });
  return decodeIssued(await response.json());
}

export async function setTargetActive(
  id: Inbox["id"],
  targetId: Target["id"],
  action: "activate" | "deactivate",
) {
  const response = await send(`${target(id, targetId)}/${action}`, { method: "POST" });
  return decodeTarget(await response.json());
}
