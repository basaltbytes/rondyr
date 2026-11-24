import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";

import {
  InboxOrganizationWithForms,
  OrganizationCreation,
  SetupInbox,
} from "@rondyr/contracts/inbox-setup";

import { request, requestJson } from "./request.ts";

/** An organization of the account, the role of the account in it, and its forms. */
export type Organization = typeof InboxOrganizationWithForms.Type;

const path = "/api/organizations";
const Organizations = Schema.Array(InboxOrganizationWithForms);
const decodeSetup = Schema.decodeUnknownSync(SetupInbox);

/** The organizations of the signed-in account and their forms. */
export const organizationsQuery = queryOptions({
  queryKey: ["organizations"],
  queryFn: ({ signal }) => requestJson(path, Organizations, { signal }),
});

/**
 * Whether the signed-in account may create an organization: on the first run of the
 * instance, or as an admin of an existing organization. The Worker decides.
 */
export const organizationCreationQuery = queryOptions({
  queryKey: ["organization-creation"],
  queryFn: ({ signal }) =>
    requestJson("/api/organization-creation", OrganizationCreation, { signal }),
});

/** Creates an organization and its first form, from the fields of the creation form. */
export async function createOrganization(form: FormData) {
  await request(path, { method: "POST", json: decodeSetup(Object.fromEntries(form)) });
}

/** Creates an organization, then reads the organizations of the account again. */
export const createOrganizationMutation = mutationOptions({
  mutationFn: createOrganization,
  onSuccess: (_created, _form, _context, { client }) =>
    client.invalidateQueries({ queryKey: organizationsQuery.queryKey }),
});
