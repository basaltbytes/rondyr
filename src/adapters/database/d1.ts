import { Effect, Schema } from "effect";

export class StorageUnavailable extends Schema.TaggedError<
  StorageUnavailable,
  { readonly brand: unique symbol }
>()("StorageUnavailable", {}) {}

export const database = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.map(({ env }) => env.DB),
);

export const d1 = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => StorageUnavailable.make() });
