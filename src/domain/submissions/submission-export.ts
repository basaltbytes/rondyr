import { DateTime, Effect, Schema } from "effect";

import { QuarantineReason, SubmissionLabel } from "./classification.ts";
import { SubmissionStatus } from "./inbox.ts";
import { SubmissionFields } from "./submission-fields.ts";
import { SubmissionId } from "./submission.id.ts";

/** An export holds at most this many messages: the newest of the list. */
export const maxExportedSubmissions = 10_000;

/**
 * A CSV export has at most this many field columns: the names that the most
 * messages of the export use. Visitors choose the field names, so without a cap
 * a few thousand spam messages could give an export a column per name.
 */
export const maxFieldColumns = 100;

/** The last column of a CSV export when its messages have more field names than columns. */
export const otherFieldsColumn = "other_fields";

/** CSV for a spreadsheet, or JSON Lines, one message per line, for a program. */
export const ExportFormat = Schema.Literals(["csv", "jsonl"]);
export type ExportFormat = typeof ExportFormat.Type;

/** One message of an export, with its full fields. */
export const ExportedSubmission = Schema.Struct({
  submissionId: SubmissionId,
  /** Milliseconds since the epoch. */
  receivedAt: Schema.Int,
  formPublicId: Schema.String,
  formName: Schema.String,
  status: SubmissionStatus,
  reason: Schema.NullOr(QuarantineReason),
  label: Schema.NullOr(SubmissionLabel),
  fields: SubmissionFields,
});
export type ExportedSubmission = typeof ExportedSubmission.Type;

/** A line of a JSON Lines export. The date of reception is an ISO 8601 UTC string. */
export const ExportLine = Schema.Struct({
  submissionId: SubmissionId,
  receivedAt: Schema.String,
  form: Schema.Struct({ publicId: Schema.String, name: Schema.String }),
  status: SubmissionStatus,
  reason: Schema.NullOr(QuarantineReason),
  label: Schema.NullOr(SubmissionLabel),
  fields: SubmissionFields,
});

export function receivedAtIso(receivedAt: number) {
  return DateTime.formatIso(DateTime.makeUnsafe(receivedAt));
}

export function exportLine(submission: ExportedSubmission): typeof ExportLine.Type {
  return {
    submissionId: submission.submissionId,
    receivedAt: receivedAtIso(submission.receivedAt),
    form: { publicId: submission.formPublicId, name: submission.formName },
    status: submission.status,
    reason: submission.reason,
    label: submission.label,
    fields: submission.fields,
  };
}

const fixedColumns: ReadonlyArray<string> = [
  "submission_id",
  "received_at",
  "form",
  "form_name",
  "status",
  "reason",
  "label",
];

// A spreadsheet runs a cell that starts with one of these characters as a formula,
// and a visitor writes the fields: such a cell starts with an apostrophe.
const formulaStart = /^[=+\-@\t\r]/u;

/** A CSV cell (RFC 4180), with a formula neutralized. */
export function csvCell(value: string) {
  const safe = formulaStart.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const encodeOtherFields = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/**
 * The field columns of a CSV export: the names, and whether the messages have
 * other field names, which then share the last column as a JSON object.
 */
export interface CsvColumns {
  readonly fieldNames: ReadonlyArray<string>;
  readonly otherFields: boolean;
}

/**
 * The header of a CSV export: the columns of every message, one column per field
 * name, then `other_fields` if some names have no column. A field whose name is
 * one of the other columns gets " (field)".
 */
export function csvHeader({ fieldNames, otherFields }: CsvColumns) {
  const reserved = otherFields ? [...fixedColumns, otherFieldsColumn] : fixedColumns;
  const fields = fieldNames.map((name) => (reserved.includes(name) ? `${name} (field)` : name));
  const columns = [...fixedColumns, ...fields, ...(otherFields ? [otherFieldsColumn] : [])];
  return `${columns.map(csvCell).join(",")}\r\n`;
}

/**
 * One message as a CSV line, with an empty cell for a field that it does not
 * have, and its fields without a column as a JSON object in `other_fields`.
 */
export const csvLine = Effect.fnUntraced(function* (
  submission: ExportedSubmission,
  { fieldNames, otherFields }: CsvColumns,
) {
  // A message without the field gets an empty cell, even for a name such as
  // `toString` that every object inherits.
  const cell = (name: string) =>
    Object.hasOwn(submission.fields, name) ? (submission.fields[name] ?? "") : "";
  const named = new Set(fieldNames);
  const rest = Object.entries(submission.fields).filter(([name]) => !named.has(name));
  const other = !otherFields
    ? []
    : [rest.length === 0 ? "" : yield* encodeOtherFields(Object.fromEntries(rest))];
  const cells = [
    submission.submissionId,
    receivedAtIso(submission.receivedAt),
    submission.formPublicId,
    submission.formName,
    submission.status,
    submission.reason ?? "",
    submission.label ?? "",
    ...fieldNames.map(cell),
    ...other,
  ];
  return `${cells.map(csvCell).join(",")}\r\n`;
});

/** Field names in a stable order: array indices first, in numeric order, then the others. */
export function orderFieldNames(names: ReadonlyArray<string>) {
  const index = /^(?:0|[1-9]\d*)$/u;
  return names.toSorted((a, b) => {
    const aIndex = index.test(a);
    const bIndex = index.test(b);
    if (aIndex && bIndex) return Number(a) - Number(b);
    if (aIndex !== bIndex) return aIndex ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
