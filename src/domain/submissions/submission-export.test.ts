import { assert, it } from "@effect/vitest";

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

it("leaves the cell of a field that a message lacks empty, whatever its name", () => {
  const line = csvLine(row, ["message", "toString", "constructor", "hasOwnProperty"]);

  assert.strictEqual(
    line,
    "73123ee4-40bf-4c5f-b8ff-1d56cdaa7640,1970-01-01T00:00:00.000Z,contact,Contact,accepted,,,Hello,,,\r\n",
  );
});

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
    csvHeader(["status", "email"]),
    "submission_id,received_at,form,form_name,status,reason,label,status (field),email\r\n",
  );
});
