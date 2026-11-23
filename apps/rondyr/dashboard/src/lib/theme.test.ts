import { assert, it } from "@effect/vitest";

import { chooseTheme } from "./theme.ts";

it("shows the stored choice", () => {
  assert.strictEqual(chooseTheme("light"), "light");
  assert.strictEqual(chooseTheme("dark"), "dark");
});

it("follows the system without a stored choice", () => {
  assert.strictEqual(chooseTheme(null), "system");
});

it("follows the system when the stored choice is not a theme", () => {
  assert.strictEqual(chooseTheme("sepia"), "system");
});
