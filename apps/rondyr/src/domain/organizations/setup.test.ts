import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { setupState } from "./setup.ts";

describe("setupState", () => {
  it("is closed once an account exists, whatever the token", () => {
    assert.strictEqual(setupState(true, Option.none()), "closed");
    assert.strictEqual(setupState(true, Option.some("short")), "closed");
    assert.strictEqual(setupState(true, Option.some("a".repeat(32))), "closed");
  });

  it("is open without an account and with a token of at least 32 characters", () => {
    assert.strictEqual(setupState(false, Option.some("a".repeat(32))), "open");
  });

  it("names the missing or too short token of an instance without an account", () => {
    assert.strictEqual(setupState(false, Option.none()), "token-missing");
    assert.strictEqual(setupState(false, Option.some("")), "token-too-short");
    assert.strictEqual(setupState(false, Option.some("a".repeat(31))), "token-too-short");
  });
});
