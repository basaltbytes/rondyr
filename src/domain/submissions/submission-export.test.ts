import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { csvCell, csvHeader, csvLine, orderFieldNames } from "./submission-export.ts";
import { SubmissionId } from "./submission.id.ts";

const row = {
  submissionId: SubmissionId.make("73123ee4-40bf-4c5f-b8ff-1d56cdaa7640"),
  receivedAt: 0,
  formPublicId: "contact",
  formName: "Contact",
  status: "accepted",
  reason: null,
  label: null,
  fields: { message: "Hello" },
} as const;

it.effect("leaves the cell of a field that a message lacks empty, whatever its name", () =>
  Effect.gen(function* () {
    const line = yield* csvLine(row, {
      fieldNames: ["message", "toString", "constructor", "hasOwnProperty"],
      otherFields: false,
    });

    assert.strictEqual(
      line,
      "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640,1970-01-01T00:00:00.000Z,contact,Contact,accepted,,,Hello,,,\r\n",
    );
  }),
);

it("quotes a cell when needed and neutralizes a formula", () => {
  assert.deepEqual(
    ["=1+1", "+1", "-1", "@SUM(A1)", "\tTab", 'say "hi"', "a,b", "line\nbreak", "plain"].map(
      csvCell,
    ),
    [
      "'=1+1",
      "'+1",
      "'-1",
      "'@SUM(A1)",
      "'\tTab",
      '"say ""hi"""',
      '"a,b"',
      '"line\nbreak"',
      "plain",
    ],
  );
});

it("orders array indices first, then names, and marks a name that a fixed column has", () => {
  assert.deepEqual(orderFieldNames(["b", "10", "a", "2"]), ["2", "10", "a", "b"]);
  assert.strictEqual(
    csvHeader({ fieldNames: ["status", "email"], otherFields: false }),
    "submission_id,received_at,form,form_name,status,reason,label,status (field),email\r\n",
  );
});

it.effect("puts the fields without a column in other_fields, as a JSON object", () =>
  Effect.gen(function* () {
    const columns = { fieldNames: ["message"], otherFields: true };
    const spam = { ...row, fields: { message: "Hello", other_fields: "x", "=cmd": "+1" } };
    const plain = yield* csvLine(row, columns);
    const withOthers = yield* csvLine(spam, columns);

    assert.strictEqual(
      csvHeader({ fieldNames: ["message", "other_fields"], otherFields: true }),
      "submission_id,received_at,form,form_name,status,reason,label,message,other_fields (field),other_fields\r\n",
    );
    assert.strictEqual(
      plain,
      "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640,1970-01-01T00:00:00.000Z,contact,Contact,accepted,,,Hello,\r\n",
    );
    assert.strictEqual(
      withOthers,
      '73123ee4-40bf-4c5f-b8ff-1d56cdaa7640,1970-01-01T00:00:00.000Z,contact,Contact,accepted,,,Hello,"{""other_fields"":""x"",""=cmd"":""+1""}"\r\n',
    );
  }),
);
