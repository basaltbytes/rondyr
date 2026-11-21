import { describe, expect, it, vi } from "vitest";

import { enqueueCredential, matchesCredential } from "./hop.ts";

describe("the enqueue credential", () => {
  it("is the API token when it is set", () => {
    expect(enqueueCredential("rdr_token")).toBe("rdr_token");
    expect(matchesCredential("Bearer rdr_token", "rdr_token")).toBe(true);
    expect(matchesCredential("Bearer rdr_other", "rdr_token")).toBe(false);
    expect(matchesCredential("Bearer rdr_token ", "rdr_token")).toBe(false);
    expect(matchesCredential("rdr_token", "rdr_token")).toBe(false);
    expect(matchesCredential(null, "rdr_token")).toBe(false);
  });

  it("is one random key per isolate without a token, never the empty string", () => {
    const key = enqueueCredential(null);
    expect(key).toMatch(/^hop_[0-9a-f]{64}$/u);
    expect(enqueueCredential(null)).toBe(key);
    expect(matchesCredential("Bearer ", key)).toBe(false);
    expect(matchesCredential(`Bearer ${key}`, key)).toBe(true);
  });

  it("is the same key in another copy of the module, as when a build duplicates it", async () => {
    const key = enqueueCredential(null);
    // After a reset, the import evaluates the module again: a second, separate instance.
    vi.resetModules();
    const copy = await import("./hop.ts");
    expect(copy.enqueueCredential).not.toBe(enqueueCredential);
    expect(copy.enqueueCredential(null)).toBe(key);
  });
});
