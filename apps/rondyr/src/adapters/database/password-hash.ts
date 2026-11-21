import { Effect, Redacted } from "effect";

import { StorageUnavailable } from "../../ports/storage.ts";

/** Better Auth's hash of a password, which its sign-in verifies. Loaded only on this path. */
export const passwordHash = Effect.fnUntraced(function* (password: Redacted.Redacted<string>) {
  const { hashPassword } = yield* Effect.tryPromise({
    try: () => import("better-auth/crypto"),
    catch: () => StorageUnavailable.make(),
  });
  return yield* Effect.tryPromise({
    try: () => hashPassword(Redacted.value(password)),
    catch: () => StorageUnavailable.make(),
  });
});
