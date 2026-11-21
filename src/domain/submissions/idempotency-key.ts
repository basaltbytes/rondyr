import { Schema } from "effect";

/**
 * The `Idempotency-Key` of a server intake: 1 to 128 printable ASCII characters.
 * Its scope is the form, and it lives as long as the submission it names.
 */
export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{1,128}$/u)).pipe(
  Schema.brand("IdempotencyKey"),
);
export type IdempotencyKey = typeof IdempotencyKey.Type;
