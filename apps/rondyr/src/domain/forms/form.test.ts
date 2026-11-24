import { assert, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { SetupInbox } from "../submissions/inbox-setup.ts";
import { FormEmoji, FormName } from "./form.ts";

const accepts = Schema.is(Schema.toType(FormEmoji));
const decodeFormName = Schema.decodeUnknownOption(FormName);
const decodeSetupInbox = Schema.decodeUnknownOption(SetupInbox);

it("accepts one emoji, a flag and a joined sequence included", () => {
  for (const emoji of ["📮", "🎟️", "🇫🇷", "🧑‍💻", "👍🏽"]) assert.isTrue(accepts(emoji), emoji);
});

it("refuses text, several emoji and an empty value", () => {
  for (const text of ["", "a", "7", "form", "📮📮", "📮 a"]) assert.isFalse(accepts(text), text);
});

it("accepts and trims valid form names", () => {
  assert.deepEqual(decodeFormName("Contact"), Option.some("Contact"));
  assert.deepEqual(decodeFormName("  Pottery classes  "), Option.some("Pottery classes"));
  assert.deepEqual(decodeFormName("a".repeat(100)), Option.some("a".repeat(100)));
});

it("refuses form names with control characters or line breaks", () => {
  const invalid = [
    "",
    "   ",
    "a".repeat(101),
    "Contact\r\nBcc: evil@example.test",
    "Contact\n",
    "\rContact",
    "Con\ntact",
    "Con\rtact",
    "Con\ttact",
    "Con\u0000tact",
    "Con\u001ftact",
    "Con\u007ftact",
    "Con\u0085tact",
    "Con\u2028tact",
    "Con\u2029tact",
  ];
  for (const name of invalid) {
    assert.isTrue(Option.isNone(decodeFormName(name)), name);
  }
});

it("refuses control characters in organizationName and formName during inbox setup", () => {
  assert.isTrue(
    Option.isNone(
      decodeSetupInbox({
        organizationName: "Studio\r\nHeader: injected",
        formName: "Contact",
        businessContext: "",
      }),
    ),
  );
  assert.isTrue(
    Option.isNone(
      decodeSetupInbox({
        organizationName: "Studio",
        formName: "Contact\u2028Line",
        businessContext: "",
      }),
    ),
  );
});
