import { Context, Effect, Schema } from "effect";

import type {
  OrganizationClassificationPolicy,
  OrganizationClassificationSettings,
} from "../../domain/organizations/organization-classification-policy.ts";
import type { ResolvedClassificationPolicy } from "../../domain/submissions/classification-policy.ts";
import type { OrganizationId } from "../../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

export class ClassificationPolicyNotFound extends Schema.TaggedError<
  ClassificationPolicyNotFound,
  { readonly brand: unique symbol }
>()("ClassificationPolicyNotFound", {}) {}

/**
 * The stage names an unknown classifier, or the organization's stored
 * policy does not decode. Reading the policy again gives the same result.
 */
export class ClassificationPolicyUnreadable extends Schema.TaggedError<
  ClassificationPolicyUnreadable,
  { readonly brand: unique symbol }
>()("ClassificationPolicyUnreadable", {}) {}

type ScopedError = ClassificationPolicyNotFound | StorageUnavailable;

export class ClassificationPolicies extends Context.Service<
  ClassificationPolicies,
  {
    readonly resolve: (
      organizationId: OrganizationId,
    ) => Effect.Effect<
      typeof ResolvedClassificationPolicy.Type,
      StorageUnavailable | ClassificationPolicyUnreadable
    >;
    readonly settings: (
      scope: OrganizationScope,
    ) => Effect.Effect<
      typeof OrganizationClassificationSettings.Type,
      ScopedError | ClassificationPolicyUnreadable
    >;
    readonly save: (
      scope: OrganizationScope,
      override: OrganizationClassificationPolicy | null,
    ) => Effect.Effect<void, ScopedError>;
  }
>()("rondyr/worker/ports/classification-policies/ClassificationPolicies") {}
