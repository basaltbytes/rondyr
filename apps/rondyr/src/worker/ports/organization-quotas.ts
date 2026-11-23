import { Context, Effect, Schema } from "effect";

import type {
  ClassificationReservation,
  DailyQuotas,
  DailyUsage,
} from "../../domain/organizations/organization-quotas.ts";
import type { OrganizationId } from "../../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "./organization-directory.ts";
import type { StorageUnavailable } from "./storage.ts";

export class OrganizationQuotasNotFound extends Schema.TaggedError<
  OrganizationQuotasNotFound,
  { readonly brand: unique symbol }
>()("OrganizationQuotasNotFound", {}) {}

type Failure = OrganizationQuotasNotFound | StorageUnavailable;

export class OrganizationQuotas extends Context.Service<
  OrganizationQuotas,
  {
    readonly usage: (scope: OrganizationScope) => Effect.Effect<typeof DailyUsage.Type, Failure>;
    readonly save: (
      scope: OrganizationScope,
      limits: DailyQuotas,
    ) => Effect.Effect<typeof DailyUsage.Type, Failure>;
    /**
     * Count one more classification for the organization's current UTC day if
     * the day's count is under its daily limit, in one D1 write. A missing
     * organization has no room either.
     */
    readonly reserveClassification: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ClassificationReservation, StorageUnavailable>;
    /**
     * Give back a classification reserved for a request that was then refused,
     * in one D1 write. It touches only the counter of the current UTC day and
     * never takes it below zero.
     */
    readonly releaseClassification: (
      organizationId: OrganizationId,
    ) => Effect.Effect<void, StorageUnavailable>;
  }
>()("rondyr/worker/ports/organization-quotas/OrganizationQuotas") {}
