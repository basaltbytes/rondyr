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
