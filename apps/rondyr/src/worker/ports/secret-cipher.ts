import { Context, Effect, Redacted, Schema } from "effect";

/** `RONDYR_SECRETS_KEY` is unset, or is not 32 bytes encoded in base64. */
export class SecretsKeyMissing extends Schema.TaggedError<
  SecretsKeyMissing,
  { readonly brand: unique symbol }
>()("SecretsKeyMissing", {}) {}

/** The key is missing, or the sealed secret was not encrypted with it for this owner. */
export class SecretUnreadable extends Schema.TaggedError<
  SecretUnreadable,
  { readonly brand: unique symbol }
>()("SecretUnreadable", {}) {}

/** A secret encrypted with the Worker's key, safe to store in D1. */
export const SealedSecret = Schema.String.pipe(Schema.brand("SealedSecret"));
export type SealedSecret = typeof SealedSecret.Type;

export class SecretCipher extends Context.Service<
  SecretCipher,
  {
    /** Encrypt a secret for one owner, such as the target it signs for. */
    readonly seal: (
      secret: Redacted.Redacted<string>,
      owner: string,
    ) => Effect.Effect<SealedSecret, SecretsKeyMissing>;
    /** Decrypt a secret sealed for the same owner. */
    readonly open: (
      sealed: SealedSecret,
      owner: string,
    ) => Effect.Effect<Redacted.Redacted<string>, SecretUnreadable>;
  }
>()("rondyr/worker/ports/secret-cipher/SecretCipher") {}
