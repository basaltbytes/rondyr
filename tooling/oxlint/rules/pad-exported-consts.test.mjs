import assert from "node:assert/strict";
import { test } from "node:test";
import { lint } from "../test/lint.mjs";

test("requires a blank line before the next exported const even with a doc comment", () => {
  const result = lint(
    "lib/example.ts",
    "export const first = 1;\n/** The second value. */\nexport const second = 2;\n",
  );

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /pad-exported-consts/u);
});

test("allows adjacent local constants and separated exported constants", () => {
  const result = lint(
    "lib/example.ts",
    `export const first = () => {
  const step = 1;
  const result = step + 1;
  return result;
};

/** The second value. */
export const second = 2;
`,
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
});
