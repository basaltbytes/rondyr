import { Schema } from "effect";

import { OrganizationId } from "./submission.id.ts";

const Name = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));
export const SetupInbox = Schema.Struct({
  organizationName: Name,
  formName: Name,
  businessContext: Schema.Trim.check(Schema.isMaxLength(2000)),
});
export const InboxForm = Schema.Struct({ name: Schema.String, publicId: Schema.String });
export const InboxOrganizationWithForms = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  forms: Schema.Array(InboxForm),
});
