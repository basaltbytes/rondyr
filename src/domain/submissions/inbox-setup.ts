import { Schema } from "effect";

import { BusinessContext, FormName, ManagedForm } from "../forms/form.ts";
import { MemberRole } from "../organizations/member-role.ts";
import { OrganizationId } from "./submission.id.ts";

export const SetupInbox = Schema.Struct({
  organizationName: FormName,
  formName: FormName,
  businessContext: BusinessContext,
});

/** An organization of the account, its role in it, and its forms. */
export const InboxOrganizationWithForms = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  role: MemberRole,
  forms: Schema.Array(ManagedForm),
});
