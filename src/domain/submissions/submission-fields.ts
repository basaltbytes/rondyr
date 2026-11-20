import { Schema } from "effect";

const FieldName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const FieldValue = Schema.String.check(Schema.isMaxLength(4000));

export const SubmissionFields = Schema.Record(FieldName, FieldValue).check(
  Schema.makeFilter((fields) => {
    const names = Object.keys(fields);
    return (
      (names.length >= 1 &&
        names.length <= 32 &&
        names.every(
          (name) => name !== "__proto__" && name !== "constructor" && name !== "prototype",
        )) ||
      "Expected 1 to 32 form fields with safe field names"
    );
  }),
);

// C0 and C1 control characters, which include CR, LF and NEL, and the Unicode line separators.
const controlCharacter = /[\p{Cc}\u2028\u2029]/u;

/**
 * Whether intake accepts `name` as a field name, besides its length of 1 to 100
 * characters: not a reserved name, and without a control character or a line break.
 */
export function isSubmittedFieldName(name: string) {
  return (
    name !== "__proto__" &&
    name !== "constructor" &&
    name !== "prototype" &&
    !controlCharacter.test(name)
  );
}

/**
 * The fields of a new submission. Intake also refuses a field name with a
 * control character or a line break. Stored submissions are read with
 * `SubmissionFields`, so a message received before this rule stays readable.
 */
export const SubmittedFields = SubmissionFields.check(
  Schema.makeFilter(
    (fields) =>
      Object.keys(fields).every((name) => !controlCharacter.test(name)) ||
      "Expected field names without control characters or line breaks",
  ),
);

/**
 * Join the values of a repeated field name with `, `, in the order received,
 * as an HTML form sends a group of checkboxes or a multiple select.
 */
export function joinRepeatedFields(entries: Iterable<readonly [string, string]>) {
  const fields = new Map<string, string>();
  for (const [name, value] of entries) {
    const previous = fields.get(name);
    fields.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }
  // Object.fromEntries defines own properties, so `__proto__` stays a field name
  // that the schema refuses, not a prototype.
  return Object.fromEntries(fields);
}
