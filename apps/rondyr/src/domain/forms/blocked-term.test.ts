import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";

import {
  BlockedTerm,
  findMatchedBlockedTerm,
  matchesBlockedTerm,
  maxBlockedTermLength,
  parseBlockedTerm,
  searchableSubmissionText,
} from "./blocked-term.ts";

describe("parseBlockedTerm", () => {
  it("normalizes case, accents, compatibility forms, punctuation and whitespace", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["SEO", "seo"],
      ["  Agence   SEO!! ", "agence seo"],
      ["société", "societe"],
      ["cásino", "casino"],
      ["CAFÉ", "cafe"],
      ["cafe\u0301", "cafe"],
      ["ｓｅｏ", "seo"],
      ["spam.example.com", "spam example com"],
      ["sales@spam.example.com", "sales spam example com"],
      ["back-links / guest_post", "back links guest post"],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(parseBlockedTerm(input), Result.succeed(BlockedTerm.make(expected)));
    }
  });

  it("refuses empty or punctuation-only terms and overly long terms", () => {
    for (const input of ["", "   ", "---", "!!! @@@"]) {
      assert.deepEqual(parseBlockedTerm(input), Result.fail("empty"));
    }
    assert.deepEqual(
      parseBlockedTerm("a".repeat(maxBlockedTermLength)),
      Result.succeed(BlockedTerm.make("a".repeat(maxBlockedTermLength))),
    );
    assert.deepEqual(
      parseBlockedTerm("a".repeat(maxBlockedTermLength + 1)),
      Result.fail("too-long"),
    );
    assert.deepEqual(parseBlockedTerm(" ".repeat(3000)), Result.fail("too-long"));
  });
});

const mustTerm = (input: string) => {
  const parsed = parseBlockedTerm(input);
  if (Result.isFailure(parsed)) throw new Error(`Expected valid term: ${input}`);
  return parsed.success;
};

describe("searchableSubmissionText, matchesBlockedTerm and findMatchedBlockedTerm", () => {
  it("matches whole words, phrases, domains and folded accents", () => {
    const fields = {
      email: "offer@spam.example.com",
      message: "Bonjour! Notre société propose un cásino et du café.",
    };
    const searchable = searchableSubmissionText(fields);
    assert.isTrue(matchesBlockedTerm(searchable, mustTerm("societe")));
    assert.isTrue(matchesBlockedTerm(searchable, mustTerm("casino")));
    assert.isTrue(matchesBlockedTerm(searchable, mustTerm("cafe")));
    assert.isTrue(matchesBlockedTerm(searchable, mustTerm("spam.example.com")));
    assert.isTrue(matchesBlockedTerm(searchable, mustTerm("offer@spam.example.com")));
    assert.strictEqual(
      findMatchedBlockedTerm(fields, [mustTerm("unknown"), mustTerm("société")]),
      BlockedTerm.make("societe"),
    );
  });

  it("does not match partial words or phrases spanning separate fields", () => {
    const fields = {
      name: "Agence",
      message: "Visite au museo demain.",
    };
    const searchable = searchableSubmissionText(fields);
    assert.isFalse(matchesBlockedTerm(searchable, mustTerm("seo")));
    assert.isFalse(matchesBlockedTerm(searchable, mustTerm("agence visite")));
    assert.isNull(findMatchedBlockedTerm(fields, [mustTerm("seo"), mustTerm("agence visite")]));
  });

  it("returns an empty string when fields contain no letters or digits", () => {
    const fields = { message: "!!!", empty: "" };
    const searchable = searchableSubmissionText(fields);
    assert.strictEqual(searchable, "");
    assert.isFalse(matchesBlockedTerm(searchable, mustTerm("a")));
    assert.isNull(findMatchedBlockedTerm(fields, [mustTerm("a")]));
  });
});
