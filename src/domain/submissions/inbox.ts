import { Schema } from "effect";

import { ClassificationReason } from "./classification.ts";
import { SubmissionFields } from "./submission-fields.ts";
import { FormId, OrganizationId, SubmissionId } from "./submission.id.ts";

export const SubmissionStatus = Schema.Literals([
  "received",
  "classifying",
  "accepted",
  "quarantined",
  "archived",
]);
export const InboxRow = Schema.Struct({
  submissionId: SubmissionId,
  organizationId: OrganizationId,
  formId: FormId,
  formName: Schema.String,
  receivedAt: Schema.Int,
  status: SubmissionStatus,
  reason: Schema.NullOr(ClassificationReason),
});
export const InboxPage = Schema.Struct({
  entries: Schema.Array(InboxRow),
  cursor: Schema.NullOr(Schema.String),
});
export const SubmissionDetail = InboxRow.mapFields((fields) => ({
  ...fields,
  fields: SubmissionFields,
}));
export const InboxOrganization = Schema.Struct({ id: OrganizationId, name: Schema.String });
