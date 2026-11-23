import { Context, Effect, Schema } from "effect";

import type {
  CreateForm,
  FormStatus,
  HoneypotField,
  ManagedForm,
  SuccessUrl,
  UpdateForm,
} from "../../domain/forms/form.ts";
import type { SetTurnstile, TurnstileKeyState } from "../../domain/forms/turnstile.ts";
import type { OrganizationId, UserId } from "../../domain/submissions/submission.id.ts";
import type { FormScope } from "./notification-targets.ts";
import type { SecretsKeyMissing } from "./secret-cipher.ts";
import type { StorageUnavailable } from "./storage.ts";
import type { TurnstileSecretRefused, TurnstileUnavailable } from "./turnstile-verifier.ts";

/** The organization or the form is not one of the account's. */
export class OrganizationFormNotFound extends Schema.TaggedError<
  OrganizationFormNotFound,
  { readonly brand: unique symbol }
>()("OrganizationFormNotFound", {}) {}

/** The origin of the success URL is not one of the form's allowed origins. */
export class SuccessOriginNotListed extends Schema.TaggedError<
  SuccessOriginNotListed,
  { readonly brand: unique symbol }
>()("SuccessOriginNotListed", {}) {}

export interface OrganizationScope {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
}

type Managed = typeof ManagedForm.Type;
type Failure = OrganizationFormNotFound | StorageUnavailable;

/** The forms of the account's organizations. No operation changes a form's public ID. */
export class Forms extends Context.Service<
  Forms,
  {
    /** Add an active form with a new public ID to an organization. */
    readonly create: (
      organization: OrganizationScope,
      input: typeof CreateForm.Type,
    ) => Effect.Effect<Managed, Failure>;
    /** Rename the form, change its emoji or its business context, or several of them. */
    readonly update: (
      form: FormScope,
      changes: typeof UpdateForm.Type,
    ) => Effect.Effect<Managed, Failure>;
    /** A suspended form refuses submissions until it is active again. */
    readonly setStatus: (form: FormScope, status: FormStatus) => Effect.Effect<Managed, Failure>;
    /** Set the URL that an HTML form post is redirected to once accepted. */
    readonly setSuccessUrl: (
      form: FormScope,
      url: SuccessUrl,
    ) => Effect.Effect<Managed, Failure | SuccessOriginNotListed>;
    readonly clearSuccessUrl: (form: FormScope) => Effect.Effect<Managed, Failure>;
    /**
     * Name the form's honeypot field. Intake removes the field when it is empty
     * and quarantines the submission when it has a value.
     */
    readonly setHoneypotField: (
      form: FormScope,
      field: typeof HoneypotField.Type,
    ) => Effect.Effect<Managed, Failure>;
    readonly clearHoneypotField: (form: FormScope) => Effect.Effect<Managed, Failure>;
    /**
     * Encrypt and store both Turnstile keys once Siteverify recognizes the
     * secret key. Nothing changes when it refuses the key or cannot answer.
     */
    readonly setTurnstile: (
      form: FormScope,
      settings: typeof SetTurnstile.Type,
    ) => Effect.Effect<
      Managed,
      Failure | SecretsKeyMissing | TurnstileSecretRefused | TurnstileUnavailable
    >;
    readonly clearTurnstile: (form: FormScope) => Effect.Effect<Managed, Failure>;
    /**
     * Decrypt the stored Turnstile secret key and ask Siteverify whether it still
     * knows it. A form without Turnstile fails like another account's form.
     */
    readonly checkTurnstile: (form: FormScope) => Effect.Effect<TurnstileKeyState, Failure>;
  }
>()("rondyr/worker/ports/forms") {}
