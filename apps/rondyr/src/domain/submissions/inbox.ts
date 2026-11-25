import { Schema } from "effect";

import { QuarantineReason, SubmissionLabel } from "./classification.ts";
import { SubmissionFields } from "./submission-fields.ts";
import { FormId, OrganizationId, SubmissionId } from "./submission.id.ts";
import { SubmissionVerification } from "./verification.ts";

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
  /** The ID of the form in its submission address and in the admin API. */
  formPublicId: Schema.String,
  formName: Schema.String,
  receivedAt: Schema.Int,
  status: SubmissionStatus,
  reason: Schema.NullOr(QuarantineReason),
  label: Schema.NullOr(SubmissionLabel),
});

export const SubmissionDetail = InboxRow.mapFields((fields) => ({
  ...fields,
  fields: SubmissionFields,
  verification: SubmissionVerification,
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

/** How many submissions have each status. */
export const InboxCounts = Schema.Struct({
  received: Schema.Int,
  classifying: Schema.Int,
  accepted: Schema.Int,
  quarantined: Schema.Int,
  archived: Schema.Int,
});

/** The counts of one form, named by its public ID. */
export const FormCounts = Schema.Struct({ publicId: Schema.String, counts: InboxCounts });

/**
 * The counts of an organization, and those of each of its forms that has a
 * submission. A form without one is left out.
 */
export const OrganizationCounts = InboxCounts.mapFields((fields) => ({
  ...fields,
  forms: Schema.Array(FormCounts),
}));

/** The shortest search: shorter text would match most messages. */
export const minSearchLength = 3;

/**
 * Text to find in the values of the fields, without regard to the case of
 * ASCII letters. `%` and `_` are ordinary characters.
 */
export const SearchText = Schema.Trim.check(
  Schema.isMinLength(minSearchLength),
  Schema.isMaxLength(100),
);

/** Narrows a list of submissions. Without a key, the list has every submission. */
export const InboxFilter = Schema.Struct({
  status: Schema.optionalKey(SubmissionStatus),
  formPublicId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  search: Schema.optionalKey(SearchText),
});

export const InboxOrganization = Schema.Struct({ id: OrganizationId, name: Schema.String });
