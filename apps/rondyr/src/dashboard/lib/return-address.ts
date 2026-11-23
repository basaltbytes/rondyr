import { Effect, Schema } from "effect";

/**
 * Whether `address` is a path of `origin`: it starts with one slash, and the browser
 * resolves it on the same origin. `//host`, `/\\host` and absolute URLs fail.
 */
export function isPathOf(origin: string, address: string) {
  if (!address.startsWith("/")) return false;
  try {
    return new URL(address, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The search params of the sign-in page: the address that the visitor asked for, where
 * they arrive once signed in. An address of another origin is ignored.
 */
export function signInSearchOf(origin: string) {
  const ReturnAddress = Schema.String.check(
    Schema.makeFilter((address) => isPathOf(origin, address) || "Expected a path of this origin"),
  );
  return Schema.Struct({
    redirect: Schema.optionalKey(
      ReturnAddress.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
    ),
  });
}
