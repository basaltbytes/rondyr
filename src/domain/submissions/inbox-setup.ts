import { Schema } from "effect";

import { BusinessContext, FormName, ManagedForm } from "../forms/form.ts";
import { OrganizationId } from "./submission.id.ts";

export const SetupInbox = Schema.Struct({
  organizationName: FormName,
  formName: FormName,
  businessContext: BusinessContext,
});

export const InboxOrganizationWithForms = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  forms: Schema.Array(ManagedForm),
});
