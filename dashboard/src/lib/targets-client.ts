import { Schema } from "effect";

import { EmailLanguage, EmailTarget } from "@rondyr/deliveries/email";
import { TargetTestResult } from "@rondyr/deliveries/history";
import { DestinationTarget, TargetRequestError } from "@rondyr/deliveries/targets";
import { IssuedWebhookSecret, WebhookTarget } from "@rondyr/deliveries/webhook";

import type { Inbox } from "./inbox-client.ts";

export type Target = typeof DestinationTarget.Type;
export type Webhook = typeof WebhookTarget.Type;
export type EmailDestination = typeof EmailTarget.Type;
/** A language in which Rondyr writes the emails of a destination. */
export type DestinationLanguage = EmailLanguage;
export type IssuedSecret = typeof IssuedWebhookSecret.Type;
export type TargetProblem = typeof TargetRequestError.Type;
export type TestResult = typeof TargetTestResult.Type;
type Form = Inbox["forms"][number];

export const isWebhook = Schema.is(WebhookTarget);

export const isEmailDestination = Schema.is(EmailTarget);

export const destinationLanguages = EmailLanguage.literals;

export const isDestinationLanguage = Schema.is(EmailLanguage);

/** A refused request, with the error that the API explains in its body, if any. */
export class TargetRequestFailed extends Schema.TaggedError<
  TargetRequestFailed,
  { readonly brand: unique symbol }
>()("TargetRequestFailed", {
  status: Schema.Int,
  problem: Schema.Option(TargetRequestError),
}) {}

const decodeTargets = Schema.decodeUnknownPromise(Schema.Array(DestinationTarget));
const decodeTarget = Schema.decodeUnknownPromise(DestinationTarget);
const decodeEmailTarget = Schema.decodeUnknownPromise(EmailTarget);
const decodeIssued = Schema.decodeUnknownPromise(IssuedWebhookSecret);
const decodeProblem = Schema.decodeUnknownOption(TargetRequestError);
const decodeTestResult = Schema.decodeUnknownPromise(TargetTestResult);

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
const json = { "content-type": "application/json" };

/** The webhook and email targets of a form. */
export async function listTargets(id: Inbox["id"], form: Form["publicId"], signal: AbortSignal) {
  const response = await send(formTargets(id, form), { signal });
  return decodeTargets(await response.json());
}

export async function createWebhook(id: Inbox["id"], form: Form["publicId"], url: string) {
  const response = await send(formTargets(id, form), {
    method: "POST",
    headers: json,
    body: JSON.stringify({ type: "webhook", url }),
  });
  return decodeIssued(await response.json());
}

/** Add an email destination. Without a language, the API gives it the default one. */
export async function createEmailTarget(
  id: Inbox["id"],
  form: Form["publicId"],
  recipients: ReadonlyArray<string>,
  language: DestinationLanguage | undefined,
) {
  const response = await send(formTargets(id, form), {
    method: "POST",
    headers: json,
    body: JSON.stringify({ type: "email", recipients, language }),
  });
  return decodeEmailTarget(await response.json());
}

/** Replace the recipients of an email destination. Without a language, it keeps its own. */
export async function replaceRecipients(
  id: Inbox["id"],
  targetId: Target["id"],
  recipients: ReadonlyArray<string>,
  language: DestinationLanguage | undefined,
) {
  const response = await send(`${target(id, targetId)}/recipients`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ recipients, language }),
  });
  return decodeEmailTarget(await response.json());
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

/** Send a test message to a target and wait for the answer of its recipient. */
export async function testTarget(id: Inbox["id"], targetId: Target["id"]) {
  const response = await send(`${target(id, targetId)}/test`, { method: "POST" });
  return decodeTestResult(await response.json());
}
