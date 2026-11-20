import { Context, Effect, Schema } from "effect";

import type { AllowedOrigin, FormOrigin } from "../domain/forms/allowed-origin.ts";
import type { FormScope } from "./notification-targets.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The form is not in an organization of the account, or the origin is not on its list. */
export class FormOriginNotFound extends Schema.TaggedError<
  FormOriginNotFound,
  { readonly brand: unique symbol }
>()("FormOriginNotFound", {}) {}

export interface AddedOrigin {
  readonly origin: typeof FormOrigin.Type;
  /** False when the origin was already on the list. */
  readonly created: boolean;
}

/** The browser origins allowed to submit to the forms of the account's organizations. */
export class FormOrigins extends Context.Service<
  FormOrigins,
  {
    readonly list: (
      form: FormScope,
    ) => Effect.Effect<
      ReadonlyArray<typeof FormOrigin.Type>,
      FormOriginNotFound | StorageUnavailable
    >;
    /** Add an origin. Adding an origin that is already on the list changes nothing. */
    readonly add: (
      form: FormScope,
      origin: AllowedOrigin,
    ) => Effect.Effect<AddedOrigin, FormOriginNotFound | StorageUnavailable>;
    readonly remove: (
      form: FormScope,
      origin: AllowedOrigin,
    ) => Effect.Effect<void, FormOriginNotFound | StorageUnavailable>;
  }
>()("rondyr/ports/form-origins/FormOrigins") {}
