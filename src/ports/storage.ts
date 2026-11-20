import { Schema } from "effect";

/** The database could not complete the operation, or returned rows that do not decode. */
export class StorageUnavailable extends Schema.TaggedError<
  StorageUnavailable,
  { readonly brand: unique symbol }
>()("StorageUnavailable", {}) {}
