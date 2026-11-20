import { Schema } from "effect";

import { CreateForm, FormRequestError, ManagedForm, UpdateForm } from "@rondyr/forms/form";

import type { Inbox } from "./inbox-client.ts";

export type Form = typeof ManagedForm.Type;
export type FormProblem = typeof FormRequestError.Type;

/** A refused request, with the reason the API gives for a refused success URL, if any. */
export class FormRequestFailed extends Schema.TaggedError<
  FormRequestFailed,
  { readonly brand: unique symbol }
>()("FormRequestFailed", {
  status: Schema.Int,
  problem: Schema.Option(FormRequestError),
}) {}

const decodeForm = Schema.decodeUnknownPromise(ManagedForm);
const decodeProblem = Schema.decodeUnknownOption(FormRequestError);
const parseCreate = Schema.decodeUnknownSync(CreateForm);
const parseUpdate = Schema.decodeUnknownSync(UpdateForm);

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

export async function createForm(id: Inbox["id"], name: string, businessContext: string) {
  const body = parseCreate({ name, businessContext });
  return send(forms(id), { method: "POST", headers: json, body: JSON.stringify(body) });
}

export async function updateForm(
  id: Inbox["id"],
  publicId: Form["publicId"],
  name: string,
  businessContext: string,
) {
  const body = parseUpdate({ name, businessContext });
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
