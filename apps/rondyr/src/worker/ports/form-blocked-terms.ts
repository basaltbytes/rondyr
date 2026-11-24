import { Context, Effect, Schema } from "effect";

import type { BlockedTerm, FormBlockedTerm } from "../../domain/forms/blocked-term.ts";
import type { FormScope } from "./notification-targets.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

/** The form or organization is not accessible to the account, or the term is not on its list. */
export class FormBlockedTermNotFound extends Schema.TaggedError<
  FormBlockedTermNotFound,
  { readonly brand: unique symbol }
>()("FormBlockedTermNotFound", {}) {}

/** The form or organization already has the maximum number of blocked terms. */
export class FormBlockedTermLimit extends Schema.TaggedError<
  FormBlockedTermLimit,
  { readonly brand: unique symbol }
>()("FormBlockedTermLimit", {}) {}

export interface AddedBlockedTerm {
  readonly term: typeof FormBlockedTerm.Type;
  /** False when the term was already on the list. */
  readonly created: boolean;
}

/** Words, phrases, domains and addresses that quarantine submissions at intake. */
export class FormBlockedTerms extends Context.Service<
  FormBlockedTerms,
  {
    readonly list: (
      form: FormScope,
    ) => Effect.Effect<
      ReadonlyArray<typeof FormBlockedTerm.Type>,
      FormBlockedTermNotFound | StorageUnavailable
    >;
    /** Add a normalized term to a form. Adding a term already on the list changes nothing. */
    readonly add: (
      form: FormScope,
      term: BlockedTerm,
    ) => Effect.Effect<
      AddedBlockedTerm,
      FormBlockedTermNotFound | FormBlockedTermLimit | StorageUnavailable
    >;
    /** Remove a normalized term from a form. */
    readonly remove: (
      form: FormScope,
      term: BlockedTerm,
    ) => Effect.Effect<void, FormBlockedTermNotFound | StorageUnavailable>;
    readonly listForOrganization: (
      organization: OrganizationScope,
    ) => Effect.Effect<
      ReadonlyArray<typeof FormBlockedTerm.Type>,
      FormBlockedTermNotFound | StorageUnavailable
    >;
    /** Add a normalized term to an organization. Adding a term already on the list changes nothing. */
    readonly addForOrganization: (
      organization: OrganizationScope,
      term: BlockedTerm,
    ) => Effect.Effect<
      AddedBlockedTerm,
      FormBlockedTermNotFound | FormBlockedTermLimit | StorageUnavailable
    >;
    /** Remove a normalized term from an organization. */
    readonly removeForOrganization: (
      organization: OrganizationScope,
      term: BlockedTerm,
    ) => Effect.Effect<void, FormBlockedTermNotFound | StorageUnavailable>;
  }
>()("rondyr/worker/ports/form-blocked-terms/FormBlockedTerms") {}
