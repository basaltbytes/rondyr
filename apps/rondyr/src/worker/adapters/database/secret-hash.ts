import { Effect, Redacted } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url, Hex } from "effect/encoding";

import { StorageUnavailable } from "../../ports/storage.ts";

const encoder = new TextEncoder();

/** 32 random bytes in base64url: the secret of a single-use link. */
export function newLinkSecret() {
  return Redacted.make(Base64Url.encode(SecureRandom.randomBytesUnsafe(32)));
}

/** The SHA-256 of a secret, in hexadecimal: what D1 keeps of it. */
export const hashSecret = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", encoder.encode(Redacted.value(secret))),
    catch: () => StorageUnavailable.make(),
  });
  return Hex.encode(new Uint8Array(digest));
});
