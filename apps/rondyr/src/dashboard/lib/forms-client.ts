import { Option, Schema } from "effect";

import {
  CreateForm,
  FormRequestError,
  ManagedForm,
  SetHoneypotField,
  UpdateForm,
} from "@rondyr/forms/form";
import { TurnstileKeyCheck } from "@rondyr/forms/turnstile";

import type { Inbox } from "./inbox-client.ts";

export type Form = typeof ManagedForm.Type;
export type FormProblem = typeof FormRequestError.Type;

/** A refused request, with the reason the API gives, if any. */
export class FormRequestFailed extends Schema.TaggedError<
  FormRequestFailed,
  { readonly brand: unique symbol }
>()("FormRequestFailed", {
  status: Schema.Int,
  problem: Schema.Option(FormRequestError),
}) {}

const decodeForm = Schema.decodeUnknownPromise(ManagedForm);
const decodeProblem = Schema.decodeUnknownOption(FormRequestError);
const decodeKeyCheck = Schema.decodeUnknownPromise(TurnstileKeyCheck);
const parseCreate = Schema.decodeUnknownSync(CreateForm);
const parseUpdate = Schema.decodeUnknownSync(UpdateForm);
const parseHoneypot = Schema.decodeUnknownSync(SetHoneypotField);

async function send(path: string, init: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw FormRequestFailed.make({ status: response.status, problem: decodeProblem(body) });
  }
  return decodeForm(await response.json());
}

const json = { "content-type": "application/json" };
const forms = (id: Inbox["id"]) => `/api/organizations/${encodeURIComponent(id)}/forms`;
const form = (id: Inbox["id"], publicId: Form["publicId"]) =>
  `${forms(id)}/${encodeURIComponent(publicId)}`;

/** What a new form starts with. An empty business context is stored as none. */
export interface NewForm {
  readonly name: string;
  readonly emoji: string | null;
  readonly businessContext: string;
}

export async function createForm(id: Inbox["id"], { name, emoji, businessContext }: NewForm) {
  const body = parseCreate(
    emoji === null ? { name, businessContext } : { name, emoji, businessContext },
  );
  return send(forms(id), { method: "POST", headers: json, body: JSON.stringify(body) });
}

/** The name, the emoji or the business context of a form, or several of them. */
export type FormChanges = typeof UpdateForm.Encoded;

export async function updateForm(
  id: Inbox["id"],
  publicId: Form["publicId"],
  changes: FormChanges,
) {
  const body = parseUpdate(changes);
  return send(form(id, publicId), { method: "PATCH", headers: json, body: JSON.stringify(body) });
}

export async function setFormStatus(
  id: Inbox["id"],
  publicId: Form["publicId"],
  action: "suspend" | "reactivate",
) {
  return send(`${form(id, publicId)}/${action}`, { method: "POST" });
}

export async function setSuccessUrl(id: Inbox["id"], publicId: Form["publicId"], url: string) {
  return send(`${form(id, publicId)}/success-url`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ url }),
  });
}

export async function clearSuccessUrl(id: Inbox["id"], publicId: Form["publicId"]) {
  return send(`${form(id, publicId)}/success-url`, { method: "DELETE" });
}

export async function setHoneypotField(id: Inbox["id"], publicId: Form["publicId"], field: string) {
  const body = parseHoneypot({ field });
  return send(`${form(id, publicId)}/honeypot`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify(body),
  });
}

export async function clearHoneypotField(id: Inbox["id"], publicId: Form["publicId"]) {
  return send(`${form(id, publicId)}/honeypot`, { method: "DELETE" });
}

/** Have the Worker check the form's stored Turnstile secret key with Cloudflare now. */
export async function checkTurnstileKey(
  id: Inbox["id"],
  publicId: Form["publicId"],
  signal: AbortSignal,
) {
  const response = await fetch(`${form(id, publicId)}/turnstile`, { signal });
  if (!response.ok) {
    throw FormRequestFailed.make({ status: response.status, problem: Option.none() });
  }
  const { state } = await decodeKeyCheck(await response.json());
  return state;
}

export async function setTurnstile(
  id: Inbox["id"],
  publicId: Form["publicId"],
  settings: { readonly siteKey: string; readonly secretKey: string } | null,
) {
  return send(
    `${form(id, publicId)}/turnstile`,
    settings === null
      ? { method: "DELETE" }
      : { method: "PUT", headers: json, body: JSON.stringify(settings) },
  );
}
