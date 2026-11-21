import { Context, Effect, Schema } from "effect";

import type { ManagedForm } from "../domain/forms/form.ts";
import type {
  OrganizationDomain,
  OrganizationDomainList,
} from "../domain/organizations/organization-domain.ts";
import type { InboxOrganizationWithForms, SetupInbox } from "../domain/submissions/inbox-setup.ts";
import type { InboxOrganization } from "../domain/submissions/inbox.ts";
import type { InboxUnavailable } from "../domain/submissions/submission.rejection.ts";
import type { OrganizationId, UserId } from "../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

export class OrganizationDomainNotFound extends Schema.TaggedError<
  OrganizationDomainNotFound,
  { readonly brand: unique symbol }
>()("OrganizationDomainNotFound", {}) {}

export class OrganizationDomainLimit extends Schema.TaggedError<
  OrganizationDomainLimit,
  { readonly brand: unique symbol }
>()("OrganizationDomainLimit", {}) {}

export interface OrganizationScope {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
}

type DomainStorageError = OrganizationDomainNotFound | StorageUnavailable;

export class OrganizationDirectory extends Context.Service<
  OrganizationDirectory,
  {
    /** The organizations the account is a member of. */
    readonly organizationsFor: (
      userId: typeof UserId.Type,
    ) => Effect.Effect<ReadonlyArray<typeof InboxOrganization.Type>, InboxUnavailable>;
    /** The forms of an organization, or none when the account is not a member. */
    readonly formsOf: (
      userId: typeof UserId.Type,
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<typeof ManagedForm.Type>, InboxUnavailable>;
    /** Read one organization and its forms after an API token has been verified. */
    readonly inboxFor: (
      organizationId: OrganizationId,
    ) => Effect.Effect<typeof InboxOrganizationWithForms.Type | null, InboxUnavailable>;
    /** Create an organization, its first form, and the account's membership. */
    readonly create: (
      userId: typeof UserId.Type,
      input: typeof SetupInbox.Type,
    ) => Effect.Effect<void, InboxUnavailable>;
    readonly listDomains: (
      scope: OrganizationScope,
    ) => Effect.Effect<OrganizationDomainList, DomainStorageError>;
    /** True if a new row was added, false if the domain was already declared. */
    readonly addDomain: (
      scope: OrganizationScope,
      domain: OrganizationDomain,
    ) => Effect.Effect<boolean, DomainStorageError | OrganizationDomainLimit>;
    readonly removeDomain: (
      scope: OrganizationScope,
      domain: OrganizationDomain,
    ) => Effect.Effect<void, DomainStorageError>;
  }
>()("rondyr/ports/organization-directory/OrganizationDirectory") {}
