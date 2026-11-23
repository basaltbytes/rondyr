import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";

import {
  CreateForm,
  FormRequestError,
  ManagedForm,
  SetHoneypotField,
  UpdateForm,
} from "@rondyr/forms/form";
import { TurnstileKeyCheck } from "@rondyr/forms/turnstile";

import { organizationsQuery } from "./organizations.ts";
import { organizationPath, refusalOf, requestJson } from "./request.ts";

export type ManagedForm = typeof ManagedForm.Type;
export type FormRequestError = typeof FormRequestError.Type;
/** The name, the emoji or the business context of a form, or several of them. */
export type FormChanges = typeof UpdateForm.Encoded;

/** The reason that the forms API gave for a refusal, if any. */
export function formRefusalOf(cause: unknown) {
  return refusalOf(cause, FormRequestError);
}

const parseCreate = Schema.decodeUnknownSync(CreateForm);
const parseUpdate = Schema.decodeUnknownSync(UpdateForm);
const parseHoneypot = Schema.decodeUnknownSync(SetHoneypotField);

const forms = (organizationId: string) => organizationPath(organizationId, "forms");
const form = (organizationId: string, publicId: string, ...segments: ReadonlyArray<string>) =>
  organizationPath(organizationId, "forms", publicId, ...segments);

/** The body of a change of a form, as the schemas of the API take it. */
type FormBody =
  | typeof CreateForm.Type
  | typeof UpdateForm.Type
  | typeof SetHoneypotField.Type
  | { readonly url: string }
  | { readonly siteKey: string; readonly secretKey: string };

/** Sends a change of a form, and decodes the form that the API answers with. */
function send(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", json?: FormBody) {
  return requestJson(
    path,
    ManagedForm,
    json === undefined
      ? { method, refusal: FormRequestError }
      : { method, json, refusal: FormRequestError },
  );
}

/** What a new form starts with. An empty business context is stored as none. */
export interface NewForm {
  readonly name: string;
  readonly emoji: string | null;
  readonly businessContext: string;
}

/** A change of one setting of a form: each reads the organizations and their forms again. */
export type FormChange =
  | { readonly change: "details"; readonly details: FormChanges }
  | { readonly change: "status"; readonly action: "suspend" | "reactivate" }
  | { readonly change: "successUrl"; readonly url: string | null }
  | { readonly change: "honeypot"; readonly field: string | null }
  | {
      readonly change: "turnstile";
      readonly keys: { readonly siteKey: string; readonly secretKey: string } | null;
    };

/** Sends a change of a form to the API. */
export function changeForm(organizationId: string, publicId: string, change: FormChange) {
  switch (change.change) {
    case "details":
      return send(form(organizationId, publicId), "PATCH", parseUpdate(change.details));
    case "status":
      return send(form(organizationId, publicId, change.action), "POST");
    case "successUrl":
      return change.url === null
        ? send(form(organizationId, publicId, "success-url"), "DELETE")
        : send(form(organizationId, publicId, "success-url"), "PUT", { url: change.url });
    case "honeypot":
      return change.field === null
        ? send(form(organizationId, publicId, "honeypot"), "DELETE")
        : send(
            form(organizationId, publicId, "honeypot"),
            "PUT",
            parseHoneypot({ field: change.field }),
          );
    case "turnstile":
      return change.keys === null
        ? send(form(organizationId, publicId, "turnstile"), "DELETE")
        : send(form(organizationId, publicId, "turnstile"), "PUT", change.keys);
  }
}

/** Whether Cloudflare accepts the stored Turnstile secret key of a form, checked on each display. */
export function turnstileKeyQuery(organizationId: string, publicId: string) {
  return queryOptions({
    queryKey: [organizationId, "forms", publicId, "turnstile"] as const,
    queryFn: async ({ signal }) => {
      const { state } = await requestJson(
        form(organizationId, publicId, "turnstile"),
        TurnstileKeyCheck,
        {
          signal,
        },
      );
      return state;
    },
    gcTime: 0,
  });
}

/** The organizations hold the forms, so a change of a form reads them again. */
function readFormsAgain(client: QueryClient) {
  return client.invalidateQueries({ queryKey: organizationsQuery.queryKey });
}

/** Changes a setting of a form, then reads the organizations and their forms again. */
export function changeFormMutation(organizationId: string, publicId: string) {
  return mutationOptions({
    mutationFn: (change: FormChange) => changeForm(organizationId, publicId, change),
    onSuccess: async (_form, change, _context, { client }) => {
      if (change.change === "turnstile") {
        await client.invalidateQueries({
          queryKey: turnstileKeyQuery(organizationId, publicId).queryKey,
        });
      }
      await readFormsAgain(client);
    },
  });
}

/** Adds a form, then reads the organizations and their forms again. */
export function createFormMutation(organizationId: string) {
  return mutationOptions({
    mutationFn: ({ name, emoji, businessContext }: NewForm) =>
      send(
        forms(organizationId),
        "POST",
        parseCreate(emoji === null ? { name, businessContext } : { name, emoji, businessContext }),
      ),
    onSuccess: (_form, _new, _context, { client }) => readFormsAgain(client),
  });
}
