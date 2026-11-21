import { assert, it } from "@effect/vitest";

import { previewFields } from "./inbox.ts";

it("keeps a value of 240 characters whole in the preview", () => {
  const preview = previewFields({ message: "a".repeat(240) });

  assert.strictEqual(preview["message"], "a".repeat(240));
});

it("cuts a value of 241 characters to 240 and an ellipsis", () => {
  const preview = previewFields({ message: "a".repeat(241) });

  assert.strictEqual(preview["message"], `${"a".repeat(240)}…`);
});

it("does not cut a character that takes two UTF-16 units", () => {
  // 239 letters, then an emoji as the 240th character, then one more letter.
  const preview = previewFields({ message: `${"a".repeat(239)}😀b` });

  assert.strictEqual(preview["message"], `${"a".repeat(239)}😀…`);
});

it("keeps every field of the submission in the preview", () => {
  const preview = previewFields({ name: "Ada", email: "ada@example.test", message: "Hello" });

  assert.deepEqual(preview, { name: "Ada", email: "ada@example.test", message: "Hello" });
});
