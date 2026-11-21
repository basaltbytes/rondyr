import { Schema } from "effect";

import { QuarantineReason, SubmissionLabel } from "./classification.ts";
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
  label: Schema.NullOr(SubmissionLabel),
});

export const SubmissionDetail = InboxRow.mapFields((fields) => ({
  ...fields,
  fields: SubmissionFields,
}));

/** The longest field value of a list entry, in characters as a reader counts them. */
export const previewValueLength = 240;

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function previewValue(value: string) {
  // A value this short in UTF-16 units cannot have more characters than the limit.
  if (value.length <= previewValueLength) return value;
  const cut = [...characters.segment(value)][previewValueLength];
  return cut === undefined ? value : `${value.slice(0, cut.index)}…`;
}

/**
 * The fields of a submission for a list: every field, each value cut to
 * `previewValueLength` characters, with an ellipsis when it is cut. A page of
 * long messages then stays small, and the detail route has the full values.
 */
export function previewFields(fields: typeof SubmissionFields.Type): typeof SubmissionFields.Type {
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, previewValue(value)]),
  );
}

/** A submission in a page of the inbox, with `preview` in place of its full fields. */
export const InboxEntry = InboxRow.mapFields((fields) => ({
  ...fields,
  preview: SubmissionFields,
}));

/** A page of the inbox. Each entry has a preview, so a list shows who wrote and what. */
export const InboxPage = Schema.Struct({
  entries: Schema.Array(InboxEntry),
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
