import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64, Base64Url } from "effect/encoding";

import {
  SealedSecret,
  SecretCipher,
  SecretsKeyMissing,
  SecretUnreadable,
} from "../../ports/secret-cipher.ts";

const KeyConfig = Schema.Struct({
  RONDYR_SECRETS_KEY: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
});

/** `RONDYR_SECRETS_KEY` from the Worker environment, when it is set. */
export const secretsKeyFromEnvironment = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.flatMap(({ env }) => Schema.decodeUnknownEffect(KeyConfig)(env)),
  Effect.map(({ RONDYR_SECRETS_KEY: key }) => Option.fromUndefinedOr(key)),
  Effect.orElseSucceed(() => Option.none<Redacted.Redacted<string>>()),
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const version = "v1";
const nonceLength = 12;

/**
 * AES-256-GCM under a key of 32 bytes in base64. The owner is the additional
 * authenticated data, so a secret copied to another target does not open.
 * A sealed secret is `v1.<nonce>.<ciphertext>`, both in base64url.
 */
export function secretCipherLayer(
  readKey: Effect.Effect<Option.Option<Redacted.Redacted<string>>>,
) {
  const cryptoKey = Effect.gen(function* () {
    const configured = yield* readKey;
    if (Option.isNone(configured)) return yield* SecretsKeyMissing.make();
    const bytes = Base64.decode(Redacted.value(configured.value).trim());
    if (Result.isFailure(bytes) || bytes.success.byteLength !== 32) {
      return yield* SecretsKeyMissing.make();
    }
    const raw = new Uint8Array(bytes.success);
    return yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
      catch: () => SecretsKeyMissing.make(),
    });
  });

  const seal = Effect.fn("SecretCipher.seal")(function* (
    secret: Redacted.Redacted<string>,
    owner: string,
  ) {
    const key = yield* cryptoKey;
    const nonce = new Uint8Array(SecureRandom.randomBytesUnsafe(nonceLength));
    const ciphertext = yield* Effect.promise(() =>
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(owner) },
        key,
        encoder.encode(Redacted.value(secret)),
      ),
    );
    return SealedSecret.make(
      `${version}.${Base64Url.encode(nonce)}.${Base64Url.encode(new Uint8Array(ciphertext))}`,
    );
  });

  const open = Effect.fn("SecretCipher.open")(function* (sealed: SealedSecret, owner: string) {
    const key = yield* Effect.mapError(cryptoKey, () => SecretUnreadable.make());
    const [prefix, nonceText = "", ciphertextText = "", ...rest] = sealed.split(".");
    const nonce = Base64Url.decode(nonceText);
    const ciphertext = Base64Url.decode(ciphertextText);
    if (
      prefix !== version ||
      rest.length > 0 ||
      Result.isFailure(nonce) ||
      Result.isFailure(ciphertext) ||
      nonce.success.byteLength !== nonceLength
    ) {
      return yield* SecretUnreadable.make();
    }
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(nonce.success),
            additionalData: encoder.encode(owner),
          },
          key,
          new Uint8Array(ciphertext.success),
        ),
      catch: () => SecretUnreadable.make(),
    });
    return Redacted.make(decoder.decode(plaintext));
  });

  return Layer.succeed(SecretCipher, { seal, open });
}

export const secretCipherLive = secretCipherLayer(secretsKeyFromEnvironment);
