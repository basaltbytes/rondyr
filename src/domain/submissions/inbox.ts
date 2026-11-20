import { Schema } from "effect";

import { QuarantineReason } from "./classification.ts";
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
  reason: Schema.NullOr(QuarantineReason),
});

export const SubmissionDetail = InboxRow.mapFields((fields) => ({
  ...fields,
  fields: SubmissionFields,
}));

/** A page of the inbox. Each entry has its fields, so a list shows who wrote and what. */
export const InboxPage = Schema.Struct({
  entries: Schema.Array(SubmissionDetail),
  cursor: Schema.NullOr(Schema.String),
});

/** How many submissions of an organization have each status. */
export const InboxCounts = Schema.Struct({
  received: Schema.Int,
  classifying: Schema.Int,
  accepted: Schema.Int,
  quarantined: Schema.Int,
  archived: Schema.Int,
});

export const InboxOrganization = Schema.Struct({ id: OrganizationId, name: Schema.String });
