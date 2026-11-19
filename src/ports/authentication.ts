import { Context, Effect, Schema } from "effect";

export class AuthUnavailable extends Schema.TaggedError<
  AuthUnavailable,
  { readonly brand: unique symbol }
>()("AuthUnavailable", {}) {}
export class AuthOriginRefused extends Schema.TaggedError<
  AuthOriginRefused,
  { readonly brand: unique symbol }
>()("AuthOriginRefused", {}) {}
export class SetupClosed extends Schema.TaggedError<
  SetupClosed,
  { readonly brand: unique symbol }
>()("SetupClosed", {}) {}
export class InvalidSetup extends Schema.TaggedError<
  InvalidSetup,
  { readonly brand: unique symbol }
>()("InvalidSetup", {}) {}

export class Authentication extends Context.Service<
  Authentication,
  {
    readonly handle: (
      request: Request,
    ) => Effect.Effect<Response, AuthUnavailable | AuthOriginRefused>;
    readonly userId: (
      request: Request,
    ) => Effect.Effect<string | null, AuthUnavailable | AuthOriginRefused>;
    readonly setup: (
      request: Request,
    ) => Effect.Effect<void, AuthUnavailable | AuthOriginRefused | SetupClosed | InvalidSetup>;
  }
>()("rondyr/ports/authentication") {}
