import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { FormEmoji } from "./form.ts";

const accepts = Schema.is(Schema.toType(FormEmoji));

it("accepts one emoji, a flag and a joined sequence included", () => {
  for (const emoji of ["📮", "🎟️", "🇫🇷", "🧑‍💻", "👍🏽"]) assert.isTrue(accepts(emoji), emoji);
});

it("refuses text, several emoji and an empty value", () => {
  for (const text of ["", "a", "7", "form", "📮📮", "📮 a"]) assert.isFalse(accepts(text), text);
});
