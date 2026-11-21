import { Context, Effect, Schema } from "effect";

import type { TurnstileToken } from "../domain/forms/turnstile.ts";
import type { SealedSecret } from "./secret-cipher.ts";

export class TurnstileUnavailable extends Schema.TaggedError<
  TurnstileUnavailable,
  { readonly brand: unique symbol }
>()("TurnstileUnavailable", { source: Schema.Literals(["secret", "siteverify"]) }) {}

export class TurnstileVerifier extends Context.Service<
  TurnstileVerifier,
  {
    readonly verify: (
      publicId: string,
      secret: SealedSecret,
      token: TurnstileToken,
    ) => Effect.Effect<boolean, TurnstileUnavailable>;
  }
>()("rondyr/ports/turnstile-verifier/TurnstileVerifier") {}

export const turnstileSecretOwner = (publicId: string) => `turnstile/${publicId}`;
