import { describe, expect, it } from "vitest";

import { readSecrets } from "./secrets.ts";

const token = `rdr_${"a1B2-_".repeat(7)}x`;

describe("readSecrets", () => {
  it("uses a Rondyr API token, trimmed", () => {
    expect(readSecrets(` ${token}\n`, " whsec_secret ")).toEqual({
      token,
      tokenProblem: null,
      webhookSecrets: ["whsec_secret"],
    });
  });

  it("says when the token is missing", () => {
    for (const value of [undefined, "", "  "]) {
      expect(readSecrets(value, undefined)).toEqual({
        token: null,
        tokenProblem: "token-missing",
        webhookSecrets: [],
      });
    }
  });

  it("reads one webhook secret per Rondyr webhook", () => {
    expect(readSecrets(token, "whsec_one, whsec_two\nwhsec_three").webhookSecrets).toEqual([
      "whsec_one",
      "whsec_two",
      "whsec_three",
    ]);
  });

  it("never uses a value that is not a Rondyr API token", () => {
    for (const value of [`Bearer ${token}`, `${token}\nrdr_other`, "rdr_short", token.slice(4)]) {
      expect(readSecrets(value, undefined)).toMatchObject({
        token: null,
        tokenProblem: "token-malformed",
      });
    }
  });
});
