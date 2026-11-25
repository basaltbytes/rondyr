import { Context, Effect, Option, Redacted, Schema } from "effect";

import type { TurnstileToken } from "../../domain/forms/turnstile.ts";
import type { SealedSecret } from "./secret-cipher.ts";

export class TurnstileUnavailable extends Schema.TaggedError<
  TurnstileUnavailable,
  { readonly brand: unique symbol }
>()("TurnstileUnavailable", { source: Schema.Literals(["secret", "siteverify"]) }) {}

/** Siteverify does not know the secret key: it is mistyped, deleted, or not a Turnstile secret. */
export class TurnstileSecretRefused extends Schema.TaggedError<
  TurnstileSecretRefused,
  { readonly brand: unique symbol }
>()("TurnstileSecretRefused", {}) {}

export type TurnstileResult =
  | { readonly passed: true }
  | { readonly passed: false; readonly errorCodes: ReadonlyArray<string> };

export class TurnstileVerifier extends Context.Service<
  TurnstileVerifier,
  {
    readonly verify: (
      publicId: string,
      secret: SealedSecret,
      token: TurnstileToken,
      visitorIp: Option.Option<string>,
    ) => Effect.Effect<TurnstileResult, TurnstileUnavailable>;
    /** Ask Siteverify whether it knows a secret key, before the key is stored. */
    readonly checkSecret: (
      secret: Redacted.Redacted<string>,
    ) => Effect.Effect<void, TurnstileSecretRefused | TurnstileUnavailable>;
  }
>()("rondyr/worker/ports/turnstile-verifier/TurnstileVerifier") {}

export const turnstileSecretOwner = (publicId: string) => `turnstile/${publicId}`;
