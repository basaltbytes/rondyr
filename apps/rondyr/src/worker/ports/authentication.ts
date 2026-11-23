import { Context, Effect, Schema } from "effect";

import type { SetupState } from "../../domain/organizations/setup.ts";

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
/** One client tried too many setup tokens in a minute. */
export class SetupRateLimited extends Schema.TaggedError<
  SetupRateLimited,
  { readonly brand: unique symbol }
>()("SetupRateLimited", {}) {}
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
    /** Whether the first account can be created, for the setup page of the dashboard. */
    readonly setupState: Effect.Effect<SetupState, AuthUnavailable>;
    readonly setup: (
      request: Request,
    ) => Effect.Effect<
      void,
      AuthUnavailable | AuthOriginRefused | SetupClosed | SetupRateLimited | InvalidSetup
    >;
  }
>()("rondyr/worker/ports/authentication") {}
