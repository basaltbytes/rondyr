import { Context, Effect, Schema } from "effect";

import type {
  OrganizationClassificationPolicy,
  OrganizationClassificationSettings,
} from "../domain/organizations/organization-classification-policy.ts";
import type { ResolvedClassificationPolicy } from "../domain/submissions/classification-policy.ts";
import type { OrganizationId } from "../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

export class ClassificationPolicyNotFound extends Schema.TaggedError<
  ClassificationPolicyNotFound,
  { readonly brand: unique symbol }
>()("ClassificationPolicyNotFound", {}) {}

type ScopedError = ClassificationPolicyNotFound | StorageUnavailable;

export class ClassificationPolicies extends Context.Service<
  ClassificationPolicies,
  {
    readonly resolve: (
      organizationId: OrganizationId,
    ) => Effect.Effect<typeof ResolvedClassificationPolicy.Type, StorageUnavailable>;
    readonly settings: (
      scope: OrganizationScope,
    ) => Effect.Effect<typeof OrganizationClassificationSettings.Type, ScopedError>;
    readonly save: (
      scope: OrganizationScope,
      override: OrganizationClassificationPolicy | null,
    ) => Effect.Effect<void, ScopedError>;
  }
>()("rondyr/ports/classification-policies/ClassificationPolicies") {}
