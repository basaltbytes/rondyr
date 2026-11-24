import { Result, Schema } from "effect";

import type { SubmissionFields } from "../submissions/submission-fields.ts";

export const maxFormBlockedTerms = 100;

export const maxOrganizationBlockedTerms = 100;

export const maxBlockedTermLength = 100;
const maxBlockedTermInputLength = 2048;

/** Why a word, phrase, domain or address cannot be added to a blocked list. */
export const BlockedTermRefusalReason = Schema.Literals(["empty", "too-long"]);
export type BlockedTermRefusalReason = typeof BlockedTermRefusalReason.Type;

/**
 * A blocked term normalized by `parseBlockedTerm`: NFKD with combining marks
 * stripped, lowercase, and runs of non-letter/non-digit characters collapsed to
 * single spaces.
 */
export const BlockedTerm = Schema.String.pipe(Schema.brand("BlockedTerm"));
export type BlockedTerm = typeof BlockedTerm.Type;

// Strip combining diacritical marks after NFKD so "société" matches "societe" and "cásino" matches "casino".
const combiningMark = /\p{M}+/gu;
// Keep Unicode letters and digits; turn everything else into token boundaries.
const tokenSeparator = /[^\p{L}\p{N}]+/gu;

function normalizeTokens(text: string) {
  return text
    .normalize("NFKD")
    .replace(combiningMark, "")
    .toLowerCase()
    .replace(tokenSeparator, " ")
    .trim();
}

/**
 * Normalize a word, phrase, domain or email address for whole-token matching.
 * Refuses input with no letters or digits, or longer than `maxBlockedTermLength`
 * after normalization.
 */
export function parseBlockedTerm(
  input: string,
): Result.Result<BlockedTerm, BlockedTermRefusalReason> {
  if (input.length > maxBlockedTermInputLength) return Result.fail("too-long");
  const normalized = normalizeTokens(input);
  if (normalized.length === 0) return Result.fail("empty");
  if (normalized.length > maxBlockedTermLength) return Result.fail("too-long");
  return Result.succeed(BlockedTerm.make(normalized));
}

/**
 * Normalize every field value of a submission into one searchable string. Each
 * non-empty field value is wrapped in spaces and separated by a newline so
 * `instr(searchable, ' ' || term || ' ') > 0` matches whole words or phrases
 * within a single field without matching substrings or across field boundaries.
 */
export function searchableSubmissionText(fields: typeof SubmissionFields.Type): string {
  const parts: Array<string> = [];
  for (const value of Object.values(fields)) {
    const normalized = normalizeTokens(value);
    if (normalized !== "") parts.push(` ${normalized} `);
  }
  return parts.join("\n");
}

/** Whether a normalized submission text contains `term` on whole-word boundaries. */
export function matchesBlockedTerm(searchableText: string, term: BlockedTerm): boolean {
  return searchableText !== "" && searchableText.includes(` ${term} `);
}

/** Return the first blocked term matching any field value, or null. */
export function findMatchedBlockedTerm(
  fields: typeof SubmissionFields.Type,
  terms: ReadonlyArray<BlockedTerm>,
): BlockedTerm | null {
  const searchable = searchableSubmissionText(fields);
  if (searchable === "") return null;
  return terms.find((term) => matchesBlockedTerm(searchable, term)) ?? null;
}

/** A blocked term of a form or organization, as the admin API returns it. */
export const FormBlockedTerm = Schema.Struct({
  term: BlockedTerm,
  /** Milliseconds since the epoch. */
  createdAt: Schema.Int,
});

export const AddFormBlockedTerm = Schema.Struct({
  term: Schema.String.check(Schema.isMaxLength(maxBlockedTermInputLength)),
});

export const BlockedTermRequestError = Schema.Union([
  Schema.Struct({
    error: Schema.Literal("term-refused"),
    reason: BlockedTermRefusalReason,
  }),
  Schema.Struct({ error: Schema.Literal("term-limit") }),
]);
