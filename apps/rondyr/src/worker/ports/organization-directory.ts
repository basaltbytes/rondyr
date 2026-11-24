import { Context, Effect, Schema } from "effect";

import type { ManagedForm } from "../../domain/forms/form.ts";
import type { MemberRole } from "../../domain/organizations/member-role.ts";
import type {
  OrganizationDomain,
  OrganizationDomainList,
} from "../../domain/organizations/organization-domain.ts";
import type {
  InboxOrganizationWithForms,
  SetupInbox,
} from "../../domain/submissions/inbox-setup.ts";
import type { InboxOrganization as Organization } from "../../domain/submissions/inbox.ts";
import type { InboxUnavailable } from "../../domain/submissions/submission.rejection.ts";
import type { OrganizationId, UserId } from "../../domain/submissions/submission.id.ts";
import type { StorageUnavailable } from "./storage.ts";

export class OrganizationDomainNotFound extends Schema.TaggedError<
  OrganizationDomainNotFound,
  { readonly brand: unique symbol }
>()("OrganizationDomainNotFound", {}) {}

export class OrganizationDomainLimit extends Schema.TaggedError<
  OrganizationDomainLimit,
  { readonly brand: unique symbol }
>()("OrganizationDomainLimit", {}) {}

export class OrganizationCreationDenied extends Schema.TaggedError<
  OrganizationCreationDenied,
  { readonly brand: unique symbol }
>()("OrganizationCreationDenied", {}) {}

type InboxOrganization = typeof Organization.Type;

export interface OrganizationMembership extends InboxOrganization {
  readonly role: MemberRole;
}

export interface OrganizationScope {
  readonly userId: typeof UserId.Type;
  readonly organizationId: OrganizationId;
}

type DomainStorageError = OrganizationDomainNotFound | StorageUnavailable;

export class OrganizationDirectory extends Context.Service<
  OrganizationDirectory,
  {
    /** The organizations the account is a member of, with its role in each. */
    readonly organizationsFor: (
      userId: typeof UserId.Type,
    ) => Effect.Effect<ReadonlyArray<OrganizationMembership>, InboxUnavailable>;
    /** The account's role in the organization, or null when it is not a member. */
    readonly roleOf: (
      scope: OrganizationScope,
    ) => Effect.Effect<MemberRole | null, StorageUnavailable>;
    /** The forms of an organization, or none when the account is not a member. */
    readonly formsOf: (
      userId: typeof UserId.Type,
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<typeof ManagedForm.Type>, InboxUnavailable>;
    /** Read one organization and its forms after an API token has been verified. */
    readonly inboxFor: (
      organizationId: OrganizationId,
    ) => Effect.Effect<
      Omit<typeof InboxOrganizationWithForms.Type, "role"> | null,
      InboxUnavailable
    >;
    /** Create an organization, its first form, and the account's membership as its admin. */
    readonly create: (
      userId: typeof UserId.Type,
      input: typeof SetupInbox.Type,
    ) => Effect.Effect<void, InboxUnavailable | OrganizationCreationDenied>;
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
>()("rondyr/worker/ports/organization-directory/OrganizationDirectory") {}
