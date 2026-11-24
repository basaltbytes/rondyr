import { Schema } from "effect";

import { BusinessContext, FormName, ManagedForm } from "../forms/form.ts";
import { MemberRole } from "../organizations/member-role.ts";
import { OrganizationId } from "./submission.id.ts";

export const SetupInbox = Schema.Struct({
  organizationName: FormName,
  formName: FormName,
  businessContext: BusinessContext,
});

/**
 * The answer of `GET /api/organization-creation`: whether the signed-in account
 * may create an organization. It may while the instance has none, and then only
 * as an admin of an existing one.
 */
export const OrganizationCreation = Schema.Struct({ allowed: Schema.Boolean });

/** An organization of the account, its role in it, and its forms. */
export const InboxOrganizationWithForms = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  role: MemberRole,
  forms: Schema.Array(ManagedForm),
});
