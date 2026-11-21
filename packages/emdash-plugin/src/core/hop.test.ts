import { describe, expect, it } from "vitest";

import { enqueueCredential, matchesCredential } from "./hop.ts";

describe("the enqueue credential", () => {
  it("is the API token when it is set", () => {
    expect(enqueueCredential("rdr_token")).toBe("rdr_token");
    expect(matchesCredential("Bearer rdr_token", "rdr_token")).toBe(true);
    expect(matchesCredential("Bearer rdr_other", "rdr_token")).toBe(false);
    expect(matchesCredential("rdr_token", "rdr_token")).toBe(false);
    expect(matchesCredential(null, "rdr_token")).toBe(false);
  });

  it("is one key per isolate without a token, never the empty string", () => {
    const key = enqueueCredential(null);
    expect(key).toMatch(/^hop_[0-9a-f-]{36}$/u);
    expect(enqueueCredential(null)).toBe(key);
    expect(matchesCredential("Bearer ", key)).toBe(false);
  });
});
